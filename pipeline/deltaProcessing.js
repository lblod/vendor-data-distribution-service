import * as rst from 'rdf-string-ttl';
import * as dm from '../util/data-manager';

class ProcessResult {
  constructor(isSuccess, subjectCount, failReason) {
    this.success = isSuccess;
    this.count = subjectCount;
    this.reason = failReason;
  }
}

/**
 * Gets a batch of events from the temp graph and processes related subjects
 * according to the config. When no errors occured, it then removes those
 * events from the temp graph.
 *
 * @public
 * @async
 * @function
 * @returns {ProcessResult} Instance of ProcessResult to indicate results.
 */
export async function processBatch() {
  const subjectStore = await dm.getSubjectsForLaterProcessing();
  const subjects = subjectStore.getSubjects();
  const processResult = await processSubjects(subjects);
  //Override the result count, because the processing only counts the
  //interesting subjects
  processResult.count = subjects.length;
  await dm.removeSubjectsForLaterProcessing(subjectStore);
  return processResult;
}

/**
 * For a collection of subjects, inspect using the database what their types
 * are, if there is a config for them, finds out to what graph the data should
 * be copied, and perform the data copy to that graph.
 * TODO: will add path traversal later, also needs documentation update
 *
 * @async
 * @function
 * @param {Array(NamedNode)} subjects - An array of NamedNodes representing subjects to be processed.
 * @returns {ProcessResult} Instance of ProcessResult to indicate results.
 */
async function processSubjects(subjects) {
  let wasIngestSuccesful = false;

  // Query all those subjects to see which are interesting according to a
  // configuration.
  const wantedSubjects = await dm.filterForWantedSubjects(subjects);

  if (wantedSubjects.length < 1)
    return new ProcessResult(
      true,
      0,
      'No subjects of interest in these changesets.',
    );

  for (const { subject, config } of wantedSubjects) {
    const targetGraphs = await dm.targetGraphs(subject, config);

    if (!targetGraphs.length) {
      console.log(
        `No target graph found for subject ${rst.termToString(subject)}. Skipping.`,
      );
      continue;
    }

    for (const graph of targetGraphs)
      await dm.transferDataToTarget(subject, config, graph);

    wasIngestSuccesful = true;
  }
  return new ProcessResult(wasIngestSuccesful, wantedSubjects.length);
}
