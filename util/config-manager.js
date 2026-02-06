import * as N3 from 'n3';
import * as fs from 'node:fs';
import { NAMESPACES as ns } from '../env';

/**
 * Variable to store the publicly available config. This is an N3.Store, read by the `readConfig` function.
 *
 * @static
 * @public
 * @constant
 */
export const CONFIG = complementConfig(readConfig());

/**
 * Reads the configuration from filesystem and parses it into an in-memory
 * store of triples.
 *
 * @function
 * @returns {N3.Store} Store with config data.
 */
function readConfig() {
  const parser = new N3.Parser();
  const configFileData = fs.readFileSync('/config/model.ttl').toString();
  console.log(configFileData);
  const configStore = new N3.Store();
  const quads = parser.parse(configFileData);
  configStore.addQuads(quads);
  return configStore;
}

// TODO: add stage to check if required entries are there
// TODO: add way to re-export the config for devs to check
// * including the prefixes that where entered in the first place

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
  const subclasses = store.getSubjects(ns.rdf`type`, ns.vdds`Sublass`);
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
   */
  [...classes, ...subclasses].forEach((subject) => {
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

  return store;
}

export function forType(type) {
  return CONFIG.getSubjects(ns.vdds`type`, type);
}

/*
 * Getters
 */

export function trigger(config) {
  const trigger = CONFIG.getObjects(config, ns.vdds`trigger`)[0];
  if (trigger.value === ns.vdds`noTrigger`) return undefined;
  return trigger;
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
