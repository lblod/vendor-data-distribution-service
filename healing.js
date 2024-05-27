import * as env from './env';
import * as hel from './helpers';
import * as mas from '@lblod/mu-auth-sudo';
import * as conf from './config/subjectsAndPaths';
import * as rst from 'rdf-string-ttl';
import * as sjp from 'sparqljson-parse';
const sparqlJsonParser = new sjp.SparqlJsonParser();
import * as N3 from 'n3';
const { namedNode } = N3.DataFactory;
const sparqlConnectionHeaders = {
  'mu-call-scope-id': env.MU_SCOPE,
};
const sparqlConnectionOptions = {
  sparqlEndpoint: env.SPARQL_ENDPOINT_HEALING_OPERATIONS,
  mayRetry: true,
};

export async function heal(skipDeletes, onlyTypes) {
  for (const config of conf.subjects) {
    const { type, trigger, path } = config;

    // Only proceed if a filter on type exists and if the current type is in
    // the list, or if no filter exists.
    if (onlyTypes.length > 0)
      if (!onlyTypes.includes(type)) {
        console.log(
          `Skipping type ${type} because there is a filter and it is not in the filter [${onlyTypes.join(', ')}]`,
        );
        continue;
      }

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
      sparqlConnectionHeaders,
      sparqlConnectionOptions,
    );
    const parsedResults = sparqlJsonParser.parseJsonResults(response);

    // For each subject that is elegible for the vendor graph, move its data to it
    for (let i = 0; i < parsedResults.length; i++) {
      const entry = parsedResults[i];
      const vendorGraph = `http://mu.semte.ch/graphs/vendors/${entry.vendorId.value}/${entry.organisationId.value}`;
      if (!skipDeletes)
        await hel.removeDataFromVendorGraph(
          entry.subject,
          config,
          vendorGraph,
          sparqlConnectionHeaders,
          sparqlConnectionOptions,
        );
      await hel.copyDataToVendorGraph(
        entry.subject,
        config,
        vendorGraph,
        sparqlConnectionHeaders,
        sparqlConnectionOptions,
      );
      await hel.postProcess(
        entry.subject,
        config,
        vendorGraph,
        sparqlConnectionHeaders,
        sparqlConnectionOptions,
      );

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
