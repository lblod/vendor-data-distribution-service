import envvar from 'env-var';
import * as N3 from 'n3';
const { namedNode } = N3.DataFactory;

export const RUN_MODE = envvar.get('NODE_ENV').default('production').asString();

export const LOGLEVEL = envvar
  .get('LOGLEVEL')
  .default('silent')
  .asEnum(['error', 'info', 'silent']);

//TODO would be better as a separate config file when the wanted subjects
//become large in number?
//TODO we only support Submissions for now. Make this config better.
export const INTERESTING_SUBJECT_TYPES = envvar
  .get('INTERESTING_SUBJECT_TYPES')
  .example(
    'http://rdf.myexperiment.org/ontologies/base/Submission,http://vocab.deri.ie/cogs#Job'
  )
  .default('http://rdf.myexperiment.org/ontologies/base/Submission')
  .asArray(',');

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
