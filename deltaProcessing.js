import * as rst from 'rdf-string-ttl';
import * as sjp from 'sparqljson-parse';
import * as mas from '@lblod/mu-auth-sudo';
import * as env from './env';
import * as pbu from './parse-bindings-utils';
import * as N3 from 'n3';
const { namedNode } = N3.DataFactory;

/*
 * Takes delta messages, filters subjects, fetches already known data for those
 * subjects, replays delta messages, calculates differences, and only inserts
 * the changed data.
 *
 * @public
 * @async
 * @function
 * @param {Array(Object)} changesets - This array contains JavaScript object is
 * are the regular delta message format from the delta-notifier.
 * @returns {undefined} Nothing
 */
export async function processDelta(changesets) {
  // Filter all subjects (just all subjects, filter later which ones needed)
  const allSubjects = getAllUniqueSubjects(changesets);

  // Query all those subjects to see which are intersting according to a
  // configuration.
  const wantedSubjects = await getAllWantedSubjects(allSubjects);

  if (wantedSubjects.length < 1) return;
  const vendorInfo = await getVendorInfoFromSubmission(wantedSubjects[0]);

  // Get all the data for those subjects that can be found in the vendors graph
  const dataStore = await getAllDataForSubjects(wantedSubjects, vendorInfo);

  // Make shallow copy of the starting data store for making comparisons
  const originalDataStore = new N3.Store();
  dataStore.forEach((q) => originalDataStore.addQuad(q));

  // Create a subset of changesets where only the wanted subjects are affected
  const effectiveChangesets = getWantedChangesets(changesets, wantedSubjects);

  // "Execute" the changesets as if they where queries on the internal store
  const resultDataStore = await executeChangesets(
    dataStore,
    effectiveChangesets
  );

  // Make comparisons to the original data to only get updated values
  const { toRemoveStore, toInsertStore } = compareStores(
    originalDataStore,
    resultDataStore
  );

  // Perform updates on the triplestore
  await updateData(toRemoveStore, toInsertStore, vendorInfo);
}

/*
 * Gather distinct subjects from all the changes in the changesets.
 *
 * @function
 * @param {Array(Object)} changesets - This array contains JavaScript objects
 * that are in the regular delta message format from the delta-notifier.
 * @returns {Array(NamedNode)} An array with RDF terms for unique subjects.
 */
// Returns RDF terms per subject
function getAllUniqueSubjects(changesets) {
  const allSubjects = changesets
    .map((changeset) => {
      return changeset.inserts.concat(changeset.deletes);
    })
    .flat()
    .map((triple) => {
      return triple.subject.value;
    });
  const subjectStringSet = new Set(allSubjects);
  return [...subjectStringSet].map(namedNode);
}

/*
 * Fetch types (rdf:type) for the subjects and filter them by the
 * configuration.
 *
 * @async
 * @function
 * @param {Array(NamedNode)} subjects - An array with subjects.
 * @returns {Array(NamedNode)} Same as input parameter, but filtered.
 */
async function getAllWantedSubjects(subjects) {
  const response = await mas.querySudo(`
    PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>

    SELECT DISTINCT ?subject ?type WHERE {
      ?subject rdf:type ?type .
      VALUES ?subject {
        ${subjects.map(rst.termToString).join(' ')}
      }
    }
  `);
  const parser = new sjp.SparqlJsonParser();
  const parsedResults = parser.parseJsonResults(response);

  const wantedSubjects = [];
  for (const result of parsedResults)
    if (env.INTERESTING_SUBJECT_TYPES.includes(result.type.value))
      wantedSubjects.push(result.subject);
  return wantedSubjects;
}

/*
 * Get an object with information about the vendor that published a set of
 * data. In this case, starting from a submission.
 *
 * @async
 * @function
 * @param {NamedNode} submission - Represents the URI of the submission that is
 * being reported by the vendor we want the information about.
 * @returns {Object} An object with keys `vendor` and `organisation`, each
 * containing a new object with keys `id` and `uri` containing the mu:uuid and
 * the URI respectively.
 */
//NOTE we might need to be able to get vendor info from different types of
//subjects in the future.
async function getVendorInfoFromSubmission(submission) {
  const response = await mas.querySudo(`
    ${env.SPARQL_PREFIXES}
    SELECT ?vendor ?vendorId ?organisation ?organisationId WHERE {
      ${rst.termToString(submission)}
        pav:createdBy ?organisation;
        pav:providedBy ?vendor .
      ?vendor
        muAccount:canActOnBehalfOf ?organisation ;
        mu:uuid ?vendorId .
      ?organisation
        mu:uuid ?organisationId .
    }
  `);
  const sparqlJsonParser = new sjp.SparqlJsonParser();
  const parsedResults = sparqlJsonParser.parseJsonResults(response);

  return {
    vendor: {
      id: parsedResults[0]?.vendorId.value,
      uri: parsedResults[0]?.vendor.value,
    },
    organisation: {
      id: parsedResults[0]?.organisationId.value,
      uri: parsedResults[0]?.organisation.value,
    },
  };
}

/*
 * Fetch all known data for the given subjects.
 *
 * @async
 * @function
 * @param {Array(NamedNode)} subjects - Subjects where all the data needs to be
 * fetched from.
 * @param {Object} vendorInfo - A JavaScript object with stucture `{ vendor: {
 * id, uri }, organisation: { id, uri } }` containing the information about the
 * vendor that was responsible for reporting this amount of information.
 * @returns {N3.Store} Store containing all the known data.
 */
async function getAllDataForSubjects(subjects, vendorInfo) {
  if (!subjects || subjects.length === 0) return new N3.Store();
  const vendorGraph = namedNode(
    `http://mu.semte.ch/graphs/vendors/${vendorInfo.vendor.id}/${vendorInfo.organisation.id}`
  );
  const subjectsSparql = subjects.map(rst.termToString).join(' ');
  const response = await mas.querySudo(`
    ${env.SPARQL_PREFIXES}
    CONSTRUCT {
      ?s ?p ?o .
    } WHERE {
      GRAPH ${rst.termToString(vendorGraph)} {
        ?s ?p ?o .
        VALUES ?s {
          ${subjectsSparql}
        }
      }
    }
  `);
  const sparqlJsonParser = new sjp.SparqlJsonParser();
  const parsedResults = sparqlJsonParser.parseJsonResults(response);
  const store = new N3.Store();
  // Explicitly not copying the graph
  parsedResults.forEach((binding) =>
    store.addQuad(binding.s, binding.p, binding.o)
  );
  return store;
}

/*
 * Filter delta messages for the interesting subjects.
 *
 * @function
 * @param {Array(Object)} changesets - This array contains JavaScript objects
 * that are in the regular delta message format from the delta-notifier.
 * @param {Array(NamedNode)} wantedSubjects - Contains the unique collection of
 * subjects.
 * @returns {Array(Objects)} A new set of delta messages, but filtered.
 */
function getWantedChangesets(changesets, wantedSubjects) {
  return changesets
    .map((changeset) => {
      return {
        inserts: changeset.inserts.filter((ins) => {
          return wantedSubjects.find((ws) => ws.value === ins.subject.value);
        }),
        deletes: changeset.deletes.filter((del) => {
          return wantedSubjects.find((ws) => ws.value === del.subject.value);
        }),
      };
    })
    .filter(
      (changeset) =>
        (changeset.inserts.length > 0) | (changeset.deletes.length > 0)
    );
}

/*
 * Replay delta messages on an internal data store.
 *
 * @async
 * @function
 * @param {N3.Store} store - Initial data store where the changes can be
 * replayed on.
 * @param {Array(Object)} changesets - This array contains JavaScript objects
 * that are in the regular delta message format from the delta-notifier.
 * @returns {N3.Store} The store from the input parameter. A store is not
 * functionally updated, so the original store is destructively changed.
 */
async function executeChangesets(store, changesets) {
  for (const changeset of changesets) {
    // Process deletes
    store.removeQuads(changeset.deletes.map(pbu.parseSparqlJsonBindingQuad));
    // Process inserts
    store.addQuads(changeset.inserts.map(pbu.parseSparqlJsonBindingQuad));
  }
  return store;
}

/*
 * Compare two stores. Identical triples are **destructively** removed from
 * both stores. The result is the original store with the triples that are
 * removed or updated, and the result store with only triples that are inserted
 * or updated.
 *
 * @function
 * @param {N3.Store} originalStore - The store with initial, already known
 * data.
 * @param {N3.Store} resultStore - The store that has been modified from the
 * original store.
 * @returns {{ toRemoveStore: N3.Store, toInsertStore: N3.Store }} An object
 * with two stores, one with data that is removed or updated and one with
 * inserted or updated data.
 */
export function compareStores(originalStore, resultStore) {
  // Make copy of second store, because if we already start removing things, we
  // will never be able to remove all intersecting triples.
  const resultStoreCopy = new N3.Store();
  resultStore.forEach((q) => resultStoreCopy.addQuad(q));

  originalStore.forEach((q) => resultStore.removeQuad(q));
  resultStoreCopy.forEach((q) => originalStore.removeQuad(q));
  return { toRemoveStore: originalStore, toInsertStore: resultStore };
}

/*
 * Takes collections of data and executes one update query on the database in
 * the graph that is specific to the current vendor.
 *
 * @async
 * @function
 * @param {Iterable} deleteColl - An Array, N3.Store or other iterable
 * collection that contains RDF Quads that need to be removed from the
 * database.
 * @param {Iterable} insertColl - An Array, N3.Store or other iterable
 * collection that contains RDF Quads that need to be inserted in the database.
 * @param {Object} vendorInfo - A JavaScript object with stucture `{ vendor: {
 * id, uri }, organisation: { id, uri } }` containing the information about the
 * vendor that was responsible for reporting this amount of information.
 * @returns {undefined} Nothing
 */
//NOTE if query size becomes too large, split updates per subject.
async function updateData(deleteColl, insertColl, vendorInfo) {
  if (deleteColl.size < 1 && insertColl.size < 1) return;
  const vendorGraphSparql = rst.termToString(
    namedNode(
      `http://mu.semte.ch/graphs/vendors/${vendorInfo.vendor.id}/${vendorInfo.organisation.id}`
    )
  );
  let deletePart = '',
    insertPart = '';
  if (deleteColl.size > 0) {
    const deleteWriter = new N3.Writer({ format: 'text/turtle' });
    // Deliberate copy without graph, to make formatting data correct for
    // inserting inside SPARQL query.
    deleteColl.forEach((q) =>
      deleteWriter.addQuad(q.subject, q.predicate, q.object)
    );
    const deleteTriples = await new Promise((resolve, reject) => {
      deleteWriter.end((err, result) => {
        if (err) reject(err);
        resolve(result);
      });
    });
    deletePart = `DELETE {
      GRAPH ${vendorGraphSparql} {
        ${deleteTriples}
      }
    }`;
  }
  if (insertColl.size > 0) {
    const insertWriter = new N3.Writer({ format: 'text/turtle' });
    insertColl.forEach((q) =>
      insertWriter.addQuad(q.subject, q.predicate, q.object)
    );
    const insertTriples = await new Promise((resolve, reject) => {
      insertWriter.end((err, result) => {
        if (err) reject(err);
        resolve(result);
      });
    });
    insertPart = `INSERT {
      GRAPH ${vendorGraphSparql} {
        ${insertTriples}
      }
    }`;
  }

  const updateQuery = `
    ${env.SPARQL_PREFIXES}
    ${deletePart}
    ${insertPart}
    WHERE {}`;
  await mas.updateSudo(updateQuery);
}
