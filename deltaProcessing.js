import * as rst from 'rdf-string-ttl';
import * as sjp from 'sparqljson-parse';
import * as mas from '@lblod/mu-auth-sudo';
import * as env from './env';
import * as pbu from './parse-bindings-utils';
import * as N3 from 'n3';
const { namedNode } = N3.DataFactory;

export async function processDelta(changesets, sessionId) {
  // Filter all subjects (just all subjects, filter later which ones needed)
  const allSubjects = getAllUniqueSubjects(changesets);

  // Query all those subjects to see which ones are a Submission, ...
  const wantedSubjects = await getAllWantedSubjects(allSubjects);

  // Get all the data for those subjects that can be found in the vendors graph
  const dataStore = await getAllDataForSubjects(wantedSubjects, sessionId);

  // Make shallow copy of the starting data store
  const originalDataStore = new N3.Store();
  dataStore.forEach((q) => originalDataStore.addQuad(q));

  // "Execute" the changesets as if they where queries on the internal store
  const resultDataStore = await executeChangesets(dataStore, changesets);

  // Make comparisons to the original data to only get updated values
  const { toRemoveStore, toInsertStore } = await compareStores(
    originalDataStore,
    resultDataStore
  );

  // Perform updates on the triplestore
  await updateData(toRemoveStore, toInsertStore, sessionId);
}

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

async function getAllDataForSubjects(subjects, sessionId) {
  //TODO construct and execute query to get all the '?s ?p ?o' for every
  //subject. Construct a store for that data.
  return new N3.Store();
}

async function executeChangesets(store, changesets) {
  //TODO take one changeset at a time. Take the deletes and remove those
  //triples from the store. Then take the inserts and insert them as quads in
  //the store. Continue with the next changeset.
}

async function compareStores(originalStore, resultStore) {
  //TODO remove identical triples between stores from both stores. The original
  //store will become the toRemove data and the result store will become the
  //toInsert data.
//TODO make 1 query DELETE {} INSERT {} WHERE {} for better transactional
//control. If this where done with multiple queries, we need to be able to undo
//them when further queries fail. Doing this in one query will fail everything
//or succeed everything at once.
//TODO if query size becomes too large, split updates per subject.
async function updateData(deleteColl, insertColl, sessionId) {
  if (deleteColl.size < 1 && insertColl.size < 1) return;
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
      GRAPH ?g {
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
      GRAPH ?g {
        ${insertTriples}
      }
    }`;
  }

  const updateQuery = `
    ${env.SPARQL_PREFIXES}
    ${deletePart}
    ${insertPart}
    WHERE {
      ${rst.termToString(sessionId)}
        muAccount:canActOnBehalfOf/mu:uuid ?session_group ;
        muAccount:account/mu:uuid ?vendor_id .
      BIND (
        URI(
          CONCAT(
            "http://mu.semte.ch/graphs/vendors/",
            ?vendor_id, "/", ?session_group))
        AS ?g )
    }`;
  await mas.updateSudo(updateQuery);
}

export async function updateDataInTestGraph(deleteColl, insertColl) {
  const deleteWriter = new N3.Writer({ format: 'text/turtle' });
  const insertWriter = new N3.Writer({ format: 'text/turtle' });
  // Deliberate copy without graph, to make formatting data correct for
  // inserting inside SPARQL query.
  deleteColl.forEach((q) =>
    deleteWriter.addQuad(q.subject, q.predicate, q.object)
  );
  insertColl.forEach((q) =>
    insertWriter.addQuad(q.subject, q.predicate, q.object)
  );
  const deleteTriples = await new Promise((resolve, reject) => {
    deleteWriter.end((err, result) => {
      if (err) reject(err);
      resolve(result);
    });
  });
  const insertTriples = await new Promise((resolve, reject) => {
    insertWriter.end((err, result) => {
      if (err) reject(err);
      resolve(result);
    });
  });
  const deletePart =
    deleteTriples.length > 0
      ? `DELETE {
          GRAPH <http://mu.semte.ch/graphs/vendorsTest> {
            ${deleteTriples}
          }
        }`
      : '';
  const insertPart =
    insertTriples.length > 0
      ? `INSERT {
          GRAPH <http://mu.semte.ch/graphs/vendorsTest> {
            ${insertTriples}
          }
        }`
      : '';
  const updateQuery = `
    ${env.SPARQL_PREFIXES}
    ${deletePart}
    ${insertPart}
    WHERE {
    }`;
  await mas.updateSudo(updateQuery);
}
