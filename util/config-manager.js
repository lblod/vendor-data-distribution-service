import * as N3 from 'n3';
import * as fs from 'node:fs';
import * as rst from 'rdf-string-ttl';
import { NAMESPACES as ns } from '../env';

/**
 * Variable to store the publicly available config. This is an N3.Store, read by the `readConfig` function.
 *
 * @static
 * @public
 * @constant
 */
export const CONFIG = getFinalConfig();

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
export function getFinalConfig() {
  const rawConfig = readConfig();
  const complementedConfig = complementConfig(rawConfig);
  errorOnInvalidConfig(complementedConfig);
  warnOnInvalidConfig(complementedConfig);
  console.log(
    'CONFIG =========================================================================',
  );
  complementedConfig.forEach((quad) => {
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
  return complementedConfig;
}

/**
 * Reads the configuration from filesystem and parses it into an in-memory
 * store of triples. No processing on it is done yet.
 *
 * @function
 * @returns {N3.Store} Store with config data.
 */
function readConfig() {
  const parser = new N3.Parser();
  const configFileData = fs.readFileSync('/config/model.ttl').toString();
  const configStore = new N3.Store();
  const quads = parser.parse(configFileData);
  configStore.addQuads(quads);
  return configStore;
}

// TODO: add way to re-export the config for devs to check
// * including the prefixes that where entered in the first place

function errorOnInvalidConfig(store) {
  const classes = store.getSubjects(ns.rdf`type`, ns.vdds`Class`);
  const subclasses = store.getSubjects(ns.rdf`type`, ns.vdds`Subclass`);

  // Any subject without rdf:type
  store.getSubjects().forEach((subject) => {
    // Bug in N3? getSubjects() also returns an extra subject representing the default graph.
    if (N3.Util.isDefaultGraph(subject)) return;
    if (!store.has(subject, ns.rdf`type`))
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
    if (!store.has(undefined, ns.rdfs`range`, subject))
      throw new Error(
        `Subclass ${rst.termToString(subject)} is not used as part of a hierarchy and is therefore not useful on its own. This is likely an error.`,
      );
  });

  // vdds:Class without targetGraphTemplate
  [...classes].forEach((subject) => {
    if (!store.has(subject, ns.vdds`targetGraphTemplate`))
      throw new Error(
        `Class ${rst.termToString(subject)} has no ${rst.termToString(ns.vdds`targetGraphTemplate`)}.`,
      );
  });

  // vdds:Class without vdds:targetGraphQuery and the vdds:targetGraphTemplate
  // uses variables
  [...classes]
    .filter((subject) =>
      store.has(subject, ns.vdds`targetGraphQuery`, ns.vdds`noQuery`),
    )
    .forEach((subject) => {
      const templateStr = store.getObjects(
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
    if (store.has(subject, ns.vdds`trigger`)) {
      throw new Error(
        `Subclass definition ${rst.termToString(subject)} has a ${rst.termToString(ns.vdds`trigger`)}, but this never used and should be removed for clarity. Only top-level classes can have trigger patterns, not subclasses.`,
      );
    }
  });
  [...subclasses].forEach((subject) => {
    if (store.has(subject, ns.vdds`targetGraphQuery`))
      throw new Error(
        `Subclass definition ${rst.termToString(subject)} has a ${rst.termToString(ns.vdds`targetGraphQuery`)}, but this is never used and should be removed for clarity. Only top-level classes can have these queries, not subclasses.`,
      );
  });
  [...subclasses].forEach((subject) => {
    if (store.has(subject, ns.vdds`targetGraphTemplate`))
      throw new Error(
        `Subclass definition ${rst.termToString(subject)} has a ${rst.termToString(ns.vdds`targetGraphTemplate`)}, but this is never used and should be removed for clarity. Only top-level classes can have template strings, not subclasses.`,
      );
  });
}

/* eslint-disable no-unused-vars */
function warnOnInvalidConfig(store) {
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
function complementConfig(store) {
  const classes = store.getSubjects(ns.rdf`type`, ns.vdds`Class`);
  const subclasses = store.getSubjects(ns.rdf`type`, ns.vdds`Subclass`);
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
  [...classes, ...subclasses].forEach((subject) => {
    if (!store.has(subject, ns.vdds`type`))
      store.addQuad(subject, ns.vdds`type`, subject);
  });

  /**
   * Add the default `vdds:noTrigger` when no trigger is given.
   * Only on Class (no Subclass)
   */
  [...classes].forEach((subject) => {
    if (!store.has(subject, ns.vdds`trigger`))
      store.addQuad(subject, ns.vdds`trigger`, ns.vdds`noTrigger`);
  });

  /**
   * Adds the default `vdds:allProperties` when no specific properties are
   * selected for copying.
   */
  [...classes, ...subclasses].forEach((subject) => {
    if (
      !(
        store.has(subject, ns.vdds`property`) ||
        store.has(subject, ns.vdds`optionalProperty`)
      )
    )
      store.addQuad(subject, ns.vdds`property`, ns.vdds`allProperties`);
  });

  /**
   * Adds the default `vdds:noPostProcessing` when no post processing query is
   * given.
   */
  [...classes, ...subclasses].forEach((subject) => {
    if (!store.has(subject, ns.vdds`postProcessQuery`))
      store.addQuad(
        subject,
        ns.vdds`postProcessQuery`,
        ns.vdds`noPostProcessing`,
      );
  });

  /**
   * Classes (not Subclasses) that have no `vdds:targetGraphQuery` get the
   * default `vdds:noQuery`.
   */
  [...classes].forEach((subject) => {
    if (!store.has(subject, ns.vdds`targetGraphQuery`))
      store.addQuad(subject, ns.vdds`targetGraphQuery`, ns.vdds`noQuery`);
  });

  return store;
}

/**
 * General getters
 */

export function forType(type) {
  return CONFIG.getSubjects(ns.vdds`type`, type);
}

/*
 * Getters on a specific config subject
 */

export function trigger(config) {
  const trigger = CONFIG.getObjects(config, ns.vdds`trigger`)[0];
  if (trigger.value === ns.vdds`noTrigger`.value) return undefined;
  return trigger;
}

export function targetGraphQuery(config) {
  const query = CONFIG.getObjects(config, ns.vdds`targetGraphQuery`)[0];
  if (query.value === ns.vdds`noQuery`.value) return undefined;
  return query;
}

export function targetGraphTemplate(config) {
  return CONFIG.getObjects(config, ns.vdds`targetGraphTemplate`)[0];
}

export function properties(config) {
  const properties = CONFIG.getObjects(config, ns.vdds`property`);
  if (
    properties.length === 1 &&
    properties[0].value === ns.vdds`allProperties`.value
  )
    return undefined;
  if (
    properties.length === 1 &&
    properties[0].value === ns.vdds`noProperties`.value
  )
    return [];
  return properties;
}

export function optionalProperties(config) {
  return CONFIG.getObjects(config, ns.vdds`optionalProperty`);
}
