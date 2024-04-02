import * as rst from 'rdf-string-ttl';
import * as hel from './helpers';

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
  const allSubjects = hel.getAllUniqueSubjects(changesets);

  // Query all those subjects to see which are intersting according to a
  // configuration.
  const wantedSubjects = await hel.getAllWantedSubjects(allSubjects);

  if (wantedSubjects.length < 1)
    return {
      success: wasIngestSuccesful,
      reason: 'No subjects of interest in these changesets.',
    };

  for (const { subject, type, config } of wantedSubjects) {
    const vendorInfos = await hel.getVendorInfoFromSubject(
      subject,
      type,
      config,
    );

    if (!vendorInfos.length) {
      console.log(
        `No vendor information found for submission ${rst.termToString(
          subject,
        )}. Skipping.`,
      );
      continue;
    }

    for (const vendorInfo of vendorInfos) {
      const vendorGraph = `http://mu.semte.ch/graphs/vendors/${vendorInfo.vendor.id.value}/${vendorInfo.organisation.id.value}`;
      await hel.removeDataFromVendorGraph(subject, config, vendorGraph);
      await hel.copyDataToVendorGraph(subject, config, vendorGraph);
      await hel.postProcess(subject, config, vendorGraph);
    }

    wasIngestSuccesful = true;
  }
  return { success: wasIngestSuccesful };
}
