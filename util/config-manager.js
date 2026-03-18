import * as N3 from 'n3';
import * as fs from 'node:fs';
import * as rst from 'rdf-string-ttl';
import envvar from 'env-var';
import { NAMESPACES as ns } from '../env';
const { namedNode, literal } = N3.DataFactory;

/**
 * Variable to store the publicly available config. This is an N3.Store, read by the `readConfig` function.
 *
 * @static
 * @public
 * @constant
 */
export const CONFIG = new N3.Store();
export const PREFIXES = new Map();

(async function startup() {
  await makeConfig();
})();

/**
 * Reads and complements the configuration from filesystem. The config is
 * parsed and if any warnings can be given prints them on the command line. If
 * anything is missing from the config, an error is printed and thrown to stop
 * the application.
 *
 * @function
 * @returns {N3.Store} Store with the complemented config data.
 * @throws Throws an error in an attempt to stop the application from running
 * with an invalid config.
 */
async function makeConfig() {
  await readConfig();
  complementConfig();
  console.log(
    'PREFIXES =======================================================================',
  );
  PREFIXES.forEach((value, key) => {
    console.log(`${key}: ${rst.termToString(value)}`);
  });
  console.log(
    'CONFIG =========================================================================',
  );
  CONFIG.forEach((quad) => {
    console.log(
      rst.termToString(quad.subject),
      rst.termToString(quad.predicate),
      rst.termToString(quad.object),
      rst.termToString(quad.graph),
    );
  });
  console.log(
    '================================================================================',
  );
  errorOnInvalidConfig();
  warnOnInvalidConfig();
}

/**
 * Reads the configuration from filesystem and parses it into an in-memory
 * store of triples. It substitutes variables with environment variable values.
 *
 * @function
 * @returns {N3.Store} Store with config data.
 */
function readConfig() {
  const parser = new N3.Parser();
  const configFileData = fs.readFileSync('/config/model.ttl').toString();
  const varsProcessedData = substituteVars(configFileData);
  return new Promise((resolve, reject) => {
    parser.parse(varsProcessedData, (error, quad, prefixes) => {
      if (error) reject(error);
      if (quad) CONFIG.addQuad(quad);
      else if (prefixes) {
        Object.keys(prefixes).forEach((key) =>
          PREFIXES.set(key, namedNode(prefixes[key])),
        );
        resolve();
      }
    });
  });
}

/**
 * Takes a string and substitutes occurrences of strings like `#{var}` with the
 * environment variable of the name between the brackets. Throws an error if
 * the environment variable does not exist.
 *
 * @function
 * @param {String} dataStr - Configuration data in string form.
 * @returns {String} Same as the input, but with variables substituted.
 */
function substituteVars(dataStr) {
  const occurences = [...dataStr.matchAll(/#{\w+}/g)];
  const vars = occurences.map((occ) => occ[0].replace(/#{(\w+)}/, '$1'));
  for (const variable of vars) {
    const value = envvar.get(variable).required().asString();
    dataStr = dataStr.replaceAll(`#{${variable}}`, value);
  }
  return dataStr;
}

// TODO: add way to re-export the config for devs to check
// * including the prefixes that where entered in the first place

function errorOnInvalidConfig() {
  const classes = CONFIG.getSubjects(ns.rdf`type`, ns.vdds`Class`);
  const subclasses = CONFIG.getSubjects(ns.rdf`type`, ns.vdds`Subclass`);

  // Any subject without rdf:type
  CONFIG.getSubjects().forEach((subject) => {
    // Bug in N3? getSubjects() also returns an extra subject representing the default graph.
    if (N3.Util.isDefaultGraph(subject)) return;
    if (!CONFIG.has(subject, ns.rdf`type`))
      throw Error(
        `Subject ${rst.termToString(subject)} has no ${rst.termToString(ns.rdf`type`)}.`,
      );
  });

  // No vdds:Class subjects
  if (classes.length < 1)
    throw new Error(
      `Couldn't find any configurations with type ${rst.termToString(ns.vdds`Class`)}.`,
    );

  // vdds:Subclass without parents
  [...subclasses].forEach((subject) => {
    const hasAsRange = CONFIG.has(undefined, ns.rdfs`range`, subject);
    const domainProp = CONFIG.getQuads(undefined, ns.rdfs`domain`, subject)[0];
    const hasAsDomain =
      domainProp && CONFIG.has(domainProp, ns.vdds`inverse`, literal(true));
    if (!(hasAsRange || hasAsDomain))
      throw new Error(
        `Subclass ${rst.termToString(subject)} is not used as part of a hierarchy and is therefore not useful on its own. This is likely an error.`,
      );
  });

  // vdds:Class without targetGraphTemplate
  [...classes].forEach((subject) => {
    if (!CONFIG.has(subject, ns.vdds`targetGraphTemplate`))
      throw new Error(
        `Class ${rst.termToString(subject)} has no ${rst.termToString(ns.vdds`targetGraphTemplate`)}.`,
      );
  });

  // vdds:Class without vdds:targetGraphQuery and the vdds:targetGraphTemplate
  // uses variables
  [...classes]
    .filter((subject) => !CONFIG.has(subject, ns.vdds`targetGraphQuery`))
    .forEach((subject) => {
      const templateStr = CONFIG.getObjects(
        subject,
        ns.vdds`targetGraphTemplate`,
      )[0]?.value;
      if (templateStr && templateStr.match(/\${\w+}/)?.length > 0) {
        throw new Error(
          `Subject ${rst.termToString(subject)} has no ${rst.termToString(ns.vdds`targetGraphQuery`)}, but uses variables in its ${rst.termToString(ns.vdds`targetGraphTemplate`)}.`,
        );
      }
    });

  // vdds:Subclass cannot have vdds:trigger, vdds:targetGraphQuery nor
  // vdds:targetGraphTemplate
  [...subclasses].forEach((subject) => {
    if (CONFIG.has(subject, ns.vdds`trigger`)) {
      throw new Error(
        `Subclass definition ${rst.termToString(subject)} has a ${rst.termToString(ns.vdds`trigger`)}, but this never used and should be removed for clarity. Only top-level classes can have trigger patterns, not subclasses.`,
      );
    }
  });
  [...subclasses].forEach((subject) => {
    if (CONFIG.has(subject, ns.vdds`targetGraphQuery`))
      throw new Error(
        `Subclass definition ${rst.termToString(subject)} has a ${rst.termToString(ns.vdds`targetGraphQuery`)}, but this is never used and should be removed for clarity. Only top-level classes can have these queries, not subclasses.`,
      );
  });
  [...subclasses].forEach((subject) => {
    if (CONFIG.has(subject, ns.vdds`targetGraphTemplate`))
      throw new Error(
        `Subclass definition ${rst.termToString(subject)} has a ${rst.termToString(ns.vdds`targetGraphTemplate`)}, but this is never used and should be removed for clarity. Only top-level classes can have template strings, not subclasses.`,
      );
  });

  // vdds:Classes or vdds:Subclasses cannot have a where clause without delete
  // or insert pattern
  [...classes, ...subclasses].forEach((subject) => {
    const where = CONFIG.getObjects(subject, ns.vdds`postProcessWhere`)[0];
    if (
      where &&
      !CONFIG.has(subject, ns.vdds`postProcessInsert`) &&
      !CONFIG.has(subject, ns.vdds`postProcessDelete`)
    )
      throw new Error(
        `Subject ${rst.termToString(subject)} has a post processing WHERE clause, but no DELETE or INSERT clauses. This seems like a mistake.`,
      );
  });
}

/* eslint-disable no-unused-vars */
function warnOnInvalidConfig() {
  // Nothing yet
}
/* eslint-enable no-unused-vars */

/**
 * Enrich the config with defaults that the rest of the service can trust on.
 * Prefer to set defaults explicit in the config instead of using conditionals
 * in code to provide defaults. The input argument store is destructively
 * changed.
 *
 * @function
 * @param {N3.Store} store - Store with config that will be complemented with
 * defaults. @returns {N3.Store} Same store as input argument, but with
 * defaults added.
 */
function complementConfig() {
  const classes = CONFIG.getSubjects(ns.rdf`type`, ns.vdds`Class`);
  const subclasses = CONFIG.getSubjects(ns.rdf`type`, ns.vdds`Subclass`);
  const properties = CONFIG.getSubjects(
    ns.rdf`type`,
    ns.vdds`HierarchyProperty`,
  );
  /**
   * Adds a specific default type triple for every VDDS config entry. A normal
   * VDDS config entry has e.g.
   *
   * ```
   * meb:Submission a vdds:Class ;
   *                vdds:trigger ... ;
   *                vdds:property ... ;
   *                ... .
   * ```
   *
   * and this is missing a `vdds:type` property that we just assume to be the
   * same as the subject of the config entry e.g.
   *
   * ```
   * meb:Submission vdds:type meb:Submission .
   * ```
   */
  [...classes, ...subclasses, ...properties].forEach((subject) => {
    if (!CONFIG.has(subject, ns.vdds`type`))
      CONFIG.addQuad(subject, ns.vdds`type`, subject);
  });

  /**
   * Adds the default `vdds:allProperties` when no specific properties are
   * selected for copying.
   */
  [...classes, ...subclasses].forEach((subject) => {
    if (
      !(
        CONFIG.has(subject, ns.vdds`property`) ||
        CONFIG.has(subject, ns.vdds`optionalProperty`)
      )
    )
      CONFIG.addQuad(subject, ns.vdds`property`, ns.vdds`allProperties`);
  });
}

/**
 * Path traversal
 */

/**
 * Calculates the top most config elements in the hierarchy (based on
 * HierarchyProperties with domain and range) and returns them with a path to
 * get from the top config to the given config.
 * Multiple parents might be returned in the array, because there might be
 * config reuse between hierarchies. Ultimately, the trigger query is what
 * should give a green light for copying.
 *
 * @public
 * @function
 * @param {NameNode} config - Represents the URI to the configuration entry
 * that is part of a hierarchical structure.
 * @param {Array(NamedNode)} path - OPTIONAL List of HierarchyProperty elements
 * that represents the path from the current config to the originally given
 * leaf config. (Leave empty, mostly used during the recursive call.)
 * @returs {Array(Object(path, topConfig))} List of objects with the `path`
 * from the top element in the hierarchy to the given element and `topConfig`
 * with the config representation for the top element.
 */
export function pathsTopToConfig(config, path = []) {
  let properties,
    result = [];

  if (CONFIG.has(config, ns.rdf`type`, ns.vdds`Class`))
    result.push({ path: [], topConfig: config });

  // Find configs with forward relations
  properties = CONFIG.getSubjects(ns.rdfs`range`, config).filter(
    (property) => !CONFIG.has(property, ns.vdds`inverse`, literal(true)),
  );
  for (const property of properties) {
    const parentConfig = CONFIG.getObjects(property, ns.rdfs`domain`)[0];
    const currentPath = [property, ...path];
    if (CONFIG.has(parentConfig, ns.rdf`type`, ns.vdds`Class`)) {
      result.push({ path: currentPath, topConfig: parentConfig });
    } else {
      const nextResult = pathsTopToConfig(parentConfig, currentPath);
      result = result.concat(nextResult);
    }
  }

  // Find configs with backward/inverse relations
  properties = CONFIG.getSubjects(ns.rdfs`domain`, config)
    .filter((property) => CONFIG.has(property, ns.vdds`inverse`, literal(true)))
    .map((property) => {
      property.inverse = true;
      return property;
    });
  for (const property of properties) {
    const parentConfig = CONFIG.getObjects(property, ns.rdfs`range`)[0];
    const currentPath = [property, ...path];
    if (CONFIG.has(parentConfig, ns.rdf`type`, ns.vdds`Class`)) {
      result.push({ path: currentPath, topConfig: parentConfig });
    } else {
      const nextResult = pathsTopToConfig(parentConfig, currentPath);
      result = result.concat(nextResult);
    }
  }

  return result;
}

// Input: meb:Submission1
// Output:
//  [
//    {
//      path: [ prov:generated1 ]
//      config: am:FormData1
//    }
//    {
//      path: [ dct:subject1 ]
//      config: ext:SubmissionDocument1
//    }
//    {
//      path: [ prov:generated1, prov:hasPart1 ]
//      config: nfo:FileDataObject1
//    }
//  ]
/**
 * Takes a representation of a config and finds all child configs (also
 * non-leaves) and combines these in a flat list with their path.
 *
 * @public
 * @function
 * @param {NameNode} config - Represents a configuration (does not need to be
 * the top most element in a hierarchy).
 * @param {Array(NameNode)} path - OPTIONAL List of HierarchyProperty elements
 * from the config to precede the paths taken to the children. (Leave empty,
 * mostly used during the recursive call.)
 * @returns {Array(Object(path, config))} List of objects that represent the
 * path taken to a child element (in the form of NamedNodes that represent the
 * config element), and the config for that child element. See the comment
 * above for an example output.
 */
export function pathsToAllChildren(config, path = []) {
  let properties,
    result = [];

  // Find configs with forward relations
  properties = CONFIG.getSubjects(ns.rdfs`domain`, config).filter(
    (property) => !CONFIG.has(property, ns.vdds`inverse`, literal(true)),
  );
  for (const property of properties) {
    const childConfig = CONFIG.getObjects(property, ns.rdfs`range`)[0];
    const currentPath = [...path, property];
    result.push({ path: currentPath, config: childConfig });
    const nextResult = pathsToAllChildren(childConfig, currentPath);
    result = result.concat(nextResult);
  }

  // Find configs with backward/inverse relations
  properties = CONFIG.getSubjects(ns.rdfs`range`, config)
    .filter((property) => CONFIG.has(property, ns.vdds`inverse`, literal(true)))
    .map((property) => {
      property.inverse = true;
      return property;
    });
  for (const property of properties) {
    const childConfig = CONFIG.getObjects(property, ns.rdfs`domain`)[0];
    const currentPath = [...path, property];
    result.push({ path: currentPath, config: childConfig });
    const nextResult = pathsToAllChildren(childConfig, currentPath);
    result = result.concat(nextResult);
  }

  return result;
}

/**
 * General getters
 */

export function forType(type) {
  return CONFIG.getSubjects(ns.vdds`type`, type);
}

export function classes() {
  return CONFIG.getSubjects(ns.rdf`type`, ns.vdds`Class`);
}

/*
 * Getters on a specific config subject
 */

export function type(config) {
  return CONFIG.getObjects(config, ns.vdds`type`)[0];
}

export function domain(config) {
  return CONFIG.getObjects(config, ns.rdfs`domain`)[0];
}

export function range(config) {
  return CONFIG.getObjects(config, ns.rdfs`range`)[0];
}

export function isInverse(config) {
  return CONFIG.has(config, ns.vdds`inverse`, literal(true));
}

export function trigger(config) {
  return CONFIG.getObjects(config, ns.vdds`trigger`)[0];
}

export function targetGraphQuery(config) {
  return CONFIG.getObjects(config, ns.vdds`targetGraphQuery`)[0];
}

export function targetGraphTemplate(config) {
  return CONFIG.getObjects(config, ns.vdds`targetGraphTemplate`)[0];
}

export function properties(config) {
  const properties = CONFIG.getObjects(config, ns.vdds`property`);
  if (
    properties.length === 1 &&
    properties[0]?.value === ns.vdds`allProperties`.value
  )
    return undefined;
  else return properties;
}

export function optionalProperties(config) {
  return CONFIG.getObjects(config, ns.vdds`optionalProperty`);
}

export function excludeProperties(config) {
  return CONFIG.getObjects(config, ns.vdds`excludeProperty`);
}

export function postProcessDelete(config) {
  return CONFIG.getObjects(config, ns.vdds`postProcessDelete`)[0];
}
export function postProcessInsert(config) {
  return CONFIG.getObjects(config, ns.vdds`postProcessInsert`)[0];
}
export function postProcessWhere(config) {
  return CONFIG.getObjects(config, ns.vdds`postProcessWhere`)[0];
}
