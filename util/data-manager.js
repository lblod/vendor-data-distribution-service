import * as rst from 'rdf-string-ttl';
import * as sjp from 'sparqljson-parse';
import * as mas from '@lblod/mu-auth-sudo';
import * as env from '../env';
import * as N3 from 'n3';
import * as cm from '../util/config-manager';
import { v4 as uuidv4 } from 'uuid';
import { NAMESPACES as ns } from '../env';
const { namedNode, literal } = N3.DataFactory;
const sparqlJsonParser = new sjp.SparqlJsonParser();
const sparqlConnectionHeaders = {
  'mu-call-scope-id': env.MU_SCOPE,
};
const sparqlConnectionOptions = {
  sparqlEndpoint: env.SPARQL_ENDPOINT_COPY_OPERATIONS,
  mayRetry: true,
};

/*
 * Insert in a temp graph the given subjects with a unique identifier. These
 * unique triples will be used to process the subjects. New deltas give new
 * unique identifiers for a subjects and so these subjects will correctly be
 * processed again later.
 *
 * TODO: rewrite with sts
 *
 * @public
 * @async
 * @function
 * @param {Array(NamedNode)} subjects - An array of the subjects that need to
 * be inserted in the temp graph for later processing.
 * @returns {undefined} Nothing
 */
export async function insertSubjectsForLaterProcessing(
  subjects,
  conHeaders = sparqlConnectionHeaders,
  conOptions = sparqlConnectionOptions,
) {
  const subjectsAndUuidTriples = subjects.map((subject) => {
    // TODO: use timestamp instead?
    const uuid = uuidv4();
    return `${rst.termToString(subject)} schema:identifier ${rst.termToString(literal(uuid))} .`;
  });
  const graph = namedNode(env.TEMP_GRAPH);
  return mas.updateSudo(
    `
    PREFIX schema: <http://schema.org/>

    INSERT DATA {
      GRAPH ${rst.termToString(graph)} {
        ${subjectsAndUuidTriples.join('\n')}
      }
    }
  `,
    conHeaders,
    conOptions,
  );
}

/*
 * Get a collection of subjects and their unique processing identifier from the
 * temp graph. Subjects are grouped as much as possible to minimize the amount
 * of times a subject will be processed over time.
 *
 * TODO: Rewrite with sts
 *
 * @public
 * @async
 * @function
 * @returns {N3.Store} A store containing the subjects and their unique
 * processing identifier.
 */
export async function getSubjectsForLaterProcessing() {
  const graph = namedNode(env.TEMP_GRAPH);
  // TODO: use sort by timestamp?
  const response = await mas.querySudo(`
    CONSTRUCT {
      ?s ?p ?o .
    }
    WHERE {
      {
        SELECT DISTINCT ?s {
          GRAPH ${rst.termToString(graph)} {
            ?s ?p ?o .
          }
        }
        ORDER BY ?s
        LIMIT ${env.PROCESSING_INTERVAL_SIZE}
      }
      GRAPH ${rst.termToString(graph)} {
        ?s ?p ?o .
      }
    }
  `);
  const parsedResults = sparqlJsonParser.parseJsonResults(response);
  const store = new N3.Store();
  parsedResults.forEach((parsedResult) => {
    store.addQuad(parsedResult.s, parsedResult.p, parsedResult.o, graph);
  });
  return store;
}

/*
 * Removes from the temp graph the given subjects with their unique identifier.
 * Not just all the triples for that subject, but only the identifiers that
 * have been processed.
 *
 * TODO: rewrite with sts
 *
 * @public
 * @async
 * @function
 * @param {N3.Store} store - Store with the subjects and identifiers, just like
 * the response from `getSubjectsForLaterProcessing`.
 * @returns {undefined} Nothing
 */
export async function removeSubjectsForLaterProcessing(
  store,
  conHeaders = sparqlConnectionHeaders,
  conOptions = sparqlConnectionOptions,
) {
  if (store.size > 0) {
    const triples = [];
    store.forEach((quad) => {
      triples.push(
        `${rst.termToString(quad.subject)} ${rst.termToString(quad.predicate)} ${rst.termToString(quad.object)} .`,
      );
    });
    const graph = namedNode(env.TEMP_GRAPH);
    await mas.updateSudo(
      `
      DELETE DATA {
        GRAPH ${rst.termToString(graph)} {
          ${triples.join('\n')}
        }
      }
    `,
      conHeaders,
      conOptions,
    );
  }
}

class SubjectConfig {
  constructor(subject, config) {
    this.subject = subject;
    this.config = config;
  }
}

/**
 * TODO: document
 */
export async function filterForWantedSubjects(subjects) {
  const wantedSubjects = [];
  const subjectsAndTypes = await getTypesForSubjects(subjects);
  for (const quad of subjectsAndTypes) {
    const configs = cm.forType(quad.object);
    for (const config of configs) {
      const trigger = cm.trigger(config);
      if (trigger) {
        const triggerMatches = await matchTriggerOnSubject(
          quad.subject,
          trigger,
        );
        if (triggerMatches) {
          wantedSubjects.push(new SubjectConfig(quad.subject, config));
        }
      } else {
        wantedSubjects.push(new SubjectConfig(quad.subject, config));
      }
    }
  }
  return wantedSubjects;
}

/*
 * Fetch types (rdf:type) for the subjects from the triplestore, and filter
 * them by configuration. Then execute the trigger pattern from the config and
 * build a list of only the subjects that pass the trigger.
 *
 * @public
 * @async
 * @function
 * @param {Array(NamedNode)} subjects - An array with subjects.
 * @returns {Array(Object)} An array of objects with the keys `subject`, `type`
 * and `config`, where `subject` points to a NamedNode from the input array
 * that is of interest. `type` is the `rdf:type` of that subject, and `config`
 * is the config object that matched with the subject.
 *
 * WARNING:
 *  - The current implementation works for deletes too, but that's
 *    mainly because the vendor-graph is not flushed when this function is
 *    called. So: be cautious when shuffling this function around
 *
 * TODO: deprecate
 */
// export async function filterForWantedSubjectsOld(subjects) {
//   const wantedSubjects = [];
//   if (subjects.length > 0) {
//     const response = await mas.querySudo(`
//       PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
//
//       SELECT DISTINCT ?subject ?type WHERE {
//         VALUES ?subject {
//           ${subjects.map(rst.termToString).join(' ')}
//         }
//         ?subject rdf:type ?type .
//       }
//     `);
//     const parsedResults = sparqlJsonParser.parseJsonResults(response);
//     // const wantedSubjects = [];
//
//     for (const result of parsedResults) {
//       const confs = conf.subjects.filter((s) => s.type === result.type.value);
//       for (const conf of confs) {
//         const triggerResponse = await mas.querySudo(`
//           ASK {
//             VALUES ?subject { ${rst.termToString(result.subject)} }
//             ${conf.trigger}
//           }`);
//         const isTriggering = sparqlJsonParser.parseJsonBoolean(triggerResponse);
//         if (isTriggering)
//           // TODO: use case class
//           wantedSubjects.push({
//             subject: result.subject,
//             type: result.type,
//             config: conf,
//           });
//       }
//     }
//   }
//   return wantedSubjects;
// }

/**
 * TODO: document
 * TODO: use caching
 * TODO: rewrite with sts?
 */
async function getTypesForSubjects(subjects) {
  const response = await mas.querySudo(`
    PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>

    SELECT DISTINCT ?subject ?type WHERE {
      VALUES ?subject {
        ${subjects.map(rst.termToString).join(' ')}
      }
      ?subject rdf:type ?type .
    }
  `);
  const parsedResults = sparqlJsonParser.parseJsonResults(response);
  const store = new N3.Store();
  parsedResults.forEach((result) => {
    store.addQuad(
      namedNode(result.subject.value),
      ns.rdf`type`,
      namedNode(result.type.value),
    );
  });
  return store;
}

/**
 * TODO: document
 */
async function matchTriggerOnSubject(subject, trigger) {
  const triggerResponse = await mas.querySudo(`
    ASK {
      VALUES ?subject { ${rst.termToString(subject)} }
      ${rst.termToString(trigger)}
    }`);
  return sparqlJsonParser.parseJsonBoolean(triggerResponse);
}

/**
 * TODO: document
 */
export async function targetGraphs(subject, config) {
  const targetQueryStr = cm
    .targetGraphQuery(config)
    .value.replace('${subject}', rst.termToString(subject));
  const targetGraphTemplateStr = cm.targetGraphTemplate(config).value;
  const response = await mas.querySudo(targetQueryStr);
  const bindings = response.bindings;
  const parsedResults = sparqlJsonParser.parseJsonResults(response);
  return parsedResults.map((res) => {
    let graph = targetGraphTemplateStr;
    bindings.forEach((binding) => {
      const regex = new RegExp('${' + binding + '}', 'g');
      graph = graph.replace(regex, res[binding].value);
    });
    return namedNode(graph);
  });
}

/*
 * Get an object with information about the vendor that published a set of
 * data. Starting from the subject and its type (rdf:type).
 *
 * @public
 * @async
 * @function
 * @param {NamedNode} subject - Represents the URI of the subject that is being
 * reported by the vendor we want the information about.
 * @param {NamedNode} type - Represents the URI of the type of the subject.
 * @returns {Object} An object with keys `vendor` and `organisation`, each
 * containing a new object with keys `id` and `uri` containing the mu:uuid and
 * the URI respectively. Returns undefined when no config for this subject is
 * found.
 *
 * TODO: deprecate
 */
// export async function getVendorInfoFromSubject(subject, type, config) {
//   if (config.path) {
//     const response = await mas.querySudo(`
//       ${env.SPARQL_PREFIXES}
//       SELECT DISTINCT ?vendor ?vendorId ?organisation ?organisationId WHERE {
//         VALUES ?subject { ${rst.termToString(subject)} }
//         ${config.path}
//         ?vendor
//           muAccount:canActOnBehalfOf ?organisation ;
//           mu:uuid ?vendorId .
//         ?organisation
//           mu:uuid ?organisationId .
//       }
//     `);
//     const parsedResults = sparqlJsonParser.parseJsonResults(response);
//     return parsedResults.map((r) => {
//       return {
//         vendor: {
//           id: r?.vendorId,
//           uri: r?.vendor,
//         },
//         organisation: {
//           id: r?.organisationId,
//           uri: r?.organisation,
//         },
//       };
//     });
//   }
// }

export async function transferDataToTarget(subject, config, graph) {
  // TODO:
  // * get data for subject from the target graph → store
  //    - keep in mind selected properties
  // * get data from non-target graph → store
  //    - keep in mind selected properties
  // * compare stores
  // * delete wrong or unneeded triples
  // * insert new triples

  const properties = cm.properties(config);
  const optionalProperties = cm.optionalProperties(config);
  const targetStore = new N3.Store();
  const nonTargetStore = new N3.Store();

  if (properties === undefined) {
    // All properties
    const targetData = await fetchOptionalProperties(subject, [], graph);
    targetStore.addQuads(targetData);
  } else {
    if (properties?.length > 0) {
      const targetData = await fetchMandatoryProperties(
        subject,
        properties,
        graph,
      );
      targetStore.addQuads(targetData);
    }
    if (optionalProperties.length > 0) {
      const targetData = await fetchOptionalProperties(
        subject,
        optionalProperties,
        graph,
      );
      targetStore.addQuads(targetData);
    }
  }

  if (properties === undefined) {
    // All properties
    const targetData = await fetchOptionalProperties(
      subject,
      [],
      undefined,
      graph,
    );
    nonTargetStore.addQuads(targetData);
  } else {
    if (properties?.length > 0) {
      const targetData = await fetchMandatoryProperties(
        subject,
        properties,
        undefined,
        graph,
      );
      nonTargetStore.addQuads(targetData);
    }
    if (optionalProperties.length > 0) {
      const targetData = await fetchOptionalProperties(
        subject,
        optionalProperties,
        undefined,
        graph,
      );
      nonTargetStore.addQuads(targetData);
    }
  }

  const { inserts, deletes } = compareStores(nonTargetStore, targetStore);

  await deleteStore(deletes);
  await insertStore(inserts, graph);
}

/*
 * Perform the removal of data from the vendor graph, based on the config for
 * that type of subject. This selects data from anywhere to delete from the
 * vendor graph in order not to miss anything.
 *
 * @public
 * @async
 * @function
 * @param {NamedNode} subject - Subject for which data is to be removed.
 * @param {Object} config - Configuration object for that subject. Should
 * contain the `remove` property to be able to construct a DELETE query.
 * @param {NamedNode} graph - Vendor graph to remove the data from.
 * @returns {undefined} Nothing
 *
 * TODO: deprecate
 */
export async function removeDataFromVendorGraph(
  subject,
  config,
  graph,
  conHeaders = sparqlConnectionHeaders,
  conOptions = sparqlConnectionOptions,
) {
  // No filter on graph in the where clause, we need to be able to delete
  // everything
  await mas.updateSudo(
    `
    DELETE {
      GRAPH ${rst.termToString(graph)} {
        ${config.remove.delete}
      }
    }
    WHERE {
      VALUES ?subject { ${rst.termToString(subject)} }
      ${config.remove.where}
    }`,
    conHeaders,
    conOptions,
  );
}

/*
 * Copy data from organisation graphs to the given vendor graph for the given
 * subject.
 *
 * @public
 * @async
 * @function
 * @param {NamedNode} subject - Subject for which data is to be copied.
 * @param {Object} config - Configuration object for that subject. Should
 * contain the `copy` property to be able to construct an INSERT query.
 * @param {NamedNode} graph - Vendor graph to copy data to.
 * @returns {undefined} Nothing
 *
 * TODO: deprecate
 */
export async function copyDataToVendorGraph(
  subject,
  config,
  graph,
  conHeaders = sparqlConnectionHeaders,
  conOptions = sparqlConnectionOptions,
) {
  await mas.updateSudo(
    `
    INSERT {
      GRAPH ${rst.termToString(graph)} {
        ${config.copy.insert}
      }
    }
    WHERE {
      GRAPH ?g {
        VALUES ?subject { ${rst.termToString(subject)} }
        ${config.copy.where}
      }
      FILTER (REGEX(STR(?g), "^http://mu.semte.ch/graphs/organizations/"))
    }`,
    conHeaders,
    conOptions,
  );
}

/*
 * Perform post processing on the subject in the vendor graph. A configuration
 * might contain a query that is to be executed on the subject to translate
 * properties, to add extra derived triples, ... Both INSERT and DELETE
 * patterns are combined into a single query.
 *
 * @public
 * @async
 * @function
 * @param {NamedNode} subject - Subject to perform post processing on.
 * @param {Object} config - Configuration object for that subject. Should
 * contain the `post` property to be able to construct DELETE and INSERT
 * queries.
 * @param {NamedNode} graph - Vendor graph in which to perform the processing.
 * @returns {undefined} Nothing
 *
 * TODO: deprecate
 */
export async function postProcess(
  subject,
  config,
  graph,
  conHeaders = sparqlConnectionHeaders,
  conOptions = sparqlConnectionOptions,
) {
  // No delete and insert → nothing to do
  if (!(config?.post?.delete || config?.post?.insert)) return;
  // No where → invalid post processing config
  if (!config?.post?.where) return;

  const deletePattern = config?.post?.delete
    ? `
    DELETE {
      GRAPH ${rst.termToString(graph)} {
        ${config.post.delete}
      }
    }`
    : '';
  const insertPattern = config?.post?.insert
    ? `
    INSERT {
      GRAPH ${rst.termToString(graph)} {
        ${config.post.insert}
      }
    }`
    : '';

  await mas.updateSudo(
    `
    ${deletePattern}
    ${insertPattern}
    WHERE {
      VALUES ?subject { ${rst.termToString(subject)} }
      GRAPH ${rst.termToString(graph)} {
        ${config.post.where}
      }
    }
    `,
    conHeaders,
    conOptions,
  );
}
