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

Internally, this service uses a temporary graph to immediately write any
incoming subjects and a unique identifier for that subject. If any subject is
repeated over multiple delta messages, a new identifier is used every time.
This combination of subject and unique identifier "encodes" the fact that a
delta message for that subject has arrived. Later, based on a CRON job or a
timer that is set after a delta message, a batch of subjects is processed
simultaneously after querying for subjects and their identifiers. Subjects can
thus appear in that batch with different identifiers, but are processed once
for that batch. After processing, the used combinations of subjects and
identifiers are removed from the temporary graph.

The reason for using unique identifiers is to allow for better and more correct
concurrency. Ingesting delta messages, and therefore writing subjects to the
temporary graph, can happen concurrently to processing batches of subjects. If
new deltas arrive for a subject that is currently already being processed, the
combination of subject and identifier in the temporary graph make sure that it
will be processed again in a later batch. Batching subjects for processing
means that subjects are processed in much less iterations, and meanwhile,
ordering the batching queries by subject means that subjects are processed in
the least amount of batches (in stark contrast to earlier behaviour of this
service where every subject might have been processed numerous times, because
it would have been processed during every delta message).

On top of all this, batch processing happens, by default (configurable), every
couple of minutes. This allows for all the delta messages of a subject to
arrive before attempting to process that subject. This prevents the situation
that not enough data is available at the time to correctly dispatch the
subject. There is also a CRON job that runs every hour (also configurable) to
clean up any leftover subjects in the temporary graph. This job also runs on
startup of the service.

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

Because this service is going to create a lot of data, but in very specific
graphs that are not accessible to `mu-cl-resources`, you should also add the
`mu-call-scope-id` as an opt-out in the `delta-notifier` config for
`mu-cl-resources`. Without this opt-out, the service might have to endure heavy
loads of deltas that are not useful, wasting resources. To add this scope
identifier, make sure the config for `mu-cl-resources` has the
`optOutMuScopeIds` property like in the following example:

```JavaScript
{
  match: {},
  callback: {
    url: "http://resource/.mu/delta",
    method: "POST"
  },
  options: {
    resourceFormat: "v0.0.1",
    gracePeriod: 1000,
    ignoreFromSelf: true,
    optOutMuScopeIds: [
      "http://redpencil.data.gift/id/concept/muScope/deltas/vendor-data",
    ],
  }
},
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
to update the data about those subjects in the vendor graph. There is also an
optional post processing step on the subject in the vendor graph. All of these
need to be configured. Create and mount via Docker the file in
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
    post: {
      delete: `
        ?subject ?p ?o .
      `,
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
* `post`: (optional) has subproperties `delete`, `insert` and `where` that
  represent the bodies of a `DELETE {...} INSERT {...} WHERE {...}` pattern.
  This query is executed as post processing on the data in the vendor graph,
  with the variable `?subject` in the `where` bound to the subject that is
  matched in the previous steps. The `insert` and `delete` properties are
  optional, but cannot both be undefined. If the `post` property exists, a
  `where` subproperty also needs to exist to make this configuration valid. Use
  this step to translate predicates, add extra calculated predicates, ...

### Environment variables

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
* `MU_SCOPE`: <em>(optional, default:
  "http://redpencil.data.gift/id/concept/muScope/deltas/vendor-data")</em> this
  is the `mu-call-scope-id` that can be used in the `delta-notifier` config as
  an opt-out. See the `delta-notifier` setup above. If you bypass
  `mu-authorization` using some of the above environment variables, this scope
  id has no effect. It only affects queries through `mu-authorization` and the
  `delta-notifier`.
* `TEMP_GRAPH`: <em>(optional, default:
  "http://mu.semte.ch/graphs/vendor-data-distribution/temp")</em> graph for
  storing the temporary subject and identifier combinations for later batch
  processing.
* `PROCESSING_INTERVAL`: <em>(optional, default: 300000)</em> time in ms to
  wait after a delta message has arrived before starting the batch processing.
  Delta messages will only create a timer for this interval if no other timer
  is running. Set this timer interval low for fast processing, but the same
  subjects might be processed multiple times. Larger intervals allow more time
  for the delta messages to have settled and reduce the amount of reprocessing
  the same subjects.
* `PROCESSING_INTERVAL_SIZE`: <em>(optional, default: 100)</em> amount of
  subject-identifier combinations that will be batch processed at a time. Keep
  this relatively low (below 500), because otherwise delete queries become too
  large and fail.
* `CLEANUP_CRON`: <em>(optional, default: "30 * * * *")</em> periodic cleanup
  job timer. This performs a batch processing of subjects from the temporary
  graph. Can be kept to a minimum, because there should normally be no
  leftovers except in the event of catastrophic failure.
* `LOGLEVEL`: <em>(optional, default: "silent", possible values: ["error",
  "info", "silent"])</em> level of logging to the console.
* `WRITE_ERRORS`: <em>(optional, boolean as string, default: "false")</em> set
  to true to write errors to the database.
* `ERROR_GRAPH`: <em>(optional, URI for graph, default:
  "http://lblod.data.gift/errors")</em> graph in which to write errors to.
* `ERROR_BASE`: <em>(optional, URI, default:
  "http://data.lblod.info/errors/")</em> base for the URI of created errors.

## Manually start batch processing

You can manually start the batch processing by calling the following endpoint. This should normally not be necessary, because this is done during the cleanup CRON job, and even that cleanup job should be redundant.

### POST `/process-temp`

**Returns** `200` immediately, after which the processing will start.

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

**Body** *OPTIONAL* JSON with the following structure:

```json
{
  "skipDeletes": true,
  "onlyTheseTypes": [ "http://rdf.myexperiment.org/ontologies/base/Submission" ]
}
```

* `skipDeletes`: <em>(optional, default: `false`)</em> if set to `true`, the
  deletes are not executed. This is usually used on an initial healing when
  there is nothing to delete. Generally used when nothing has changed, but only
  incrementally added (e.g. a new vendor, an new type to copy to the vendors,
  ...).
* `onlyTheseTypes`: <em>(optional, default: `[]`)</em> an array of IRI's in
  string form that represent the type, as defined in the config, to copy to the
  vendor. This can speed up the healing when only one type is needed (e.g. when
  the config items overlap). When empty, all types are copied to the vendor
  graph.

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
