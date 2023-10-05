import * as rst from 'rdf-string-ttl';
import * as sjp from 'sparqljson-parse';
import * as mas from '@lblod/mu-auth-sudo';
import * as env from './env';
import * as N3 from 'n3';
import * as conf from './config/subjectsAndPaths';
const { namedNode } = N3.DataFactory;

/*
 * Takes delta messages, filters subjects, fetches already known data for those
 * subjects, replays delta messages, calculates differences, and only inserts
 * the changed data.
 *
 * @public
 * @async
 * @function
 * @param {Array(Object)} changesets - This array contains JavaScript object is
 * are the regular delta message format from the delta-notifier.
 * @returns {Object} A result object with the key `success` to indicate a
 * successful ingestion of the changesets (true) or when there is nothing to
 * ingest or vendor information is not correct (false). The `reason` key is a
 * String with a message as to why no ingestion took place.
 */
export async function processDelta(changesets) {
  let wasIngestSuccesful = false; // Keep track of the state to return to caller.

  // Filter all subjects (just all subjects, filter later which ones needed)
  const allSubjects = getAllUniqueSubjects(changesets);

  // Query all those subjects to see which are intersting according to a
  // configuration.
  //Warning: Order matters for the next call, see comment below!
  const wantedSubjects = await getAllWantedSubjects(allSubjects);

  if (wantedSubjects.length < 1)
    return {
      success: wasIngestSuccesful,
      reason: 'No subjects of interest in these changesets.',
    };

  for (const { subject, type } of wantedSubjects) {
    //Warning: Order matters for the next call, see comment below!
    const vendorInfos = await getVendorInfoFromSubject(subject, type);

    if (!vendorInfos.length) {
      console.log(
        `No vendor information found for submission ${rst.termToString(
          subject,
        )}. Skipping.`,
      );
      continue;
    }

    for (const vendorInfo of vendorInfos) {
      const vendorGraph = `http://mu.semte.ch/graphs/vendors/${vendorInfo.vendor.id}/${vendorInfo.organisation.id}`;
      const deleteQuery = `
         DELETE {
          GRAPH <${vendorGraph}> {
            ?s ?p ?o.
          }
         }
         WHERE {
           VALUES ?s {
             ${rst.termToString(subject)}
           }
          GRAPH <${vendorGraph}> {
            ?s ?p ?o.
          }
         }
      `;
      await mas.updateSudo(deleteQuery);

      const insertQuery = `
         INSERT {
           GRAPH <${vendorGraph}> {
             ?s ?p ?o.
           }
         }
         WHERE {
           VALUES ?s {
             ${rst.termToString(subject)}
           }
           ?s ?p ?o.
         }
      `;
      await mas.updateSudo(insertQuery);
    }

    wasIngestSuccesful = true;
  }
  return { success: wasIngestSuccesful };
}

/*
 * Gather distinct subjects from all the changes in the changesets.
 *
 * @function
 * @param {Array(Object)} changesets - This array contains JavaScript objects
 * that are in the regular delta message format from the delta-notifier.
 * @returns {Array(NamedNode)} An array with RDF terms for unique subjects.
 */
// Returns RDF terms per subject
function getAllUniqueSubjects(changesets) {
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
 * @returns {Array(NamedNode)} Same as input parameter, but filtered.
 *
 * WARNING:
 *  - The current implementation works for deletes too, but that's
 *    mainly because the vendor-graph is not flushed when this function is
 *    called. So: be cautious when shuffling this function around
 */
async function getAllWantedSubjects(subjects) {
  const response = await mas.querySudo(`
    PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>

    SELECT DISTINCT ?subject ?type WHERE {
      ?subject rdf:type ?type .
      VALUES ?subject {
        ${subjects.map(rst.termToString).join(' ')}
      }
    }
  `);
  const parser = new sjp.SparqlJsonParser();
  const parsedResults = parser.parseJsonResults(response);

  const wantedSubjects = [];
  for (const result of parsedResults)
    if (conf.subjects.find((s) => s.type === result.type.value))
      wantedSubjects.push({ subject: result.subject, type: result.type });
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
async function getVendorInfoFromSubject(subject, type) {
  const path = conf.subjects.find((s) => s.type === type.value)?.path;
  if (path) {
    const response = await mas.querySudo(`
      ${env.SPARQL_PREFIXES}
      SELECT DISTINCT ?vendor ?vendorId ?organisation ?organisationId WHERE {
        BIND (${rst.termToString(subject)} AS ?subject)
        ${path}
        ?vendor
          muAccount:canActOnBehalfOf ?organisation ;
          mu:uuid ?vendorId .
        ?organisation
          mu:uuid ?organisationId .
      }
    `);
    const sparqlJsonParser = new sjp.SparqlJsonParser();
    const parsedResults = sparqlJsonParser.parseJsonResults(response);
    return parsedResults.map((r) => {
      return {
        vendor: {
          id: r?.vendorId.value,
          uri: r?.vendor.value,
        },
        organisation: {
          id: r?.organisationId.value,
          uri: r?.organisation.value,
        },
      };
    });
  }
}
