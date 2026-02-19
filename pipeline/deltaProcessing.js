import * as rst from 'rdf-string-ttl';
import * as dm from '../util/data-manager';
import * as cm from '../util/config-manager';

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
  const processResult = await processEventSubjects(subjects);
  //Override the result count, because the processing only counts the
  //interesting subjects
  processResult.count = subjects.length;
  await dm.removeSubjectsForLaterProcessing(subjectStore);
  return processResult;
}

/**
 * For a collection of subjects, inspect using the database what their types
 * are, if there is a config for them and finds the entire hierarchy of related
 * elements. It then finds out what graph the data should be copied to, and
 * perform the data copy to that graph.
 *
 * @async
 * @function
 * @param {Array(NamedNode)} subjects - An array of NamedNodes representing subjects to be processed.
 * @returns {ProcessResult} Instance of ProcessResult to indicate results.
 */
async function processEventSubjects(subjects) {
  let wasIngestSuccesful = false;

  // Find types in the triplestore for all subjects
  const subjectsAndTypes = await dm.getTypesForSubjects(subjects);

  // Match each subject to configs
  const subjectsWithConfig = [];
  subjectsAndTypes.forEach((quad) => {
    for (const config of cm.forType(quad.object))
      subjectsWithConfig.push(new dm.SubjectConfig(quad.subject, config));
  });

  // Subclasses don't matter anymore, we need the top parents of the
  // hierarchies
  const parentsInHierarchy = [];
  for (const subjectWithConfig of subjectsWithConfig) {
    const parent = await dm.hierarchyTop(subjectWithConfig);
    parentsInHierarchy.push(parent);
  }

  // Only process hierarchies for which its trigger is successful
  const triggerHappyHierarchies = [];
  for (const { subject, config } of parentsInHierarchy) {
    const trigger = cm.trigger(config);
    if (trigger) {
      const triggerMatches = await cm.matchTriggerOnSubject(subject, trigger);
      if (triggerMatches)
        triggerHappyHierarchies.push(new dm.Hierarchy(subject, config));
    } else triggerHappyHierarchies.push(new dm.Hierarchy(subject, config));
  }

  // Get all children in the triplestore for each hierarchy
  for (const hierarchy of triggerHappyHierarchies)
    hierarchy.children = await dm.hierarchyChildren(hierarchy);

  // Target graph for each hierarchy and move parent and children to target
  for (const { topSubject, topConfig, children } of triggerHappyHierarchies) {
    const targetGraphs = await dm.targetGraphs(topSubject, topConfig);

    if (!targetGraphs.length) {
      console.log(
        `No target graph found for subject ${rst.termToString(topSubject)}. Skipping.`,
      );
      continue;
    }

    // Copy entire hierarchy to the target graphs
    for (const graph of targetGraphs) {
      await dm.transferDataToTarget(topSubject, topConfig, graph);
      await dm.postProcess(topSubject, topConfig, graph);
      for (const { subject, config } of children) {
        await dm.transferDataToTarget(subject, config, graph);
        await dm.postProcess(subject, config, graph);
      }
    }

    wasIngestSuccesful = true;
  }
  return new ProcessResult(wasIngestSuccesful, triggerHappyHierarchies.length);
}
