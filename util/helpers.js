import * as N3 from 'n3';
const { namedNode } = N3.DataFactory;

/*
 * Gather distinct subjects from all the changes in the changesets, including
 * the deletes.
 *
 * @public
 * @function
 * @param {Array(Object)} changesets - This array contains JavaScript objects
 * that are in the regular delta message format from the delta-notifier.
 * @returns {Array(NamedNode)} An array with RDF terms for unique subjects.
 */
export function getAllUniqueSubjects(changesets) {
  const allSubjects = changesets
    .map((changeset) => {
      return changeset.inserts.concat(changeset.deletes);
    })
    .flat()
    .map((triple) => {
      return triple.subject.value;
    });
  const subjectStrings = [...new Set(allSubjects)];
  return subjectStrings.map(namedNode);
}

// export function compareStores(originalStore, resultStore) {
//   // Make copy of second store, because if we already start removing things, we
//   // will never be able to remove all intersecting triples.
//   const resultStoreCopy = new N3.Store();
//   resultStore.forEach((q) => resultStoreCopy.addQuad(q));
//
//   originalStore.forEach((q) => resultStore.removeQuad(q));
//   resultStoreCopy.forEach((q) => originalStore.removeQuad(q));
//   return { toRemoveStore: originalStore, toInsertStore: resultStore };
// }

class CompareStoreResult {
  constructor(left, right) {
    this.left = left;
    this.right = right;
  }
}

/*
 * Compare two stores as if we want to calculate what needs to be done to go
 * from the store on the left to end up with the store on the right. Copies are
 * made from both stores, and idential triples are removed from both stores,
 * until two diffs remain: the left store now contains triples that need to be
 * removed from the original left store and the right store contains triples
 * that need to be added to the original **left** store, to end up with the
 * original right store. This also includes updated values.
 *
 * @public
 * @function
 * @param {N3.Store} left - Store with initial data.
 * @param {N3.Store} right - Store that has been modified from the left store.
 * @returns {CompareStoreResult} An instance object with two stores, one with
 * data that is removed or updated (`left`) and one with inserted or updated
 * data (`right`).
 */
export function compareStores(left, right) {
  const leftCopy = new N3.Store();
  const rightCopy = new N3.Store();
  right.forEach((q) => rightCopy.addQuad(q));
  left.forEach((q) => leftCopy.addQuad(q));
  right.forEach((q) => leftCopy.removeQuad(q));
  left.forEach((q) => rightCopy.removeQuad(q));
  return new CompareStoreResult(leftCopy, rightCopy);
}
