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
  image: lblod/vendor-data-distribution-service:1.0.0
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
vendor specific graph is done in a separate configuration file. Create and
mount via Docker the file in `config/subjectsAndPaths.js` with content that
looks like the following:

```javascript
export const subjects = [
  {
    type: 'http://rdf.myexperiment.org/ontologies/base/Submission',
    path: `
      ?subject
        pav:createdBy ?organisation ;
        pav:providedBy ?vendor .
    `,
  },
];
```

This creates an Array with JavaScript objects that have a `type` and `path`
property. The `type` property indicates that subjects of this specific type
(`rdf:type`) are interesting to the Vendor and all information for this subject
will be copied to the vendor specific graph. The `path` property supplies a
string that is used in SPARQL queries to find the `vendor` and `organisation`.
These will be used to recontruct the vendor specific graph to put the data in.

The following are environment variables that can be used to configure this
service. Supply a value for them using the `environment` keyword in the
`docker-compose.yml` file for this service.

* `NODE_ENV`: <em>(optional, default: "production", possible values:
  ["production", "development", ...])</em> on top of the regular Node behaviour
  for these modes, this service only opens test routes when running in
  development.
* `LOGLEVEL`: <em>(optional, default: "silent", possible values: ["error",
  "info", "silent"])</em> level of logging to the console.
* `WRITE_ERRORS`: <em>(optional, boolean as string, default: "false")</em> set
  to true to write errors to the database.
* `ERROR_GRAPH`: <em>(optional, URI for graph, default:
  "http://lblod.data.gift/errors")</em> graph in which to write errors to.
* `ERROR_BASE`: <em>(optional, URI, default:
  "http://data.lblod.info/errors/")</em> base for the URI of created errors.

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
