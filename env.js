import envvar from 'env-var';
import * as N3 from 'n3';
const { namedNode } = N3.DataFactory;

export const RUN_MODE = envvar.get('NODE_ENV').default('production').asString();

export const DATABASE_HOST = envvar
  .get('DATABASE_HOST')
  .example('http://database:8890')
  .default('http://database:8890')
  .asUrlString();

export const LOGLEVEL = envvar
  .get('LOGLEVEL')
  .default('silent')
  .asEnum(['error', 'silent']);

//TODO would be better as a separate config file when the wanted subjects
//become large in number?
export const INTERESTING_SUBJECT_TYPES = envvar
  .get('INTERESTING_SUBJECT_TYPES')
  .example(
    'http://rdf.myexperiment.org/ontologies/base/Submission,http://vocab.deri.ie/cogs#Job'
  )
  .default('http://rdf.myexperiment.org/ontologies/base/Submission')
  .asArray(',');

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

export const NAMESPACES = (() => {
  const all = {};
  for (const key in PREFIXES)
    all[key] = (pred) => namedNode(`${PREFIXES[key]}${pred}`);
  return all;
})();

export const SPARQL_PREFIXES = (() => {
  const all = [];
  for (const key in PREFIXES) all.push(`PREFIX ${key}: <${PREFIXES[key]}>`);
  return all.join('\n');
})();
