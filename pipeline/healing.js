import * as env from '../env';
import * as dm from '../util/data-manager';
import * as cm from '../util/config-manager';
import * as ss from '../util/sparql-sudo';
import * as rst from 'rdf-string-ttl';
import * as sjp from 'sparqljson-parse';
const sparqlJsonParser = new sjp.SparqlJsonParser();

/**
 * "Heal" target graph data. This means going over the configurations, scanning
 * the triplestore for related subjects, and performing the copies to the
 * target graphs. This is what the normal pipeline does, but now forced onto
 * the whole triplestore. These are costly operations!
 * While processing, it prints messages about its progress.
 *
 * @public
 * @async
 * @function
 * @param {Array(NamedNode)} configs - Optional. List of configs to perform
 * healing on. If none are given, perform healing on all the configurations.
 * @returns {undefined} Nothing.
 */
export async function heal(configs = []) {
  configs = configs?.length > 0 ? configs : cm.classes();

  for (let configCounter = 0; configCounter < configs.length; configCounter++) {
    const config = configs[configCounter];
    console.log(
      `Processing config ${rst.termToString(config)}, which is ${configCounter + 1}/${configs.length} (${Math.round(((configCounter + 1) * 100) / configs.length)}%).`,
    );
    const type = cm.type(config);
    const countResponse = await ss.querySudo(
      `
      SELECT (COUNT(DISTINCT ?subject) AS ?count)
      WHERE {
        ?subject rdf:type ${rst.termToString(type)} .
      }
    `,
      'healing',
    );
    const count = parseInt(
      sparqlJsonParser.parseJsonResults(countResponse)[0]?.count?.value,
    );

    for (let moreSubjects = true, batchCount = 0; moreSubjects; batchCount++) {
      console.log(
        `Processing ${env.BATCH_SIZE * batchCount}-${env.BATCH_SIZE * (batchCount + 1)}/${count} (${Math.round(((batchCount + 1) * env.BATCH_SIZE * 100) / count)}%) subjects for config ${rst.termToString(config)}.`,
      );

      // Query a batch of subjects to process from the current config
      const subjectsResponse = await ss.querySudo(
        `
        SELECT DISTINCT ?subject
        WHERE {
          ?subject rdf:type ${rst.termToString(type)} .
        }
        LIMIT ${env.BATCH_SIZE}
        OFFSET ${env.BATCH_SIZE * batchCount}
      `,
        'healing',
      );
      const subjectsWithConfig = sparqlJsonParser
        .parseJsonResults(subjectsResponse)
        .map((row) => new dm.SubjectConfig(row.subject, config));
      moreSubjects = !(subjectsWithConfig.length < env.BATCH_SIZE);

      // The rest below is more or less a copy from the deltaProcessing pipeline

      // Only process hierarchies for which its trigger is successful
      const triggerHappyHierarchies = [];
      for (const { subject, config } of subjectsWithConfig) {
        const trigger = cm.trigger(config);
        if (trigger) {
          const triggerMatches = await dm.matchTriggerOnSubject(
            subject,
            trigger,
            'healing',
          );
          if (triggerMatches)
            triggerHappyHierarchies.push(new dm.Hierarchy(subject, config));
        } else triggerHappyHierarchies.push(new dm.Hierarchy(subject, config));
      }

      // Target graph for each hierarchy and move parent and children to target
      for (const hierarchy of triggerHappyHierarchies) {
        const { topSubject, topConfig } = hierarchy;
        const targetGraphs = await dm.targetGraphs(
          topSubject,
          topConfig,
          'healing',
        );

        if (!targetGraphs.length) {
          console.log(
            `No target graph found for subject ${rst.termToString(topSubject)}. Skipping.`,
          );
          continue;
        }

        // Get all children in the triplestore for each hierarchy
        hierarchy.children = await dm.hierarchyChildren(hierarchy, 'healing');

        // Copy entire hierarchy to the target graphs
        await dm.transferDataToTargets(
          topSubject,
          topConfig,
          targetGraphs,
          'healing',
        );
        for (const { subject, config } of hierarchy.children)
          await dm.transferDataToTargets(
            subject,
            config,
            targetGraphs,
            'healing',
          );

        // Perform post processing
        for (const graph of targetGraphs) {
          await dm.postProcess(topSubject, topConfig, graph, 'healing');
          for (const { subject, config } of hierarchy.children)
            await dm.postProcess(subject, config, graph, 'healing');
        }
      }
    }
  }
  console.log('All healing done.');
}
