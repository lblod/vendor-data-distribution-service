# vendor-data-distribution-service

Service to distribute data for the SPARQL endpoint to vendors in their own
designated accessible space.

This service works by listening to delta messages from the `delta-notifier` and
by forwarding configurable pieces of information into another graph that is
later only accessible for reading by the vendor that originally (indirectly)
created the data. `mu-authorization` takes care of controlling access via
SPARQL queries from there. E.g. a vendor reports a publication and the
automatic-submission-flow creates a bunch of related tasks, jobs, submissions,
files, ... about the publication. You can forward data about specific subjects
with this service into a graph that is only readable for that vendor through
`mu-authorization`.

## Adding to a stack

Add the vendor-data-distribution-service to a mu-semtech stack by inserting the
following snippet in the `docker-compose.yml` as a service:

```yaml
vendor-data-distribution:
  image: lblod/vendor-data-distribution-service:x.y.z
```

Because this service reacts to delta-messages, configure the `delta-notifier`
to forward certain types of data you want to include in the designated
accessible space for the vendor, by including a snippet like the following in
the `rules.js` file for the `delta-notifier` service.

```JavaScript
{
  match: {
    predicate: {
      type: 'uri',
      value: 'http://www.w3.org/ns/adms#status'
    }
  },
  callback: {
    url: 'http://vendor-data-distribution/delta',
    method: 'POST'
  },
  options: {
    resourceFormat: 'v0.0.1',
    gracePeriod: 1000,
    ignoreFromSelf: true
  }
}
```

For making sure the vendors can only read from their own graph, you can
configure `mu-authorization` with the following specification:

```elixir
defp access_for_vendor_api() do
  %AccessByQuery{
    vars: ["vendor_id", "session_group"],
    query: sparql_query_for_access_vendor_api()
  }
end

defp sparql_query_for_access_vendor_api() do
  " PREFIX muAccount: <http://mu.semte.ch/vocabularies/account/>
    PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
    SELECT DISTINCT ?vendor_id ?session_group WHERE {
      <SESSION_ID> muAccount:canActOnBehalfOf/mu:uuid ?session_group;
                   muAccount:account/mu:uuid ?vendor_id.
    } "
end

%GroupSpec{
  name: "o-vendor-api-r",
  useage: [:read],
  access: access_for_vendor_api(),
  graphs: [
    %GraphSpec{
      graph: "http://mu.semte.ch/graphs/vendors/",
      constraint: %ResourceConstraint{
        resource_types: [
          "http://rdf.myexperiment.org/ontologies/base/Submission",
          "http://mu.semte.ch/vocabularies/ext/SubmissionDocument",
          "http://lblod.data.gift/vocabularies/automatische-melding/FormData",
        ] } } ] },
```

## Configuration

Configuration about the interesting subject that need to be placed in the
vendor specific graph is done in a separate configuration file. The process of
selecting what data needs to be copied to the vendor graphs is done in multiple
steps. The service checks the type of the received subjects, checks if the
subjects match certain conditions and then executes remove and insert queries
to update the data about those subjects in the vendor graph. All of these need
to be configured. Create and mount via Docker the file in
`config/subjectsAndPaths.js` with content that looks like the following:

```javascript
export const subjects = [
  {
    type: 'http://rdf.myexperiment.org/ontologies/base/Submission',
    trigger: `
      ?subject a <http://rdf.myexperiment.org/ontologies/base/Submission> .
    `,
    path: `
      ?subject
        pav:createdBy ?organisation ;
        pav:providedBy ?vendor .
    `,
    remove: {
      delete: `
        ?subject ?p ?o .
      `,
      where: `
        ?subject ?p ?o .
      `,
    },
    copy: {
      insert: `
        ?subject ?p ?o .
      `,
      where: `
        ?subject ?p ?o .
      `,
    },
  },
];
```

Refer to this example file in the explanation below. This creates an Array with
JavaScript objects that have the following properties:

* `type`: property that indicates that subjects of this specific type
  (`rdf:type`) will be used to trigger a copy of data to the vendor specific
  graph. (E.g. we need to select all the subjects from the delta-notifier's
  messages that are of type Submission.)
* `trigger`: this is part of a SPARQL query where `?subject` is bound to the
  subject that matched the `type` property from above. This SPARQL query is put
  in an `ASK` pattern. If the pattern is satisfied, the subject is selected for
  copying to the vendor graph. (E.g. in this simple example, make sure that
  `?subject` is of the type Submission, which is trivially always true because
  that was already checked due to the `type` property).
* `path`: this is part of a SPARQL query where `?subject` is bound to the
  subject that matched the `type` property from above. Create a path to
  `?vendor` and `?organisation` entities so that the service can figure out in
  which graph to put the data for the vendor. This query can result in multiple
  vendor and organisation combinations. The data will be copied to all vendor
  graphs.
* `remove`: has subproperties `delete` and `where` that represent the bodies of
  the `DELETE {...} WHERE {...}` pattern. Use these SPARQL patterns to select
  the data that needs to be removed first before copying new data. This is to
  make sure stale data is removed. (E.g. remove all information about the
  Submission.)
* `copy`: has subproperties `insert` and `where` that represent the bodies of
  the `INSERT {...} WHERE {...}` pattern. Use these SPARQL patterns to select
  the data that needs to be copied to the vendor graph. (E.g. select all the
  information about the Submission to insert.)

The following are environment variables that can be used to configure this
service. Supply a value for them using the `environment` keyword in the
`docker-compose.yml` file for this service.

* `NODE_ENV`: <em>(optional, default: "production", possible values:
  ["production", "development", ...])</em> on top of the regular Node behaviour
  for these modes, this service only opens test routes when running in
  development.
* `SPARQL_ENDPOINT_COPY_OPERATIONS`: <em>(optional, default:
  "http://database:8890/sparql")</em> the SPARQL endpoint for the queries that
  perform the copying of data to the vendor graph. As these queries can become
  costly, you could configure them to run on Virtuoso directly. Not to be
  confused with `MU_SPARQL_ENDPOINT`.
* `SPARQL_ENDPOINT_HEALING_OPERATIONS`: <em>(optional, default:
  "http://virtuoso:8890/sparql")</em> the SPARQL endpoint for the queries that
  perform the healing. <strong>Note: this defaults to Virtuoso directly! These
  operations are not supposed to cause delta-notifier messages and are supposed
  to run as fast as possible.</strong>
* `MU_SPARQL_ENDPOINT`: <em>(optional, default:
  "http://database:8890/sparql")</em> the regular endpoint for SPARQL queries.
* `LOGLEVEL`: <em>(optional, default: "silent", possible values: ["error",
  "info", "silent"])</em> level of logging to the console.
* `WRITE_ERRORS`: <em>(optional, boolean as string, default: "false")</em> set
  to true to write errors to the database.
* `ERROR_GRAPH`: <em>(optional, URI for graph, default:
  "http://lblod.data.gift/errors")</em> graph in which to write errors to.
* `ERROR_BASE`: <em>(optional, URI, default:
  "http://data.lblod.info/errors/")</em> base for the URI of created errors.

## Healing

<strong>This healing implementation is somewhat crude. Keep an eye on the logs
to track its progress.</strong>

Healing will cause this service to query the triplestore for all elegible
subjects and copy their data to the vendor graph. From the existing config, the
`type`, `trigger` and `path` properties are used to find elegible subjects. Old
data is cleaned up with the `remove` property and new data is copied to the
vendor graph(s) with the `insert` property. Healing will thus do the exact same
thing as what otherwise would happen on a delta-message, but now the
triplestore is queried for elegible subjects instead.

To execute healing perform the following HTTP request:

### POST `/healing`

**Returns** `200` immediately, after which the healing will start.

Inspect the logs for progress.

## Testing

<strong>Testing is only possible when running this service in development mode.
Set the `NODE_ENV` environment variable to "development" to enable the test
route.</strong>

<strong>Testing does not fully simulate a real world scenario. It only tests
the mechanism behind the filtering of the messages and updating the graph in a
correct way. Always test with a real scenario with actual delta messages being
produced.</strong>

### GET `/test`

Example:

```bash
curl -v -X GET -b CookieJar.tsv -c CookieJar.tsv \
  http://localhost/vendor-data-distribution/test
```

This service can be tested (albeit a bit rudimentary) by calling the `/test`
route. There is a test data file in the `test` folder that contains a
collection of changesets (or delta messages), captures from a real run of the
automatic-submission-flow, that are executed one by one to simulate incoming
delta messages into a test graph that can be easily removed later. These delta
messages are then also processed like this service normally does to real delta
messages from the `delta-notifier`. The resulting data is then compared to the
other test data file in the `test` folder that should contain a know good
resulting state of the test data. When the data is different, the test should
fail. The third data file in the `test` folder contains the vendor information
that is used during testing. This data is otherwise fetched from the database.

**Response**

```json
{"result":"Passed"}
```

to indicate success, or

```json
{"result":"FAILED"}
```

to indicate failure. If another response is returned, check the logs (enable
error logging) to start debugging.
