import { useStore } from '../../store';
import { importGtfsZip, loadImportIntoStore } from '../../services/gtfsImport';
import { trackFeedImportFailed, trackFeedOpened } from '../../services/trackBeacon';

// /demo pulls from the canonical published feed at feeds.gtfsx.com/svt-demo/
// rather than a bundled streamline.zip — keeps the demo in sync with the
// published Sunny Valley Transit example and matches the slug the embed
// example site uses, so /demo and /embed-demo always show the same data.
//
// `signal` is aborted when the user leaves /demo. A load that resolves after
// that must not touch the store: it would land in whatever editor they moved to
// (C3-18).
export async function loadDemoFeed(signal?: AbortSignal) {
  // Split fetch from parse so a failure records WHICH half broke. Until now a
  // /demo that never loaded was logged to console.error and nowhere else — an
  // ad click landing on a silently empty editor looked identical to a bounce.
  let file: File;
  try {
    const res = await fetch('https://feeds.gtfsx.com/svt-demo/gtfs.zip', { signal });
    if (!res.ok) throw new Error('Demo feed not found');
    const blob = await res.blob();
    file = new File([blob], 'svt-demo.zip', { type: 'application/zip' });
  } catch (e) {
    if (signal?.aborted) return;
    trackFeedImportFailed('demo', 'fetch');
    throw e;
  }
  if (signal?.aborted) return;
  let data: Awaited<ReturnType<typeof importGtfsZip>>;
  try {
    data = await importGtfsZip(file);
  } catch (e) {
    if (signal?.aborted) return;
    trackFeedImportFailed('demo', 'parse');
    throw e;
  }
  if (signal?.aborted) return;
  loadImportIntoStore(data);
  useStore.getState().setProjectName('Sunny Valley Transit');
  // Loading is not "editing" — clear the dirty flag so the beforeunload
  // prompt doesn't fire on refresh until the user actually changes something.
  useStore.getState().markSaved();
  trackFeedOpened('demo');
}
