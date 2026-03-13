import * as cm from './config-manager';
import * as rst from 'rdf-string-ttl';

/**
 * Transparantly include prefixes at the top of the query that exist in the
 * configuration. Uses some regular expressions to find uses of prefixes in the
 * query. It won't repeat prefixes that are already defined in the query.
 * (Because you might want to override a prefix.)
 *
 * It won't try to parse the given string as a SPARQL query! That would be too
 * complicated for this purpose. Just some optimistic search patterns, and we
 * tolerate the inclusion of redundant prefixes by accident.
 *
 * This mechanism is optimistic. No errors thrown, potentially too many
 * prefixes added.
 * For example: triple pattern
 *   `<subj> rdfs:description "Happy birthday:my friend!"`
 * will trigger a search for prefix `birthday:`, which does not exists, but it
 * won't complain about this.
 *
 * @public
 * @function
 * @param {String} query - A normal SPARQL query that might have some
 * unresolved uses of prefixes.
 * @returns {String} Query with some extra `PREFIX ...` definitions at the top.
 */
export function sparqlAutoPrefix(query) {
  let prefixesAlreadyDefinedInQuery = [];
  // RegExp (case insensitive, all matches): finds `PREFIX abc: <something>`
  // and captures `abc`. `(?<=)` indicates positive lookbehind.
  const definedPrefixRegex = /(?<=prefix\s+)(\w+):/gi;
  for (const match of query.matchAll(definedPrefixRegex))
    prefixesAlreadyDefinedInQuery.push(match[1]);

  let prefixes = {};
  // RegExp: finds all `abc:something` (uses of prefixes that are not part of a
  // prefix definition) and captures `abc`.
  // `(?<!)` indicates negative lookbehind.
  const undefinedPrefixRegex = /(?<!prefix\s+)(?<=\W)(\w+):/gi;
  for (const match of query.matchAll(undefinedPrefixRegex))
    if (!prefixesAlreadyDefinedInQuery.find((pref) => pref === match[1]))
      if (cm.PREFIXES.has(match[1]))
        prefixes[match[0]] = cm.PREFIXES.get(match[1]);
  const prefixesString = Object.keys(prefixes)
    .map((key) => `PREFIX ${key} ${rst.termToString(prefixes[key])}`)
    .join('\n');
  return prefixesString.length > 0 ? `${prefixesString}\n${query}` : query;
}
