import * as fs from 'fs/promises';
import * as rst from 'rdf-string-ttl';
import * as sjp from 'sparqljson-parse';
import * as mas from '@lblod/mu-auth-sudo';
import * as env from '../env';
import * as N3 from 'n3';
const { namedNode } = N3.DataFactory;

/*
 * **TEST ONLY** Clears the data from the graphs used for testing..
 *
 * @public
 * @async
 * @function
 * @param {Object} vendorInfo - A JavaScript object with stucture `{ vendor: {
 * id, uri }, organisation: { id, uri } }` containing the information about the
 * vendor that was responsible for reporting this amount of information.
 * @returns {undefined} Nothing
 */
export async function clearTestData(vendorInfo) {
  const vendorGraph = namedNode(
    `http://mu.semte.ch/graphs/vendors/${vendorInfo.vendor.id}/${vendorInfo.organisation.id}`,
  );
  await mas.updateSudo(`
    DELETE {
      GRAPH <http://mu.semte.ch/graphs/vendorsTest> {
        ?s ?p ?o .
      }
    }
    WHERE {
      GRAPH <http://mu.semte.ch/graphs/vendorsTest> {
        ?s ?p ?o .
      }
    }`);
  await mas.updateSudo(`
    ${env.SPARQL_PREFIXES}
    DELETE {
      GRAPH ${rst.termToString(vendorGraph)} {
        ?s ?p ?o .
      }
    }
    WHERE {
      GRAPH ${rst.termToString(vendorGraph)} {
        ?s ?p ?o .
      }
    }`);
}

/*
 * **TEST ONLY** Performs the same as `updateData` but only on a specific
 * graph. This is used to simulate the original data inserted in the
 * organisation's graph.
 *
 * @public
 * @async
 * @function
 * @see {@link updateData}
 */
export async function updateDataInTestGraph(deleteColl, insertColl) {
  const deleteWriter = new N3.Writer();
  const insertWriter = new N3.Writer();
  deleteColl.forEach((q) =>
    deleteWriter.addQuad(q.subject, q.predicate, q.object),
  );
  insertColl.forEach((q) =>
    insertWriter.addQuad(q.subject, q.predicate, q.object),
  );
  const deleteTriples = await new Promise((resolve, reject) => {
    deleteWriter.end((err, result) => {
      if (err) reject(err);
      resolve(result);
    });
  });
  const insertTriples = await new Promise((resolve, reject) => {
    insertWriter.end((err, result) => {
      if (err) reject(err);
      resolve(result);
    });
  });
  const updateQuery = `
    ${env.SPARQL_PREFIXES}
    DELETE {
      GRAPH <http://mu.semte.ch/graphs/vendorsTest> {
        ${deleteTriples}
      }
    }
    INSERT {
      GRAPH <http://mu.semte.ch/graphs/vendorsTest> {
        ${insertTriples}
      }
    }
    WHERE {}`;
  await mas.updateSudo(updateQuery);
}

/*
 * **TEST ONLY** Fetches data from the vendor graph after delta messages have
 * been processed and compares it with a static data file. Returns a boolean to
 * indicate a difference in the data. The test should suceed if there is no
 * difference.
 *
 * @public
 * @async
 * @function
 * @param {Object} vendorInfo - A JavaScript object with stucture `{ vendor: {
 * id, uri }, organisation: { id, uri } }` containing the information about the
 * vendor that was responsible for reporting this amount of information.
 * @returns {Boolean} True if the data contains no difference to the static
 * result data, false if there is a difference and the test fails.
 */
export async function assertCorrectTestDeltas(vendorInfo) {
  // Fetch all data from vendor graph into store
  const vendorGraph = namedNode(
    `http://mu.semte.ch/graphs/vendors/${vendorInfo.vendor.id}/${vendorInfo.organisation.id}`,
  );
  const response = await mas.querySudo(`
    ${env.SPARQL_PREFIXES}
    CONSTRUCT {
      ?s ?p ?o .
    } WHERE {
      GRAPH ${rst.termToString(vendorGraph)} {
        ?s ?p ?o .
      }
    }
  `);
  const sparqlJsonParser = new sjp.SparqlJsonParser();
  const parsedResults = sparqlJsonParser.parseJsonResults(response);
  const toCheckStore = new N3.Store();
  parsedResults.forEach((binding) =>
    toCheckStore.addQuad(binding.s, binding.p, binding.o),
  );

  // Make store from test data results file
  const testResult = await fs.readFile('/app/test/TestData.ttl', {
    encoding: 'utf-8',
  });
  const testResultStore = new N3.Store();
  const parser = new N3.Parser({ format: 'text/turtle' });
  parser.parse(testResult).forEach((t) => testResultStore.addQuad(t));

  // Compare stores, nothing should be different
  compareStores(toCheckStore, testResultStore);

  return toCheckStore.size === 0 && testResultStore.size === 0;
}

/*
 * Compare two stores. Identical triples are **destructively** removed from
 * both stores. The result is the original store with the triples that are
 * removed or updated, and the result store with only triples that are inserted
 * or updated.
 *
 * @function
 * @param {N3.Store} originalStore - The store with initial, already known
 * data.
 * @param {N3.Store} resultStore - The store that has been modified from the
 * original store.
 * @returns {{ toRemoveStore: N3.Store, toInsertStore: N3.Store }} An object
 * with two stores, one with data that is removed or updated and one with
 * inserted or updated data.
 */
export function compareStores(originalStore, resultStore) {
  // Make copy of second store, because if we already start removing things, we
  // will never be able to remove all intersecting triples.
  const resultStoreCopy = new N3.Store();
  resultStore.forEach((q) => resultStoreCopy.addQuad(q));

  originalStore.forEach((q) => resultStore.removeQuad(q));
  resultStoreCopy.forEach((q) => originalStore.removeQuad(q));
  return { toRemoveStore: originalStore, toInsertStore: resultStore };
}
