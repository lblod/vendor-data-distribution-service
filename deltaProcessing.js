import * as N3 from 'n3';
const { namedNode } = N3.DataFactory;

export async function processDelta(changesets) {
  console.log(JSON.stringify(changesets));
  // Filter all subjects (just all subjects, filter later which ones needed)
  const allSubjects = getAllUniqueSubjects(changesets);

  // Query all those subjects to see which ones are a Submission, ...
  const wantedSubjects = getAllWantedSubjects(allSubjects);

  //TODO remove this logging
  for await (const sub of wantedSubjects) console.log(sub);

  // Get all the data for those subjects
  const dataStore = await getAllDataForSubjects(wantedSubjects);

  // Make shallow copy of the starting data store
  const originalDataStore = new N3.Store([...dataStore]);

  // "Execute" the changesets as if they where queries on the internal store
  const resultDataStore = await executeChangesets(dataStore, changesets);

  // Make comparisons to the original data to only get updated values
  const { toRemoveStore, toInsertStore } = await compareStores(
    originalDataStore,
    resultDataStore
  );

  // Perform updates on the triplestore
  await updateData(toRemoveStore, toInsertStore);
}

// Returns RDF terms per subject
function* getAllUniqueSubjects(changesets) {
  const subjectStringSet = new Set(
    changesets
      .map((changeset) => {
        return changeset.inserts.concat(changeset.deletes);
      })
      .flat()
      .map((triple) => {
        return triple.subject.value;
      })
  );
  for (const value of subjectStringSet) yield namedNode(value);
}

async function* getAllWantedSubjects(subjects) {
  for (const subject of subjects)
    if (await isWantedSubject(subject)) yield subject;
}

async function isWantedSubject(subject) {
  //TODO execute queries per subject, or one query for all to get the rdf:type
  //for all those subjects. Match them to the types in the config to filter.
  return true;
}

async function getAllDataForSubjects(subjects) {
  //TODO construct and execute query to get all the '?s ?p ?o' for every
  //subject. Construct a store for that data.
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
}

async function updateData(removeStore, insertStore) {
  //TODO make 1 query DELETE {} INSERT {} WHERE {} for better transactional
  //control. If this where done with multiple queries, we need to be able to
  //undo them when further queries fail. Doing this in one query will fail
  //everything or succeed everything at once.
  //TODO if query size becomes too large, split updates per subject.
}
