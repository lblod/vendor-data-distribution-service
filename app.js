import { app } from 'mu';
import bodyParser from 'body-parser';
import { v4 as uuid } from 'uuid';
import { NAMESPACES as ns } from './env';
import { BASES as b } from './env';
import * as dm from './util/data-manager';
import * as hel from './util/helpers';
import * as del from './pipeline/deltaProcessing';
import * as hea from './pipeline/healing';
import * as test from './test/test';
import * as env from './env';
import * as sts from './util/storeToTriplestore';
import * as cron from 'node-cron';
import * as N3 from 'n3';
const { namedNode, literal } = N3.DataFactory;
import { Lock } from 'async-await-mutex-lock';

// For locking the batch processing. We don't want more than one batch process
// at a time.
const processingLock = new Lock();
// For locking all operations on timers. Concurrent endpoints might otherwise
// create too many timers.
const timerLock = new Lock();

let runningTimer = undefined;

///////////////////////////////////////////////////////////////////////////////
// At boot
///////////////////////////////////////////////////////////////////////////////

(function checkEnv() {
  if (/virtuoso/.test(env.SPARQL_ENDPOINT_COPY_OPERATIONS)) {
    console.warn(
      'This service is configured to query Virtuoso directly! Make sure this is what you want.',
    );
  }
})();

cron.schedule(env.CLEANUP_CRON, process);

runningTimer = setTimeout(process, 10000);

///////////////////////////////////////////////////////////////////////////////
// API
///////////////////////////////////////////////////////////////////////////////

app.use(
  bodyParser.json({
    type: function (req) {
      return /^application\/json/.test(req.get('Content-Type'));
    },
    limit: '50MB',
  }),
);

app.post('/delta', async function (req, res, next) {
  // We can already send a 200 back. The delta-notifier does not care about the
  // result, as long as the request is closed.
  res.status(200).end();
  try {
    const changesets = req.body;
    const subjects = hel.getAllUniqueSubjects(changesets);
    await dm.insertSubjectsForLaterProcessing(subjects);
    timerLock.acquire();
    if (!runningTimer)
      runningTimer = setTimeout(process, env.PROCESSING_INTERVAL);
  } catch (err) {
    next(err);
  } finally {
    if (timerLock.isAcquired()) timerLock.release();
  }
});

/*
 * This endpoint is meant to manually be able to start the processing of
 * batches from the temporary graph.
 */
app.post('/process', async function (req, res, next) {
  // Send success code back. We will execute the processing later
  res.status(200).send({
    message: 'Processing the temporary graph will start.',
  });
  try {
    await process();
  } catch (err) {
    next(err);
  }
});

/*
 * Process batches from the temporary graph, print results and restart a timer
 * for a new processing round if there were any subjects in the batch.
 */
async function process() {
  processingLock.acquire();
  runningTimer = undefined;
  try {
    const result = await del.processBatch();
    handleProcessingResult(result);
    timerLock.acquire();
    if (result?.count)
      runningTimer = setTimeout(process, env.PROCESSING_INTERVAL);
  } catch (err) {
    await logError(err);
  } finally {
    if (timerLock.isAcquired()) timerLock.release();
    if (processingLock.isAcquired()) processingLock.release();
  }
}

/*
 * These endpoints are used for healing. This will query the database for ALL
 * subjects in the triplestore to see if that data should be inserted in the
 * vendor graph. This effectively replaces the need for migrations and provides
 * a way to add data to the target graph in case of configuration changes, or
 * if something went wrong in the application.
 */
app.post('/heal', async function (req, res, next) {
  // Send success code back. We will execute the healing later.
  res.status(200).send({
    message:
      'Healing will start immediately. Check the logs of this service to track progress.',
  });
  try {
    console.log('Will start healing on the whole configuration.');
    await hea.heal();
  } catch (err) {
    next(err);
  }
});
/**
 * Only heal for a set of configurations.
 */
app.post('/heal/configs', async function (req, res, next) {
  // Send success code back. We will execute the healing later.
  res.status(200).send({
    message:
      'Healing will start immediately. Check the logs of this service to track progress.',
  });
  try {
    const onlyConfigs =
      req.body?.configs?.constructor?.name === 'Array' ? req.body.configs : [];
    console.log(`Will start healing with filter [${onlyConfigs.join(', ')}].`);
    await hea.healConfigs(onlyConfigs);
  } catch (err) {
    next(err);
  }
});
/**
 * Only heal for a set of subjects.
 */
app.post('/heal/subjects', async function (req, res, next) {
  // Send success code back. We will execute the healing later.
  res.status(200).send({
    message:
      'Healing will start immediately. Check the logs of this service to track progress.',
  });
  try {
    const subjects =
      req.body?.subjects?.constructor?.name === 'Array'
        ? req.body.subjects
        : [];
    console.log(`Will start healing on subjects [${subjects.join(', ')}].`);
    await hea.healSubjects(subjects.map(namedNode));
  } catch (err) {
    next(err);
  }
});

/*
 * This is a test route. Because of the lack of support for test frameworks
 * (because of babel config and the mu package that can not be imported outside
 * of the mu-javascript template), we have to test this service with an
 * internal test route.
 * This route is protected to only be accessible during development mode.
 */
app.use('/test', async function (req, res, next) {
  if (/development/.test(env.RUN_MODE)) next();
  else
    res
      .status(401)
      .send(
        'This route has been disabled, because it is for testing purposes only.',
      );
});
/**
 * Insert test data in some organisation graph, insert data about a vendor in
 * another graph, and start a test by sending a delta message to the /delta
 * route above.
 */
app.get('/test/start', async function (req, res, next) {
  try {
    res
      .status(200)
      .send({ result: 'Test data will be inserted and tests will start.' });
    await test.prepareAndStart();
  } catch (err) {
    next(err);
  }
});
/**
 * After waiting on the processing of the above /test/start route, call this
 * endpoint to verify the data in the database.
 */
app.get('/test/assert', async function (req, res, next) {
  try {
    const testSuccess = await test.assert();
    if (testSuccess) res.status(200).send({ result: 'Passed' });
    else res.status(200).send({ result: 'FAILED' });
  } catch (err) {
    next(err);
  }
});
/**
 * Clean up all the test data after performing the tests.
 */
app.get('/test/clean', async function (req, res, next) {
  try {
    res.status(200).send({ result: 'Test data will be cleaned up.' });
    await test.cleanUp();
  } catch (err) {
    next(err);
  }
});

///////////////////////////////////////////////////////////////////////////////
// Error handler
///////////////////////////////////////////////////////////////////////////////

// For some reason the 'next' parameter is unused and eslint notifies us, but
// when removed, Express does not use this middleware anymore.
/* eslint-disable no-unused-vars */
app.use(async (err, req, res, next) => {
  await logError(err);
});
/* eslint-enable no-unused-vars */

///////////////////////////////////////////////////////////////////////////////
// Helpers
///////////////////////////////////////////////////////////////////////////////

async function logError(err) {
  if (env.LOGLEVEL === 'error') console.error(err);
  if (env.WRITE_ERRORS === true) {
    const errorStore = errorToStore(err);
    try {
      await sts.insertData(errorStore, namedNode(env.ERROR_GRAPH));
    } catch (err) {
      console.error(
        'ERROR-CEPTION: Error could not be written to the triplestore: ',
        err,
      );
    }
  }
}

/*
 * Produces an RDF store with the data to encode an error in the OSLC
 * namespace.
 *
 * @function
 * @param {Error} errorObject - Instance of the standard JavaScript Error class
 * or similar object that has a `message` property.
 * @returns {N3.Store} A new Store with the properties to represent the error.
 */
function errorToStore(errorObject) {
  const store = new N3.Store();
  const errorUuid = uuid();
  const error = b.error(errorUuid);
  store.addQuad(error, ns.rdf`type`, ns.oslc`Error`);
  store.addQuad(error, ns.mu`uuid`, literal(errorUuid));
  store.addQuad(error, ns.oslc`message`, literal(errorObject.message));
  store.addQuad(
    error,
    ns.dct`subject`,
    literal('Error with vendor-data-distribution-service'),
  );
  store.addQuad(
    error,
    ns.dct`created`,
    literal(new Date().toISOString(), ns.xsd`dateTime`),
  );
  store.addQuad(error, ns.dct`creator`, env.CREATOR);
  return store;
}

/*
 * The pocessing of delta messages should return an object with a potential
 * information message. This function prints the message when the loglevel
 * requests for that.
 *
 * @function
 * @param {Object} result - A JavaScript object with keys `success` (Boolean)
 * and `reason` (String). When not successful, the reason is printed according
 * to the loglevel.
 * @returns {undefined} Nothing
 */
function handleProcessingResult(result) {
  if (result.success) return;
  if (env.LOGLEVEL == 'error' || env.LOGLEVEL == 'info')
    if (result.reason) console.log(result.reason);
}
