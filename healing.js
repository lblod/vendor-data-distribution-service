import * as env from './env';
import * as hel from './helpers';
import * as mas from '@lblod/mu-auth-sudo';
import * as conf from './config/subjectsAndPaths';
import * as rst from 'rdf-string-ttl';
import * as sjp from 'sparqljson-parse';
const sparqlJsonParser = new sjp.SparqlJsonParser();
import * as N3 from 'n3';
const { namedNode } = N3.DataFactory;
const connectionOptions = {
  sparqlEndpoint: env.SPARQL_ENDPOINT_HEALING_OPERATIONS,
  mayRetry: true,
};

export async function heal() {
  for (const config of conf.subjects) {
    const { type, trigger, path } = config;

    // Construct one combined query, what otherwise happens on a delta
    const response = await mas.querySudo(
      `
      ${env.SPARQL_PREFIXES}

      SELECT DISTINCT ?subject ?vendor ?vendorId ?organisation ?organisationId
      WHERE {
        GRAPH ?g {
          ?subject rdf:type ${rst.termToString(namedNode(type))} .
          ${trigger}
        }
        FILTER (REGEX(STR(?g), "^http://mu.semte.ch/graphs/organizations/"))
        ${path}
        ?vendor
          muAccount:canActOnBehalfOf ?organisation ;
          mu:uuid ?vendorId .
        ?organisation
          mu:uuid ?organisationId .
      }
    `,
      undefined,
      connectionOptions,
    );
    const parsedResults = sparqlJsonParser.parseJsonResults(response);

    // For each subject that is elegible for the vendor graph, move its data to it
    for (let i = 0; i < parsedResults.length; i++) {
      const entry = parsedResults[i];
      const vendorGraph = `http://mu.semte.ch/graphs/vendors/${entry.vendorId.value}/${entry.organisationId.value}`;
      await hel.removeDataFromVendorGraph(entry.subject, config, vendorGraph);
      await hel.copyDataToVendorGraph(entry.subject, config, vendorGraph);

      //Nice logging
      const percentage = Math.round(((i + 1) * 100) / parsedResults.length);
      console.log(
        `Processed ${i + 1}/${
          parsedResults.length
        } (${percentage}%) of type ${type}`,
      );
    }
  }
}
