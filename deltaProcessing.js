import * as rst from 'rdf-string-ttl';
import * as sjp from 'sparqljson-parse';
import * as mas from '@lblod/mu-auth-sudo';
import * as env from './env';
import * as N3 from 'n3';
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

  for (const subject of wantedSubjects) {
    //Warning: Order matters for the next call, see comment below!
    const vendorInfo = await getVendorInfoFromSubmission(subject);

    if (!vendorInfo.vendor.id) {
      console.log(
        `No vendor information found for submission ${rst.termToString(
          subject
        )}. Skipping.`
      );
      continue;
    }

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
 *    mainly because the vendor-graph is not flushed when this function is called
 *    So: be cautious when shuffling this function around
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
    if (env.INTERESTING_SUBJECT_TYPES.includes(result.type.value))
      wantedSubjects.push(result.subject);
  return wantedSubjects;
}

/*
 * Get an object with information about the vendor that published a set of
 * data. In this case, starting from a submission.
 *
 * @async
 * @function
 * @param {NamedNode} submission - Represents the URI of the submission that is
 * being reported by the vendor we want the information about.
 * @returns {Object} An object with keys `vendor` and `organisation`, each
 * containing a new object with keys `id` and `uri` containing the mu:uuid and
 * the URI respectively.
 *
 * NOTE
 *  - We might need to be able to get vendor info from different types of subjects in the future.
 *
 * WARNING:
 *  - The current implementation works for deletes too, but that's
 *    mainly because the vendor-graph is not flushed when this function is called
 *    So: be cautious when shuffling this function around
 */
async function getVendorInfoFromSubmission(submission) {
  const response = await mas.querySudo(`
    ${env.SPARQL_PREFIXES}
    SELECT DISTINCT ?vendor ?vendorId ?organisation ?organisationId WHERE {
      ${rst.termToString(submission)}
        pav:createdBy ?organisation;
        pav:providedBy ?vendor .
      ?vendor
        muAccount:canActOnBehalfOf ?organisation ;
        mu:uuid ?vendorId .
      ?organisation
        mu:uuid ?organisationId .
    }
  `);
  const sparqlJsonParser = new sjp.SparqlJsonParser();
  const parsedResults = sparqlJsonParser.parseJsonResults(response);

  return {
    vendor: {
      id: parsedResults[0]?.vendorId.value,
      uri: parsedResults[0]?.vendor.value,
    },
    organisation: {
      id: parsedResults[0]?.organisationId.value,
      uri: parsedResults[0]?.organisation.value,
    },
  };
}
