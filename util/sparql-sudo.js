import * as mas from '@lblod/mu-auth-sudo';
import * as env from '../env';
import * as sap from './sparql-auto-prefix';

const sparqlConnectionHeaders = {
  'mu-call-scope-id': env.MU_SCOPE,
};
const sparqlConnectionOptionsCopy = {
  sparqlEndpoint: env.SPARQL_ENDPOINT_COPY_OPERATIONS,
  mayRetry: true,
};
const sparqlConnectionOptionsHeal = {
  sparqlEndpoint: env.SPARQL_ENDPOINT_HEALING_OPERATIONS,
  mayRetry: true,
};

function connectionOptions(mode) {
  switch (mode) {
    case 'healing':
      return sparqlConnectionOptionsHeal;
    case 'copy':
    default:
      return sparqlConnectionOptionsCopy;
  }
}

export async function querySudo(queryString, mode) {
  return mas.querySudo(
    sap.sparqlAutoPrefix(queryString),
    sparqlConnectionHeaders,
    connectionOptions(mode),
  );
}

export async function updateSudo(queryString, mode) {
  return mas.updateSudo(
    sap.sparqlAutoPrefix(queryString),
    sparqlConnectionHeaders,
    connectionOptions(mode),
  );
}
