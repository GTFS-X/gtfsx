// Who a feed's feed_info.txt names as its publisher.
//
// Shared by the client exporter (src/services/gtfsExport.ts, the one ZIP
// builder behind download, publish, draft links and rollback) and the worker's
// publication sidecars (feed_info.json, dmfr.json, catalog metadata), so the
// published ZIP and the metadata served beside it can never disagree.
//
// Default: GTFS·X, the tool that builds and publishes the feed (product
// decision 2026-06-22). A publisher can opt in to naming itself instead
// (Agency → Feed Info → "Publish under my own name"), which sets
// `_publisher_override` on the feed state. Only an explicit opt-in counts: a
// feed_publisher_name that merely arrived with an import is shown as the prior
// publisher but never written to the export.

export const GTFSX_PUBLISHER_NAME = 'GTFS·X';
export const GTFSX_PUBLISHER_URL = 'https://gtfsx.com';

export interface FeedPublisherInput {
  feed_publisher_name?: unknown;
  feed_publisher_url?: unknown;
  _publisher_override?: unknown;
}

export interface FeedPublisher {
  name: string;
  url: string;
  /** True when the feed names its own publisher (the opt-in is on and both
   *  fields are filled in); false when it falls back to GTFS·X. */
  own: boolean;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function effectiveFeedPublisher(info: FeedPublisherInput | null | undefined): FeedPublisher {
  const name = str(info?.feed_publisher_name);
  const url = str(info?.feed_publisher_url);
  // Both required fields or neither: a half-filled override would export a
  // feed_info.txt missing a required field, so it falls back as a pair.
  if (info?._publisher_override === true && name && url) return { name, url, own: true };
  return { name: GTFSX_PUBLISHER_NAME, url: GTFSX_PUBLISHER_URL, own: false };
}
