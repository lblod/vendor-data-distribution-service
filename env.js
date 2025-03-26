import envvar from 'env-var';
import * as N3 from 'n3';
const { namedNode } = N3.DataFactory;

export const SPARQL_ENDPOINT_COPY_OPERATIONS = envvar
  .get('SPARQL_ENDPOINT_COPY_OPERATIONS')
  .default('http://database:8890/sparql')
  .asUrlString();

export const SPARQL_ENDPOINT_HEALING_OPERATIONS = envvar
  .get('SPARQL_ENDPOINT_HEALING_OPERATIONS')
  .default('http://virtuoso:8890/sparql')
  .asUrlString();

export const TEMP_GRAPH = envvar
  .get('TEMP_GRAPH')
  .default('http://mu.semte.ch/graphs/vendor-data-distribution/temp')
  .asUrlString();

export const PROCESSING_INTERVAL = envvar
  .get('PROCESSING_INTERVAL')
  .default(300000) //30000 is 5 minutes
  .asIntPositive();

export const PROCESSING_INTERVAL_SIZE = envvar
  .get('PROCESSING_INTERVAL_SIZE')
  .default(100)
  .asIntPositive();

export const CLEANUP_CRON = envvar
  .get('CLEANUP_CRON')
  .default('30 * * * *')
  .asString();

export const CREATOR =
  'http://lblod.data.gift/services/vendor-data-distribution-service';

export const RUN_MODE = envvar.get('NODE_ENV').default('production').asString();

export const LOGLEVEL = envvar
  .get('LOGLEVEL')
  .default('silent')
  .asEnum(['error', 'info', 'silent']);

export const WRITE_ERRORS = envvar
  .get('WRITE_ERRORS')
  .default('false')
  .asBool();

export const ERROR_GRAPH = envvar
  .get('ERROR_GRAPH')
  .default('http://lblod.data.gift/errors')
  .asUrlString();

export const ERROR_BASE = envvar
  .get('ERR0R_BASE')
  .default('http://data.lblod.info/errors/')
  .asUrlString();

export const MIN_DELAY_TO_PROCESS_NEXT_DELTA = envvar
  .get('MIN_DELAY_TO_PROCESS_NEXT_DELTA')
  .default('1000')
  .asIntPositive();

export const MAX_DELAY_TO_PROCESS_NEXT_DELTA = envvar
  .get('MAX_DELAY_TO_PROCESS_NEXT_DELTA')
  .default('2000')
  .asIntPositive();

export const MU_SCOPE = envvar
  .get('MU_SCOPE')
  .default('http://redpencil.data.gift/id/concept/muScope/deltas/vendor-data')
  .asUrlString();

const PREFIXES = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  mu: 'http://mu.semte.ch/vocabularies/core/',
  foaf: 'http://xmlns.com/foaf/0.1/',
  muAccount: 'http://mu.semte.ch/vocabularies/account/',
  wotSec: 'https://www.w3.org/2019/wot/security#',
  lblodAuth: 'http://lblod.data.gift/vocabularies/authentication/',
  pav: 'http://purl.org/pav/',
  session: 'http://mu.semte.ch/vocabularies/session/',
  oslc: 'http://open-services.net/ns/core#',
  dct: 'http://purl.org/dc/terms/',
};

const BASE = {
  error: 'http://data.lblod.info/errors/',
};

export const NAMESPACES = (() => {
  const all = {};
  for (const key in PREFIXES)
    all[key] = (pred) => namedNode(`${PREFIXES[key]}${pred}`);
  return all;
})();

export const BASES = (() => {
  const all = {};
  for (const key in BASE) all[key] = (pred) => namedNode(`${BASE[key]}${pred}`);
  return all;
})();

export const SPARQL_PREFIXES = (() => {
  const all = [];
  for (const key in PREFIXES) all.push(`PREFIX ${key}: <${PREFIXES[key]}>`);
  return all.join('\n');
})();
