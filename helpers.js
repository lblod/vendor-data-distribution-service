import * as rst from 'rdf-string-ttl';
import * as sjp from 'sparqljson-parse';
import * as mas from '@lblod/mu-auth-sudo';
import * as env from './env';
import * as N3 from 'n3';
import * as conf from './config/subjectsAndPaths';
const { namedNode } = N3.DataFactory;
const sparqlJsonParser = new sjp.SparqlJsonParser();
const sparqlConnectionHeaders = {
  'mu-call-scope-id': env.MU_SCOPE,
};
const sparqlConnectionOptions = {
  sparqlEndpoint: env.SPARQL_ENDPOINT_COPY_OPERATIONS,
  mayRetry: true,
};

/*
 * Gather distinct subjects from all the changes in the changesets.
 *
 * @function
 * @param {Array(Object)} changesets - This array contains JavaScript objects
 * that are in the regular delta message format from the delta-notifier.
 * @returns {Array(NamedNode)} An array with RDF terms for unique subjects.
 */
export function getAllUniqueSubjects(changesets) {
  const allSubjects = changesets
    .map((changeset) => {
      return changeset.inserts.concat(changeset.deletes);
    })
    .flat()
    .map((triple) => {
      return triple.subject.value;
    });
  const subjectStrings = [...new Set(allSubjects)];
  return subjectStrings.map(namedNode);
}

/*
 * Fetch types (rdf:type) for the subjects and filter them by the
 * configuration.
 *
 * @async
 * @function
 * @param {Array(NamedNode)} subjects - An array with subjects.
 * @returns {Array(Object)} An array of objects with the keys `subject`, `type`
 * and `config`, where `subject` points to a NamedNode from the input array
 * that is of interest. `type` is the `rdf:type` of that subject, and `config`
 * is the config object that matched with the subject.
 *
 * WARNING:
 *  - The current implementation works for deletes too, but that's
 *    mainly because the vendor-graph is not flushed when this function is
 *    called. So: be cautious when shuffling this function around
 */
export async function getAllWantedSubjects(subjects) {
  const response = await mas.querySudo(`
    PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>

    SELECT DISTINCT ?subject ?type WHERE {
      VALUES ?subject {
        ${subjects.map(rst.termToString).join(' ')}
      }
      ?subject rdf:type ?type .
    }
  `);
  const parsedResults = sparqlJsonParser.parseJsonResults(response);
  const wantedSubjects = [];

  for (const result of parsedResults) {
    const confs = conf.subjects.filter((s) => s.type === result.type.value);
    for (const conf of confs) {
      const triggerResponse = await mas.querySudo(`
        ASK {
          VALUES ?subject { ${rst.termToString(result.subject)} }
          ${conf.trigger}
        }`);
      const isTriggering = sparqlJsonParser.parseJsonBoolean(triggerResponse);
      if (isTriggering)
        wantedSubjects.push({
          subject: result.subject,
          type: result.type,
          config: conf,
        });
    }
  }
  return wantedSubjects;
}

/*
 * Get an object with information about the vendor that published a set of
 * data. Starting from the subject and its type (rdf:type).
 *
 * @async
 * @function
 * @param {NamedNode} subject - Represents the URI of the subject that is being
 * reported by the vendor we want the information about.
 * @param {NamedNode} type - Represents the URI of the type of the subject.
 * @returns {Object} An object with keys `vendor` and `organisation`, each
 * containing a new object with keys `id` and `uri` containing the mu:uuid and
 * the URI respectively. Returns undefined when no config for this subject is
 * found.
 */
export async function getVendorInfoFromSubject(subject, type, config) {
  if (config.path) {
    const response = await mas.querySudo(`
      ${env.SPARQL_PREFIXES}
      SELECT DISTINCT ?vendor ?vendorId ?organisation ?organisationId WHERE {
        VALUES ?subject { ${rst.termToString(subject)} }
        ${config.path}
        ?vendor
          muAccount:canActOnBehalfOf ?organisation ;
          mu:uuid ?vendorId .
        ?organisation
          mu:uuid ?organisationId .
      }
    `);
    const parsedResults = sparqlJsonParser.parseJsonResults(response);
    return parsedResults.map((r) => {
      return {
        vendor: {
          id: r?.vendorId,
          uri: r?.vendor,
        },
        organisation: {
          id: r?.organisationId,
          uri: r?.organisation,
        },
      };
    });
  }
}

export async function removeDataFromVendorGraph(
  subject,
  config,
  graph,
  conHeaders = sparqlConnectionHeaders,
  conOptions = sparqlConnectionOptions,
) {
  // No filter on graph in the where clause, we need to be able to delete
  // everything
  await mas.updateSudo(
    `
    DELETE {
      GRAPH <${graph}> {
        ${config.remove.delete}
      }
    }
    WHERE {
      VALUES ?subject { ${rst.termToString(subject)} }
      ${config.remove.where}
    }`,
    conHeaders,
    conOptions,
  );
}

export async function copyDataToVendorGraph(
  subject,
  config,
  graph,
  conHeaders = sparqlConnectionHeaders,
  conOptions = sparqlConnectionOptions,
) {
  await mas.updateSudo(
    `
    INSERT {
      GRAPH <${graph}> {
        ${config.copy.insert}
      }
    }
    WHERE {
      GRAPH ?g {
        VALUES ?subject { ${rst.termToString(subject)} }
        ${config.copy.where}
      }
      FILTER (REGEX(STR(?g), "^http://mu.semte.ch/graphs/organizations/"))
    }`,
    conHeaders,
    conOptions,
  );
}

export async function postProcess(
  subject,
  config,
  graph,
  conHeaders = sparqlConnectionHeaders,
  conOptions = sparqlConnectionOptions,
) {
  // No delete and insert → nothing to do
  if (!(config?.post?.delete || config?.post?.insert)) return;
  // No where → invalid post processing config
  if (!config?.post?.where) return;

  const deletePattern = config?.post?.delete
    ? `
    DELETE {
      GRAPH <${graph}> {
        ${config.post.delete}
      }
    }`
    : '';
  const insertPattern = config?.post?.insert
    ? `
    INSERT {
      GRAPH <${graph}> {
        ${config.post.insert}
      }
    }`
    : '';

  await mas.updateSudo(
    `
    ${deletePattern}
    ${insertPattern}
    WHERE {
      VALUES ?subject { ${rst.termToString(subject)} }
      GRAPH <${graph}> {
        ${config.post.where}
      }
    }
    `,
    conHeaders,
    conOptions,
  );
}
