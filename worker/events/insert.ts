// Shared `event` INSERT. One place owns the column list so the two write
// paths — the client beacon endpoint (worker/events/routes.ts) and
// server-side conversion events like the demo_request lead-form submit
// (worker/marketing/demoLead.ts) — can't drift.
//
// Same privacy contract as the beacon: no IP, no User-Agent, no user id
// stored. See worker/migrations/0007_events.sql.
//
// One narrow exception, added 2026-08: `emailSha256`. Conversion rows may carry
// hex(sha256(normalized_email)) so the Google Ads uploader can send a hashed
// user identifier alongside the ad click id (worker/marketing/ads/
// userIdentifiers.ts, migration 0032). It is a one-way digest computed by the
// caller — a plaintext address is never passed to, or stored by, this module,
// and no user id or session→account link is written either.

import { ulid } from 'ulidx';

export interface EventInsert {
  kind: string;
  path: string;
  ref?: string | null;
  // `event.session_id` is NOT NULL — callers without a client beacon session
  // (server-side events) mint a random one per event.
  sessionId: string;
  country?: string | null;
  label?: string | null;
  gclid?: string | null;
  // gbraid / wbraid: Google Ads' privacy-safe click ids (iOS app→web / web→web
  // under consent limits) — carried alongside gclid; a row may have any one.
  gbraid?: string | null;
  wbraid?: string | null;
  // hex(sha256(normalized email)) — ALREADY HASHED by the caller via
  // worker/marketing/ads/userIdentifiers.ts#hashEmailHex. Never a plaintext
  // address. Only set on the four Google Ads conversion kinds; every other
  // event kind leaves it NULL.
  emailSha256?: string | null;
}

export async function insertEvent(db: D1Database, e: EventInsert): Promise<void> {
  await db
    .prepare(
      `INSERT INTO event (id, ts, kind, path, ref, session_id, country, label, gclid, gbraid, wbraid, oci_email_sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      ulid(),
      Date.now(),
      e.kind,
      e.path,
      e.ref ?? null,
      e.sessionId,
      e.country ?? null,
      e.label ?? null,
      e.gclid ?? null,
      e.gbraid ?? null,
      e.wbraid ?? null,
      e.emailSha256 ?? null,
    )
    .run();
}
