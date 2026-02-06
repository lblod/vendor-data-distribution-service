import * as N3 from 'n3';
const { namedNode } = N3.DataFactory;

/*
 * Gather distinct subjects from all the changes in the changesets.
 *
 * TODO: check if we need to also include the subjects from DELETES
 *
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
