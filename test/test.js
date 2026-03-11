import * as fs from 'fs/promises';
import * as rst from 'rdf-string-ttl';
import * as sjp from 'sparqljson-parse';
import * as ss from '../util/sparql-sudo';
import * as env from '../env';
import * as hel from '../util/helpers';
import * as N3 from 'n3';
import * as sts from '../util/storeToTriplestore';
import * as msg from './DeltaMessages';
import * as http from 'node:http';
import { Buffer } from 'node:buffer';
const { namedNode } = N3.DataFactory;

export async function prepareAndStart() {
  const parser = new N3.Parser({ format: 'application/trig' });

  const testData = (await fs.readFile('./test/TestData.trig')).toString();
  const testDataStore = new N3.Store();
  const testDataQuads = parser.parse(testData);
  testDataStore.addQuads(testDataQuads);

  const vendorData = (await fs.readFile('./test/VendorData.trig')).toString();
  const vendorDataStore = new N3.Store();
  const vendorDataQuads = parser.parse(vendorData);
  vendorDataStore.addQuads(vendorDataQuads);

  await sts.insertData(testDataStore);
  await sts.insertData(vendorDataStore);

  // const deltaMessage = JSON.stringify(msg.changesetsSubmission);
  const deltaMessage = JSON.stringify(msg.changesetsPhysicalFile);

  const req = http.request('http://localhost/delta', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Lenght': Buffer.byteLength(deltaMessage),
    },
  });
  req.write(deltaMessage);
  req.end();
}

export async function assert() {
  const vendorGraph = namedNode(
    'http://mu.semte.ch/graphs/vendors/aaaa-bbbb-cccc-1111-2222-3333/28346950e285b8b816133fece5ac9408097c3f190c7f32573cf0c640d6c34b1a',
  );
  const allVendorData = await sts.getData(vendorGraph);

  const parser = new N3.Parser({ format: 'application/trig' });
  const resultData = (await fs.readFile('./test/ResultData.trig')).toString();
  const resultDataStore = new N3.Store();
  const resultDataQuads = parser.parse(resultData);
  resultDataStore.addQuads(resultDataQuads);

  const resultDataStoreWOGraphs = new N3.Store();
  resultDataStore.forEach((q) =>
    resultDataStoreWOGraphs.addQuad(q.subject, q.predicate, q.object),
  );
  const allVendorDataWOGraphs = new N3.Store();
  allVendorData.forEach((q) =>
    allVendorDataWOGraphs.addQuad(q.subject, q.predicate, q.object),
  );

  const { left, right } = hel.compareStores(
    resultDataStoreWOGraphs,
    allVendorDataWOGraphs,
  );

  if (left.size === 0 && right.size === 0) {
    console.log('Test passed');
    return true;
  } else {
    console.log(
      `Test failed with a difference of ${left.size} and ${right.size} number of triples in the expected data and vendor graph data respectively.`,
    );
    return false;
  }
}

export async function cleanUp() {
  const parser = new N3.Parser({ format: 'application/trig' });

  const testData = (await fs.readFile('./test/TestData.trig')).toString();
  const testDataStore = new N3.Store();
  const testDataQuads = parser.parse(testData);
  testDataStore.addQuads(testDataQuads);

  const vendorData = (await fs.readFile('./test/VendorData.trig')).toString();
  const vendorDataStore = new N3.Store();
  const vendorDataQuads = parser.parse(vendorData);
  vendorDataStore.addQuads(vendorDataQuads);

  await sts.deleteData(testDataStore);
  await sts.deleteData(vendorDataStore);

  await ss.updateSudo(`
    DELETE {
      GRAPH <http://mu.semte.ch/graphs/vendors/aaaa-bbbb-cccc-1111-2222-3333/28346950e285b8b816133fece5ac9408097c3f190c7f32573cf0c640d6c34b1a> {
        ?s ?p ?o .
      }
    }
    WHERE {
      GRAPH <http://mu.semte.ch/graphs/vendors/aaaa-bbbb-cccc-1111-2222-3333/28346950e285b8b816133fece5ac9408097c3f190c7f32573cf0c640d6c34b1a> {
        ?s ?p ?o .
      }
    }
  `);
}

/******************************************************************************
 * Deprecate all below this line
 *****************************************************************************/

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
  await ss.updateSudo(`
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
  await ss.updateSudo(`
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
  await ss.updateSudo(updateQuery);
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
  const response = await ss.querySudo(`
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
  hel.compareStores(toCheckStore, testResultStore);

  return toCheckStore.size === 0 && testResultStore.size === 0;
}
