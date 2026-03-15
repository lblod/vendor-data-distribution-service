# vendor-data-distribution-service

Service that copies hierarchical data to target graphs, based on configuration
that filters subjects on type and a trigger query (SPARQL `ASK` query). Target
graphs are fixed or calculated based on a general SPARQL `SELECT` query.
Properties for the subjects that need to be copied can be selected via
whitelisting, blacklisting, or with optionality.

This service works by listening to delta messages from the `delta-notifier` and
by copying configurable "pieces of information" (e.g. all data about entities,
or certain properties about linked entities) to a target graph. Normally,
`mu-authorization` takes care of controlling access to that data from then on.

A typical use case is for publishing data, meant for reading by vendors, to a
vendor graph. This graph is only accessible by those vendors and vendors can
only access their graph via SPARQL queries. E.g. a vendor reports a publication
and the automatic-submission-flow creates a bunch of related tasks, jobs,
submissions, files, ... about the publication. You can forward data about
specific subjects with this service into a graph that is only readable for that
vendor through `mu-authorization`.

Internally, this service uses a temporary graph to immediately write any
incoming subjects linked to a unique identifier. If any subject is repeated
over multiple delta messages, a new identifier is used every time. This
combination of subject and unique identifier "encodes" the fact that a delta
message for that subject has arrived. In this service, we call this an event.
Later, based on a CRON job or a timer that is set after a delta message, a
batch of events is processed simultaneously. Subjects can thus appear in that
batch with different identifiers, but are processed once for that batch. After
processing, the used combinations of subjects and identifiers are removed from
the temporary graph.

The reason for using unique identifiers is to allow for better and more correct
concurrency. Ingesting delta messages, and therefore writing subjects to the
temporary graph, can happen concurrently to processing events. If new deltas
arrive for a subject that is currently already being processed, the new event
in the temporary graph makes sure that the subject will be processed again in a
later batch, because new information might have become available. Batching
subjects for processing means that subjects are processed in much less
iterations, and meanwhile, ordering the batching queries by subject means that
subjects are processed in the least amount of batches (in stark contrast to
earlier behaviour of this service where every subject might have been processed
numerous times, because it would have been processed during every delta
message).

On top of all this, batch processing happens, by default (configurable), every
couple of minutes. This allows for all the delta messages of a subject to
arrive before attempting to process that subject. This prevents the situation
that not enough data is available at the time to correctly dispatch the
subject. There is also a CRON job that runs every hour (also configurable) to
clean up any leftover subjects in the temporary graph. This job also runs on
startup of the service.

## Adding to a stack

Add the `vendor-data-distribution-service` to a mu-semtech stack by inserting
the following snippet in the `docker-compose.yml` as a service:

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

**OPTIONAL:** for making sure the vendors can only read from their own graph,
you can configure `mu-authorization` with a specification like the following
(adapt to your needs):

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

Apart from the environment variables (see below), this service requires a
configuration file in RDF (Turtle), `/config/model.ttl`, with definitions of
models that need to be copied from source graphs to target graphs. This Turtle
file is read by a compliant RDF parser that also understands, among others,
N-Triples/Quads and Trig, but Turtle's syntax is all you need to benefit from
this service in its fullest.

This configuration is not typical linked data, in that this service will
automatically assume certain implicit default values for properties that are
not defined, and will throw an error if crucial properties are missing from the
configuration. Also, if a type property is missing on an entity, that entity
will be ignored. Make sure to follow the cardinality indication closely.

There are only 3 possible types in the configuration ontology for this service:

* Every top level entity in a hierarchy, and every isolated entity, is defined
as a `vdds:Class`.
* Every child element in a hierarchy is defined as a `vdds:Subclass`.
* Properties that connect entities within a hierarchy are defined as a
`vdds:HierarchyProperty`.

**NOTE on post processing:** you can provide SPARQL patterns for post
processing on the subjects in the target graphs for `vdds:Class` and
`vdds:Subclass`. This allows for full control of the resulting data. You can
just insert data (`INSERT DATA { ... }`) if you only provide an `INSERT`
pattern. Idem for a `DELETE` pattern. If you supply both an `INSERT` and
`DELETE` pattern, you also need to provide a `WHERE` pattern. The patterns
`${subject}` and `${targetgraph}` in the supplied strings are substituted with
their respective values. Inserts and deletes are automatically scoped to the
target graphs, so no need to include a `GRAPH ... { ... }` expression.

**NOTE on the use of prefixes:** any SPARQL pattern or full SPARQL query (like
`vdds:trigger`, `vdds:targetGraphQuery`, ...) can use the prefixes defined
globally at the top of the configuration. This service will automatically scan
every SPARQL pattern for the use of prefixes and include the definition at the
top of the query. If a SPARQL query already has its own prefixes, they won't be
included again, so you can shadow the globally defined prefixes per query. This
mechanism is optimistic: it will not throw errors if prefixes are missing, and
it might add too many prefixes (which shouldn't cause any harm), because it
doesn't try to fully parse a SPARQL query. Instead it just uses regular
expressions to try and find uses of prefixes, and it does this very
optimistically. (Better safe than sorry.)

Below follows a table for each of these of these types, with all possible
properties and value.

### `vdds:Class`

Main type of configuration entity. Create an instance of `vdds:Class` for every
top level type of subject you want to copy to target graphs.

**URI:** you can choose to use the RDF type of the subject as the URI in the
configuration. Alternatively, use a random URI e.g.
`http://something/interesting/1` and use the `vdds:type` property to define the
subject's underlying type.

These are the possible properties that the service responds to, with their
optionality and default values:

| Property                   | Cardinality | Description & Possible values    |
| -------------------------- | ----------- | -------------------------------- |
| `rdf:type`                 | 1           | Always needs to be `vdds:Class`. Having this type in the configuration file is a way for the service to identify hierarchies. |
| `vdds:type`                | 0 - 1       | Defines the actual type of the subject that needs to be copied to the target graphs. If this property is omitted, the URI of this entity is used as the `vdds:type` by default. |
| `vdds:property`            | 0 - n       | URIs of the properties on the subject that must be copied to the target graphs that all need to exist. Defaults to `vdds:allProperties`, a special URI that signals that all properties must be copied. |
| `vdds:excludeProperty`     | 0 - n       | URIs of the properties that must not be copied to the target graphs. This "blacklists" certain properties, on top of the `vdds:property` properties list. |
| `vdds:optionalProperty`    | 0 - n       | URIs of optional properties that may be copied to the target graphs. |
| `vdds:trigger`             | 0 - 1       | SPARQL pattern that will be placed directly in an `ASK` query. Can be used to filter subjects. This could be anything: filter on a certain predicate, if a certain other part of the hierarchy exists or has a certain property, ... Pattern `${subject}` is substituted by the URI of the subject under consideration at the moment. |
| `vdds:targetGraphQuery`    | 0 - 1       | A full SPARQL `SELECT` query that allows to retrieve variables for constructing the (multiple) target graphs. Can be optional if the target graph is static. The pattern `${subject}` is substituted for the URI of the subject. |
| `vdds:targetGraphTemplate` | 1           | Template string for the target graph URIs. Variables inside `${}` will be substituted by their respective values from the same variables in the `vdds:targetGraphQuery`. E.g. a string `http://target/graph/${var}` with target graph query like `SELECT ?var WHERE {...}`. |
| `vdds:postProcessDelete`   | 0 - 1       | Provide a SPARQL pattern that will be put in a `DELETE { ... }` expression. If no `INSERT` and `WHERE` patterns are given, this will cause the execution of a `DELETE DATA { ... }` query.
| `vdds:postProcessInsert`   | 0 - 1       | Idem as for `vdds:postProcessDelete`, but for an `INSERT` expression. |
| `vdds:postProcessWhere`    | 0 - 1       | Provide a `WHERE { ... }` SPARQL pattern. |

### `vdds:Subclass`

This is a child from a `vdds:Class`, or a child of another child, in the
hierarchy of the model. It has only a limited set of possible properties,
because the trigger, target graph query and consequently the target graph
template, can only be defined on the top most element of the hierarchy.

| Property                   | Cardinality | Description & Possible values    |
| -------------------------- | ----------- | -------------------------------- |
| `rdf:type`                 | 1           | Always needs to be `vdds:Subclass`. |
| `vdds:type`                | 0 - 1       | Defines the actual type of the subject that needs to be copied to the target graphs. If this property is omitted, the URI of this entity is used as the `vdds:type` by default. |
| `vdds:property`            | 0 - n       | URIs of the properties on the subject that must be copied to the target graphs that all need to exist. Defaults to `vdds:allProperties`, a special URI that signals that all properties must be copied. |
| `vdds:excludeProperty`     | 0 - n       | URIs of the properties that must not be copied to the target graphs. This "blacklists" certain properties, on top of the `vdds:property` properties list. |
| `vdds:optionalProperty`    | 0 - n       | URIs of optional properties that may be copied to the target graphs. |
| `vdds:postProcessDelete`   | 0 - 1       | Provide a SPARQL pattern that will be put in a `DELETE { ... }` expression. If no `INSERT` and `WHERE` patterns are given, this will cause the execution of a `DELETE DATA { ... }` query.
| `vdds:postProcessInsert`   | 0 - 1       | Idem as for `vdds:postProcessDelete`, but for an `INSERT` expression. |
| `vdds:postProcessWhere`    | 0 - 1       | Provide a `WHERE { ... }` SPARQL pattern. |

### `vdds:HierarchyProperty`

This entity connects `vdds:Class` and `vdds:Subclass` entities by encoding the
actual relationship between the represented subjects in the triplestore.

**NOTE:** domain and range of this entity should point to the configuration URI
of the `vdds:Class` and `vdds:Subclass`, and not the underlying `rdf:type` of
the represented subject.

| Property       | Cardinality | Description & Possible values                |
| -------------- | ----------- | -------------------------------------------- |
| `rdf:type`     | 1           | Always needs to be `vdds:HierarchyProperty`. |
| `rdfs:domain`  | 1           | Domain of the relationship. Use the configuration URI that represents the subject's type. |
| `rdfs:range`   | 1           | Range of the relationship. Use the configuration URI that represents the subject's type. |
| `vdds:inverse` | 0 - 1       | Wether this relation is inverted or not. Defaults to being undefined, which is `false`. |

### Configuration example

An example configuration file can be found in the config folder in this
repository. [See
here.](https://github.com/lblod/vendor-data-distribution-service/blob/master/config/model.ttl)

## Environment variables in configuration

It is possible to use environment variables in the configuration. Enclose any
variable whithin `#{}` and define them as an environment variable in the
`docker-compose.yml` file. These variable patterns are substituted at startup
of the service. If a variable is not defined, the service will throw and error
and will halt.

**IMPORTANT:** make sure environment variables are correctly set! The service
prints out its configuration as triples on the command line for inspection.

## Other environment variables

The following are environment variables that can be used to configure this
service. Supply a value for them using the `environment` keyword in the
`docker-compose.yml` file for this service.

* `NODE_ENV`: <em>(optional, default: "production", possible values:
  ["production", "development", ...])</em> on top of the regular Node behaviour
  for these modes, this service also opens test routes when running in
  development.
* `SPARQL_ENDPOINT_COPY_OPERATIONS`: <em>(optional, default:
  "http://database:8890/sparql")</em> the SPARQL endpoint for the queries that
  perform the copying of data to the target graph. As these queries can become
  costly, you could configure them to run on Virtuoso directly. Not to be
  confused with `MU_SPARQL_ENDPOINT`.
* `SPARQL_ENDPOINT_HEALING_OPERATIONS`: <em>(optional, default:
  "http://virtuoso:8890/sparql")</em> the SPARQL endpoint for the queries that
  perform the healing. <strong>Note: this defaults to Virtuoso directly! These
  operations are not supposed to cause delta-notifier messages and are supposed
  to run as fast as possible.</strong>
* `MU_SPARQL_ENDPOINT`: <em>(optional, default:
  "http://database:8890/sparql")</em> the regular endpoint for SPARQL
  queries. This will be overriden by the `SPARQL_ENDPOINT_COPY_OPERATIONS` and
  `SPARQL_ENDPOINT_HEALING_OPERATIONS` environment variables.
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
  subject-identifier combinations that will be batch processed at a time.
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

You can manually start the batch processing by calling the following endpoint.
This should normally not be necessary, because this is done during the cleanup
CRON job, and even that cleanup job should be redundant.

### POST `/process`

**Returns** `200` immediately, after which the processing will start.

## Healing

<strong>This healing implementation is somewhat rudimentary. Keep an eye on the
logs to track its progress.</strong>

### POST `/heal`

Query the triplestore for subjects of the types described in the configuration.
These subjects are processed as they normally are on incoming delta messages.

**Returns** `200` immediately, after which the healing will start.

Inspect the logs for progress.

**Trick:** filter command line logs for the keyword "HEALING" to get some nicer
output on the progress of the healing. E.g. `docker compose logs --tail 100 -f
vendor-data-distribution | grep 'HEALING'`.

### POST `/heal/configs`

Heal only a specific set of configurations. This can help speed up scenario's
where you know that only a specific configuration has changed.

**Body** *OPTIONAL* JSON with the following structure:

```json
{
  "configs": [ "http://rdf.myexperiment.org/ontologies/base/Submission" ]
}
```

* `configs`: <em>(optional, default: `[]`)</em> an array of URI's in
  string form that represent the configurations for which healing needs to be
  performed. Only subjects of these types will be queried from the triplestore
  and processed. When an empty array is given, or no JSON body at all, all
  configurations are processed, just like the `/heal` endpoint.

**Returns** `200` immediately, after which the healing will start.

### POST `/heal/subjects`

Heal only certain subjects. Can also be used to speed up certain scenario's, or
for testing out new configurations.

**Body** JSON with the following structure:

```json
{
  "subjects": [ "http://data.lblod.info/submissions/65F98FB2049CAEA56A94ACD5" ]
}
```

* `subjects`: an array of subject URI's in string form on which healing needs
  to be performed. Only these subjects will be healed. If no subjects are
  given, or there is no JSON body at all, nothing will happen.

## Testing

<strong>Testing is only possible when running this service in development mode.
Set the `NODE_ENV` environment variable to "development" to enable the test
route.</strong>

<strong>Testing does not fully simulate a real world scenario. It only tests
the mechanism behind the filtering of the messages and updating the graph in a
correct way. Always test with a real scenario with actual delta messages being
produced.</strong>

### GET `/test/start`

Starts a test scenario. A vendor is created in the triplestore, a test
submission with some related subjects (FormData, SubmissionDocument,
RemoteDataObjects) is inserted, and then a delta message is simulated on the
regular `/delta` endpoint. This is an asynchronous event, so inspect the logs
to see that the test data is correctly inserted, and that the delta message is
being proccessed. You should also wait for the timer to expire so that the
delta event is being processed before proceding with the assert step below. To
force processing events, use the endpoint from above (`/process`) to speed
things up.

**Response**

```json
{ "result": "Test data will be inserted and tests will start." }
```

### GET `/test/assert`

After starting the test and allowing it to finish processing, use this to
assert correct results. This queries the target graph for the created test
vendor, loads data from a file as a control, and compares the two. Passes the
test when the two are identical, or fails otherwise.

**Response**

```json
{ "result": "Passed" }
```

to indicate success, or

```json
{ "result": "FAILED" }
```

to indicate failure. If another response is returned, check the logs (enable
error logging) to start debugging.

### GET `/test/clean`

Cleans up all the test data from the triplestore, including the test vendor,
the test submission and related subjects, and the vendor graph.

**Response**

```json
{ "result": "Test data will be cleaned up." }
```

