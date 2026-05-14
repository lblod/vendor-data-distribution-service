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
  if (subjects?.length > 0)
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
  else return new N3.Store();
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
 * @param {String} mode - Optional. Used to differentiate between normal
 * operations ('copy') and healing operations ('healing').
 * @returns {Boolean} True if the ASK query matches, false otherwise.
 */
export async function matchTriggerOnSubject(subject, trigger, mode) {
  const triggerStr = trigger.value;
  const substitutedPattern = triggerStr.replaceAll(
    '${subject}',
    rst.termToString(subject),
  );
  const triggerResponse = await ss.querySudo(
    `
    ASK {
      ${substitutedPattern}
    }`,
    mode,
  );
  return sparqlJsonParser.parseJsonBoolean(triggerResponse);
}

/**
 * Calculates and fetches for a subject its top most elements in the hierarchy
 * from the triplestore.
 *
 * @public
 * @async
 * @function
 * @param {SubjectConfig} subjectWithConfig - A subject and its configuration
 * that is part of a hierarchy. (A hierarchy of 1 element is possible too.)
 * @returns {Array(SubjectConfig)} A flat list of subject and their
 * configuration that are the top elements of a hierarchy.
 */
export async function hierarchyTops(subjectWithConfig) {
  const { subject, config } = subjectWithConfig;
  const parentConfigs = cm.pathsTopToConfig(config);
  const collectedParents = [];

  for (const { path, topConfig } of parentConfigs) {
    if (path.length > 0) {
      const topType = cm.type(topConfig);
      const pathString = configPathToString(path);
      const response = await ss.querySudo(`
        SELECT DISTINCT ?top
        WHERE {
          BIND (${rst.termToString(subject)} AS ?leaf)
          ?top ${pathString} ?leaf .
          ?top rdf:type ${rst.termToString(topType)} .
        }
      `);
      const parsedResults = sparqlJsonParser.parseJsonResults(response);
      if (parsedResults.length > 0)
        parsedResults.forEach((res) => {
          collectedParents.push(new SubjectConfig(res.top, topConfig));
        });
    } else {
      collectedParents.push(subjectWithConfig);
    }
  }
  return collectedParents;
}

/**
 * Translate a path of predicates to a path string for use in a SPARQL query.
 *
 * @function
 * @param {Array(NamedNode)} path - List of NamedNodes representing the configs
 * representing the predicates between entities in the triplestore. NamedNodes
 * can have an extra `inverse` property to identify inverse relations.
 * @returns {String} Full SPARQL property path.
 */
function configPathToString(path) {
  const pathString = path
    .map((config) => {
      if (cm.isInverse(config)) return `^${rst.termToString(cm.type(config))}`;
      else return rst.termToString(cm.type(config));
    })
    .join(' / ');
  return pathString;
}

/**
 * Calculates and fetches from the triplestore all child configurations and
 * the child entities.
 *
 * @public
 * @async
 * @function
 * @param {Hierarchy} hierarchy - Instance representing an (usually the top
 * most) element in a hierarchy and its config.
 * @param {String} mode - Optional. Used to differentiate between normal
 * operations ('copy') and healing operations ('healing').
 * @returns {Array(SubjectConfig)} A flat list of all the child entities and
 * their config.
 */
export async function hierarchyChildren(hierarchy, mode) {
  const { topSubject, topConfig } = hierarchy;
  const childrenConfigs = cm.pathsToAllChildren(topConfig);
  const collectedChildren = [];
  for (const { path, config } of childrenConfigs) {
    const pathString = configPathToString(path);
    const childType = cm.type(config);
    const response = await ss.querySudo(
      `
      SELECT DISTINCT ?leaf
      WHERE {
        BIND (${rst.termToString(topSubject)} AS ?top)
        ?top ${pathString} ?leaf .
        ?leaf rdf:type ${rst.termToString(childType)} .
      }
    `,
      mode,
    );
    const parsedResults = sparqlJsonParser.parseJsonResults(response);
    parsedResults.forEach((res) => {
      collectedChildren.push(new SubjectConfig(res.leaf, config));
    });
  }
  return collectedChildren;
}

export class SourceAndTargetGraphs {
  constructor(sourceGraphs, targetGraphs) {
    this.sourceGraphs = sourceGraphs;
    this.targetGraphs = targetGraphs;
  }
}

/**
 * For a subject and a configuration, execute the graphQuery and substitute the
 * recieved variables with their values in the targetGraphTemplate and the
 * sourceGraphTemplate. This results in possibly multiple target and source
 * graphs, which are all returned.
 *
 * @public
 * @async
 * @function
 * @param {NamedNode} subject - Subject on which to substitute and execute the
 * target graph query from the configuration.
 * @param {NamedNode} config - Represents the configuration entry for this
 * subject.
 * @param {String} mode - Optional. Used to differentiate between normal
 * operations ('copy') and healing operations ('healing').
 * @returns {SourceAndTargetGraphs} An instance of SourceAndTargetGraphs with
 * properties `sourceGraphs` and `targetGraphs` with collections of NamedNodes
 * representing the calculated source and target graphs respectively.
 */
export async function sourceAndTargetGraphs(subject, config, mode) {
  const targetQuery = cm.graphQuery(config);
  if (targetQuery) {
    const substitutedQuery = targetQuery.value.replaceAll(
      '${subject}',
      rst.termToString(subject),
    );
    const response = await ss.querySudo(substitutedQuery, mode);
    const vars = response.head.vars;
    const parsedResults = sparqlJsonParser.parseJsonResults(response);
    let targetGraphs = [],
      sourceGraphs = [];

    const targetGraphTemplateStrs = cm
      .targetGraphTemplates(config)
      .map((tgt) => tgt.value);
    for (const result of parsedResults) {
      for (let targetGraphStr of targetGraphTemplateStrs) {
        for (const varname of vars) {
          const regex = new RegExp('\\${' + varname + '}', 'g');
          targetGraphStr = targetGraphStr.replaceAll(
            regex,
            result[varname].value,
          );
        }
        targetGraphs.push(namedNode(targetGraphStr));
      }
    }

    const sourceGraphTemplateStrs = cm
      .sourceGraphTemplates(config)
      .map((tgt) => tgt.value);
    for (const result of parsedResults) {
      for (let sourceGraphStr of sourceGraphTemplateStrs) {
        for (const varname of vars) {
          const regex = new RegExp('\\${' + varname + '}', 'g');
          sourceGraphStr = sourceGraphStr.replaceAll(
            regex,
            result[varname].value,
          );
        }
        sourceGraphs.push(namedNode(sourceGraphStr));
      }
    }

    return new SourceAndTargetGraphs(sourceGraphs, targetGraphs);
  } else {
    const targetGraphs = cm.targetGraphTemplates(config);
    const sourceGraphs = cm.sourceGraphTemplates(config);
    return new SourceAndTargetGraphs(sourceGraphs, targetGraphs);
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
 * @param {Array(Literal)} sourceGraphs - List of graphs from which to copy
 * data about this subject, the source graphs. This can be left undefined or
 * [undefined] to allow copying from all graphs in the triplestore, basically
 * from the whole triplestore without graph restrictions.
 * @param {String} mode - Optional. Used to differentiate between normal
 * operations ('copy') and healing operations ('healing').
 * @returns {undefined} Nothing.
 */
export async function transferDataToTargets(
  subject,
  config,
  targetGraphs,
  sourceGraphs,
  mode,
) {
  // Hack: if no sourceGraphs, then use `undefined` as a fallback to allow
  // fetching from all graphs.
  if (sourceGraphs?.length < 1) sourceGraphs = [undefined];
  const properties = cm.properties(config);
  const optionalProperties = cm.optionalProperties(config);
  const excludeProperties = cm.excludeProperties(config);
  const entityIndex = new N3.EntityIndex();

  // Create a source store of all the data about the subject
  // This is created once here and reused below.
  // NOTE: do not alter the store after its initial creation!
  const sourceStore = new N3.Store([], { entityIndex });

  // Fetch data that about subjects from all graphs, or the source graphs if
  // they are given
  for (const sourceGraph of sourceGraphs) {
    if (properties === undefined) {
      // All properties
      const sourceData = await sts.getDataForSubject(
        subject,
        sourceGraph,
        excludeProperties,
        mode,
      );
      sourceStore.addQuads([...sourceData]);
    } else {
      // Specific mandatory properties
      if (properties?.length > 0) {
        const leftOverProperties = properties.filter((prop) => {
          return !excludeProperties.some((ex) => ex.value === prop.value);
        });
        const sourceData = await sts.getDataForSubjectMandatoryProperties(
          subject,
          sourceGraph,
          leftOverProperties,
          mode,
        );
        sourceStore.addQuads([...sourceData]);
      }
      // Specific optional properties
      if (optionalProperties.length > 0) {
        const leftOverProperties = optionalProperties.filter((prop) => {
          return !excludeProperties.some((ex) => ex.value === prop.value);
        });
        const sourceData = await sts.getDataForSubjectOptionalProperties(
          subject,
          sourceGraph,
          leftOverProperties,
          mode,
        );
        sourceStore.addQuads([...sourceData]);
      }
    }
  }
  // Remove data from the temp graph.
  sourceStore
    .getQuads(undefined, undefined, undefined, namedNode(env.TEMP_GRAPH))
    .forEach((quad) => sourceStore.removeQuad(quad));

  for (const targetGraph of targetGraphs) {
    const targetStore = new N3.Store([], { entityIndex });
    const sourceStoreCopy = new N3.Store([], { entityIndex });
    // Make a copy of the sourceStore, because we don't want to change the
    // original store as it is reused.
    sourceStore.forEach((q) => sourceStoreCopy.addQuad(q));

    // Get everything from the target graph, don't filter on mandatory and
    // optional properties, because we know that that data has already gone
    // through the filtering before. We also need to be able to remove unneeded
    // data.
    const targetData = await sts.getDataForSubject(
      subject,
      targetGraph,
      undefined,
      mode,
    );
    targetStore.addQuads([...targetData]);

    // Specifically remove all the quads from all the target graphs.
    for (const possibleTargetGraph of targetGraphs) {
      sourceStoreCopy
        .getQuads(undefined, undefined, undefined, possibleTargetGraph)
        .forEach((quad) => sourceStoreCopy.removeQuad(quad));
    }

    const sourceStoreWithoutGraphs = new N3.Store([], { entityIndex });
    for (const q of sourceStoreCopy)
      sourceStoreWithoutGraphs.addQuad(q.subject, q.predicate, q.object);
    const targetStoreWithoutGraphs = new N3.Store([], { entityIndex });
    for (const q of targetStore)
      targetStoreWithoutGraphs.addQuad(q.subject, q.predicate, q.object);

    const { left, right } = hel.compareStores(
      sourceStoreWithoutGraphs,
      targetStoreWithoutGraphs,
    );

    await sts.deleteData(right, targetGraph, mode);
    await sts.insertData(left, targetGraph, mode);
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
 * @param {Array(NamedNode)} sourceGraphs - Collection of NamedNodes
 * representing possible source graphs from which to select data. Leave
 * undefined or [undefined] to allow selecting from the whole triplestore.
 * @param {String} mode - Optional. Used to differentiate between normal
 * operations ('copy') and healing operations ('healing').
 * @returns {undefined} Nothing
 */
export async function postProcess(subject, config, graph, sourceGraphs, mode) {
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
      DELETE DATA {
        GRAPH ${rst.termToString(graph)} {
          ${deletePattern}
        }
      }`;
  else if (!deletePattern && insertPattern && !wherePattern)
    query = `
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

    // If sourceGraphs have been given, only select from there, otherwise
    // select from the whole triplestore.
    if (sourceGraphs?.length > 0 && sourceGraphs[0] !== undefined) {
      const graphValues = sourceGraphs.map(rst.termToString).join('\n');
      query = `
        ${deletePart}
        ${insertPart}
        WHERE {
          VALUES ?sourceGraph { ${graphValues} }
          GRAPH ?sourceGraph {
            ${wherePattern}
          }
        }`;
    } else {
      query = `
        ${deletePart}
        ${insertPart}
        WHERE {
          ${wherePattern}
        }`;
    }
  }

  return ss.updateSudo(query, mode);
}
