import { app } from 'mu';
import bodyParser from 'body-parser';
import { v4 as uuid } from 'uuid';
import { NAMESPACES as ns } from './env';
import { BASES as b } from './env';
import * as del from './deltaProcessing';
import * as test from './test/test';
import * as env from './env';
import * as pbu from './parse-bindings-utils';
import * as mas from '@lblod/mu-auth-sudo';
import * as rst from 'rdf-string-ttl';
import * as N3 from 'n3';
const { namedNode, literal } = N3.DataFactory;
import * as deltaData from './test/DeltaTestData.js';
import * as vi from './test/VendorInfo.js';

///////////////////////////////////////////////////////////////////////////////
// At boot
///////////////////////////////////////////////////////////////////////////////

(function checkConfig() {
  if (/virtuoso/.test(env.SPARQL_ENDPOINT_COPY_OPERATIONS)) {
    console.warn(
      'This service is configured to query Virtuoso directly! Make sure this is what you want.',
    );
  }
})();

///////////////////////////////////////////////////////////////////////////////
// API
///////////////////////////////////////////////////////////////////////////////

app.use(
  bodyParser.json({
    type: function (req) {
      return /^application\/json/.test(req.get('Content-Type'));
    },
  }),
);

app.post('/delta', async function (req, res, next) {
  // We can already send a 200 back. The delta-notifier does not care about the
  // result, as long as the request is closed.
  res.status(200).end();

  try {
    const changesets = req.body;
    const result = await del.processDelta(changesets);
    handleProcessingResult(result);
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
app.get('/test', async function (req, res, next) {
  try {
    await test.clearTestData(vi.vendorInfo);
    for (const changesetGroup of deltaData.changesets) {
      for (const changeset of changesetGroup) {
        const deletes = changeset.deletes.map(pbu.parseSparqlJsonBindingQuad);
        const inserts = changeset.inserts.map(pbu.parseSparqlJsonBindingQuad);
        await test.updateDataInTestGraph(deletes, inserts);
      }
      await del.processDelta(changesetGroup);
    }
    const testSuccess = await test.assertCorrectTestDeltas(vi.vendorInfo);
    if (testSuccess) res.status(201).send({ result: 'Passed' });
    else res.status(201).send({ result: 'FAILED' });
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
  if (env.LOGLEVEL === 'error') console.error(err);
  if (env.WRITE_ERRORS === true) {
    const errorStore = errorToStore(err);
    await writeError(errorStore);
  }
});
/* eslint-enable no-unused-vars */

///////////////////////////////////////////////////////////////////////////////
// Helpers
///////////////////////////////////////////////////////////////////////////////

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
  store.addQuad(error, ns.dct`subject`, literal('Delta Notifier Messages'));
  store.addQuad(
    error,
    ns.dct`created`,
    literal(new Date().toISOString(), ns.xsd`dateTime`),
  );
  store.addQuad(error, ns.dct`creator`, env.CREATOR);
  return store;
}

/*
 * Receives a store with only the triples related to error messages and stores
 * them in the triplestore.
 *
 * @async
 * @function
 * @param {N3.Store} errorStore - Store with only error triples. (All of the
 * contents are stored.)
 * @returns {undefined} Nothing
 */
async function writeError(errorStore) {
  const writer = new N3.Writer();
  errorStore.forEach((q) => writer.addQuad(q));
  const errorTriples = await new Promise((resolve, reject) => {
    writer.end((err, res) => {
      if (err) reject(err);
      resolve(res);
    });
  });
  await mas.updateSudo(`
    INSERT DATA {
      GRAPH ${rst.termToString(namedNode(env.ERROR_GRAPH))} {
        ${errorTriples}
      }
    }
  `);
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
    console.log(result.reason);
}
