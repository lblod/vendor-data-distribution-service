import * as rst from 'rdf-string-ttl';
import * as sjp from 'sparqljson-parse';
import * as ss from '../util/sparql-sudo';
import * as env from '../env';
import * as N3 from 'n3';
import * as cm from '../util/config-manager';
import * as sts from '../util/storeToTriplestore';
import * as hel from '../util/helpers';
import { v4 as uuidv4 } from 'uuid';
import { NAMESPACES as ns } from '../env';
const { namedNode, literal } = N3.DataFactory;
const sparqlJsonParser = new sjp.SparqlJsonParser();

/*
 * Insert in a temp graph the given subjects with a unique identifier. These
 * unique triples will be used to process the subjects. New deltas give new
 * unique identifiers for a subjects and so these subjects will correctly be
 * processed again later.
 *
 * @public
 * @async
 * @function
 * @param {Array(NamedNode)} subjects - An array of the subjects that need to
 * be inserted in the temp graph for later processing.
 * @returns {undefined} Nothing
 */
export async function insertSubjectsForLaterProcessing(subjects) {
  const store = new N3.Store();
  const graph = namedNode(env.TEMP_GRAPH);
  subjects.forEach((subject) => {
    const uuid = uuidv4();
    store.addQuad(subject, ns.schema`identifier`, literal(uuid), graph);
  });
  return sts.insertData(store);
}

/*
 * Get a collection of subjects and their unique processing identifier from the
 * temp graph. Subjects are grouped as much as possible to minimize the amount
 * of times a subject will be processed over time.
 *
 * @public
 * @async
 * @function
 * @returns {N3.Store} A store containing the subjects and their unique
 * processing identifier.
 */
export async function getSubjectsForLaterProcessing() {
  const graph = namedNode(env.TEMP_GRAPH);
  return sts.getDataFromConstructQuery(
    `
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
  `,
    graph,
  );
}

/*
 * Removes from the temp graph the given subjects with their unique identifier.
 * Not just all the triples for that subject, but only the identifiers that
 * have been processed.
 *
 * @public
 * @async
 * @function
 * @param {N3.Store} store - Store with the subjects and identifiers, just like
 * the response from `getSubjectsForLaterProcessing`.
 * @returns {undefined} Nothing
 */
export async function removeSubjectsForLaterProcessing(store) {
  const graph = namedNode(env.TEMP_GRAPH);
  return sts.deleteData(store, graph);
}

export class SubjectConfig {
  constructor(subject, config) {
    this.subject = subject;
    this.config = config;
  }
}

export class Hierarchy {
  constructor(topSubject, topConfig, children) {
    this.topSubject = topSubject;
    this.topConfig = topConfig;
    this.children = children;
  }
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
 * TODO: deprecate
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

/**
 * For a collection of subjects, find their `rdf:type`. The triplestore is used
 * for this.
 *
 * @public
 * @async
 * @function
 * @param {Array(NamedNode)} subjects - Array of NamedNodes that represent
 * subjects for which the type information is needed.
 * @returns {N3.Store} A store with triples like `<somesubject> rdf:type
 * <sometype> .`
 *
 * TODO: use caching
 */
export async function getTypesForSubjects(subjects) {
  return sts.getDataFromConstructQuery(`
    PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>

    CONSTRUCT {
      ?subject rdf:type ?type .
    }
    WHERE {
      VALUES ?subject {
        ${subjects.map(rst.termToString).join(' ')}
      }
      ?subject rdf:type ?type .
    }
  `);
}

/**
 * Executes a SPARQL trigger pattern on the subjects in the triplestore to see
 * if it matches.
 *
 * @async
 * @function
 * @param {NamedNode} Subject for wich a SPARQL pattern should match.
 * @param {Literal} trigger - An RDFJS Literal with a SPARQL pattern that is
 * inserted in an ASK query with '${subject}' replaced with the given subject.
 * @returns {Boolean} True if the ASK query matches, false otherwise.
 */
async function matchTriggerOnSubject(subject, trigger) {
  const triggerStr = rst.termToString(trigger);
  const substitutedPattern = triggerStr.value.replaceAll(
    '${subject}',
    rst.termToString(subject),
  );
  const triggerResponse = await ss.querySudo(`
    ASK {
      ${substitutedPattern}
    }`);
  return sparqlJsonParser.parseJsonBoolean(triggerResponse);
}

/**
 * Calculates and fetches for a subject its top most element in the hierarchy
 * from the triplestore.
 *
 * @public
 * @async
 * @function
 * @param {SubjectConfig} subjectWithConfig - A subject and its configuration
 * that is part of a hierarchy. (A hierarchy of 1 element is possible too.)
 * @returns {SubjectConfig} The subject and its configuration that are the top
 * elements of a hierarchy.
 */
export async function hierarchyTop(subjectWithConfig) {
  const { subject, config } = subjectWithConfig;
  const { topConfig, path } = cm.pathTopFromConfig(config);
  if (path.length > 0) {
    const pathString = path.map(cm.type).map(rst.termToString).join(' / ');
    const response = await ss.querySudo(`
      SELECT ?top ?leaf
      WHERE {
        BIND (${rst.termToString(subject)} AS ?leaf)
        ?top ${pathString} ?leaf .
      } LIMIT 1
    `);
    const parsedResults = sparqlJsonParser.parseJsonResults(response);
    if (parsedResults.length > 1)
      throw new Error(
        `There should only be one path between a leaf element and their hierarchy top element. Found these top elements: ${parsedResults.map((r) => r.top.value).join(' \n ')}`,
      );
    const top = parsedResults[0].top;
    return new SubjectConfig(top, topConfig);
  }
  return subjectWithConfig;
}

/**
 * Calculates and fetches from the triplestore all child configurations and these child entities.
 *
 * @public
 * @async
 * @function
 * @param {Hierarchy} hierarchy - Instance representing an (usually the top
 * most) element in a hierarchy and its config.
 * @returns {Array(SubjectConfig)} A flat list of all the child entities and
 * their config.
 */
export async function hierarchyChildren(hierarchy) {
  const { topSubject, topConfig } = hierarchy;
  const childrenConfigs = cm.pathsToAllChildren(topConfig);
  const collectedChildren = [];
  for (const { path, config } of childrenConfigs) {
    const pathString = path.map(cm.type).map(rst.termToString).join(' / ');
    const response = await ss.querySudo(`
      SELECT ?leaf
      WHERE {
        BIND (${rst.termToString(topSubject)} AS ?top)
        ?top ${pathString} ?leaf .
      } LIMIT 1
    `);
    const parsedResults = sparqlJsonParser.parseJsonResults(response);
    if (parsedResults.length > 0)
      collectedChildren.push(new SubjectConfig(parsedResults[0].leaf, config));
  }
  return collectedChildren;
}

/**
 * For a subject and a configuration, execute the targetGraphQuery and
 * substitute the recieved variables with their values in the
 * targetGraphTemplate. This results in possibly multiple target graphs, which
 * are all returned.
 *
 * @public
 * @async
 * @function
 * @param {NamedNode} subject - Subject on which to substitute and execute the
 * target graph query from the configuration.
 * @param {NamedNode} config - Represents the configuration entry for this
 * subject.
 * @returns {Array(NamedNode)} A collection with NamedNodes representing the
 * calculated target graphs.
 */
export async function targetGraphs(subject, config) {
  const targetQuery = cm.targetGraphQuery(config);
  if (targetQuery) {
    const substitutedQuery = targetQuery.value.replaceAll(
      '${subject}',
      rst.termToString(subject),
    );
    const targetGraphTemplateStr = cm.targetGraphTemplate(config).value;
    const response = await ss.querySudo(substitutedQuery);
    const vars = response.head.vars;
    const parsedResults = sparqlJsonParser.parseJsonResults(response);
    return parsedResults.map((res) => {
      let graph = targetGraphTemplateStr;
      vars.forEach((varname) => {
        const regex = new RegExp('\\${' + varname + '}', 'g');
        graph = graph.replaceAll(regex, res[varname].value);
      });
      return namedNode(graph);
    });
  } else {
    return cm.targetGraphTemplate(config);
  }
}

/**
 * Copies all the data (including deletes) for a subject to the target graph.
 * Data is first fetched from the triplestore to see if any deletes or inserts
 * are actually needed via in-memory triple stores and by calculating diffs.
 *
 * @public
 * @async
 * @function
 * @param {NamedNode} subject - Subject for which to copy data to the target
 * graph.
 * @param {NamedNode} config - Represents the config that fits for this
 * subject.
 * @param {Array(Literal)} targetGraphs - List of graphs to which to copy data
 * about this subject to, the target graphs.
 * @returns {undefined} Nothing.
 */
export async function transferDataToTargets(subject, config, targetGraphs) {
  const properties = cm.properties(config);
  const optionalProperties = cm.optionalProperties(config);
  const excludeProperties = cm.excludeProperties(config);

  for (const graph of targetGraphs) {
    const targetStore = new N3.Store();
    const sourceStore = new N3.Store();

    // Get everything from the target graph, don't filter on mandatory and
    // optional properties, because we know that that data has already gone
    // through the filtering before. We also need to be able to remove unneeded
    // data.
    const targetData = await sts.getDataForSubject(subject, graph);
    targetStore.addQuads([...targetData]);

    // Fetch data that is not in the target graph
    if (properties === undefined) {
      // All properties
      const targetData = await sts.getDataForSubject(
        subject,
        undefined,
        excludeProperties,
      );
      sourceStore.addQuads([...targetData]);
    } else {
      // Specific mandatory properties
      if (properties?.length > 0) {
        const leftOverProperties = properties.filter((prop) => {
          return !excludeProperties.some((ex) => ex.value === prop.value);
        });
        const targetData = await sts.getDataForSubjectMandatoryProperties(
          subject,
          undefined,
          leftOverProperties,
        );
        sourceStore.addQuads([...targetData]);
      }
      // Specific optional properties
      if (optionalProperties.length > 0) {
        const leftOverProperties = optionalProperties.filter((prop) => {
          return !excludeProperties.some((ex) => ex.value === prop.value);
        });
        const targetData = await sts.getDataForSubjectOptionalProperties(
          subject,
          undefined,
          leftOverProperties,
        );
        sourceStore.addQuads([...targetData]);
      }
    }
    // Specifically remove all the quads from all the target graphs and the temp graph
    for (const possibleTargetGraph of targetGraphs) {
      sourceStore
        .getQuads(undefined, undefined, undefined, possibleTargetGraph)
        .forEach((quad) => sourceStore.removeQuad(quad));
    }
    sourceStore
      .getQuads(undefined, undefined, undefined, namedNode(env.TEMP_GRAPH))
      .forEach((quad) => sourceStore.removeQuad(quad));

    const sourceStoreWithoutGraphs = new N3.Store();
    sourceStore.forEach((q) =>
      sourceStoreWithoutGraphs.addQuad(q.subject, q.predicate, q.object),
    );
    const targetStoreWithoutGraphs = new N3.Store();
    targetStore.forEach((q) =>
      targetStoreWithoutGraphs.addQuad(q.subject, q.predicate, q.object),
    );

    const { left, right } = hel.compareStores(
      sourceStoreWithoutGraphs,
      targetStoreWithoutGraphs,
    );

    await sts.deleteData(right, graph);
    await sts.insertData(left, graph);
  }
}

/*
 * Perform post processing on the subject in the target graph. A configuration
 * might contain a query that is to be executed on the subject to translate
 * properties, to add extra derived triples, ... If only an INSERT pattern is
 * given, we execute an INSERT DATA query, idem when only a DELETE pattern in
 * given. In all other cases, we execute a full DELETE ... INSERT ... WHERE
 * query (with potentially either of the DELETE or INSERT missing).
 * `${subject}` and `${targetgraph}` placeholders are substituted with their
 * respective values.
 *
 * @public
 * @async
 * @function
 * @param {NamedNode} subject - Subject to perform post processing on.
 * @param {Object} config - Configuration object for that subject.
 * @param {NamedNode} graph - Target graph in which to perform the processing.
 * @returns {undefined} Nothing
 */
export async function postProcess(subject, config, graph) {
  const prefixes = cm.postProcessPrefixes(config)?.value || '';
  const [deletePattern, insertPattern, wherePattern] = [
    cm.postProcessDelete(config),
    cm.postProcessInsert(config),
    cm.postProcessWhere(config),
  ].map((pattern) => {
    if (pattern)
      return pattern.value
        .replaceAll('${subject}', rst.termToString(subject))
        .replaceAll('${targetgraph}', rst.termToString(graph));
  });

  // Only a DELETE, no WHERE => DELETE DATA
  // Only an INSERT, no WHERE => INSERT DATA
  // Any other situation => DELETE and/or INSERT with WHERE

  let query;

  if (!deletePattern && !insertPattern) return;
  if (deletePattern && !insertPattern && !wherePattern)
    query = `
      ${prefixes}
      DELETE DATA {
        GRAPH ${rst.termToString(graph)} {
          ${deletePattern}
        }
      }`;
  else if (!deletePattern && insertPattern && !wherePattern)
    query = `
      ${prefixes}
      INSERT DATA {
        GRAPH ${rst.termToString(graph)} {
          ${insertPattern}
        }
      }`;
  else {
    const deletePart = deletePattern
      ? `
      DELETE {
        GRAPH ${rst.termToString(graph)} {
          ${deletePattern}
        }
      }`
      : '';
    const insertPart = insertPattern
      ? `
      INSERT {
        GRAPH ${rst.termToString(graph)} {
          ${insertPattern}
        }
      }`
      : '';
    query = `
      ${prefixes}
      ${deletePart}
      ${insertPart}
      WHERE {
        ${wherePattern}
      }`;
  }

  return ss.updateSudo(query);
}
