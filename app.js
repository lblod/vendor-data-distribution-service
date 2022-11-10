import { app } from 'mu';
import bodyParser from 'body-parser';
import { v4 as uuid } from 'uuid';
import { NAMESPACES as ns } from './env';
import * as del from './deltaProcessing';
import * as env from './env';
import * as pbu from './parse-bindings-utils';
import * as N3 from 'n3';
const { namedNode, literal, blankNode } = N3.DataFactory;
import * as deltaData from './DeltaTestData.js';

app.use(
  bodyParser.json({
    type: function (req) {
      return /^application\/json/.test(req.get('Content-Type'));
    },
  })
);

app.post('/delta', async function (req, res, next) {
  // We can already send a 200 back. The delta-notifier does not care about the
  // result, as long as the request is closed.
  res.status(200).end();

  try {
    const changesets = req.body;
    const sessionId = req.get('mu-session-id');
    if (!sessionId) throw new Error('No mu-session-id header is supplied');
    await del.processDelta(changesets, namedNode(sessionId));
  } catch (err) {
    next(err);
  }
});

/*
 * This is a test route. Because of the lack of support for test frameworks
 * (because of babel config and the mu package that can not be imported outside
 * of the mu-javascript template), we have to test this service with an
 * internal test route.
 * TODO make sure this test route is not accessible in production.
 */
app.get('/test', async function (req, res, next) {
  res.status(200).end();
  //for (const changeset of deltaData.changesets)
  //  await del.processDelta(changeset);
  try {
    const sessionId = req.get('mu-session-id');
    if (!sessionId) throw new Error('No mu-session-id header is supplied');
    for (const changesetGroup of deltaData.changesets) {
      for (const changeset of changesetGroup) {
        const deletes = changeset.deletes.map(pbu.parseSparqlJsonBindingQuad);
        const inserts = changeset.inserts.map(pbu.parseSparqlJsonBindingQuad);
        await del.updateDataInTestGraph(deletes, inserts, namedNode(sessionId));
      }
      await del.processDelta(changesetGroup, namedNode(sessionId));
    }
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
  console.error(err);
  const errorStore = errorToStore(err);
  await writeError(errorStore);
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
  const error = blankNode(uuid());
  store.addQuad(error, ns.rdf`type`, ns.oslc`Error`);
  store.addQuad(error, ns.mu`uuid`, literal(uuid()));
  store.addQuad(error, ns.oslc`message`, literal(errorObject.message));
  return store;
}

async function writeError(errorStore) {
  //TODO implement
}
