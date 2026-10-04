/**
 * Unpublish confirm and result copy (W2-07). The server cancels a pending
 * scheduled publish when the feed is unpublished, so the cron can't put the
 * feed back up; the confirm says so when one is pending.
 */
const BASE_BODY =
  'The canonical URL will return 404 until you publish again. Existing downstream consumers (Google Maps, Transit app, etc.) may stop receiving updates.';

/** `pendingScheduleLabel` is the formatted fire time of a pending scheduled
 *  publish, or null when none is pending. */
export function unpublishConfirmBody(pendingScheduleLabel: string | null): string {
  if (!pendingScheduleLabel) return BASE_BODY;
  return `${BASE_BODY} The scheduled publish for ${pendingScheduleLabel} will be cancelled.`;
}

/** "Current publication" when nothing is live: "yet" only if it never was. */
export function notPublishedLabel(hasPublicationHistory: boolean): string {
  return hasPublicationHistory ? 'Not published.' : 'Not published yet.';
}

export function unpublishDoneMessage(hadPendingSchedule: boolean): string {
  return hadPendingSchedule
    ? 'Feed unpublished. The canonical URL now returns 404, and the scheduled publish was cancelled.'
    : 'Feed unpublished. The canonical URL now returns 404.';
}
