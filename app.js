import { app } from 'mu';
import bodyParser from 'body-parser';
import { v4 as uuid } from 'uuid';
import { NAMESPACES as ns } from './env';
import * as del from './deltaProcessing';
import * as env from './env';
import * as N3 from 'n3';
const { literal, blankNode } = N3.DataFactory;

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
  res.status(200).send().end();

  try {
    const changesets = req.body;
    await del.processDelta(changesets);
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
 * Produces an RDF store with the data to encode an error in the OSLC namespace.
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
