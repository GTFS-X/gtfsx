// First-run funnel events (2026-08-08) — the six additive kinds that make the
// stretch between "opened the editor" and "hit a paywall / exported" legible:
// feed_opened, feed_import_failed, feed_edited, export_attempt, export_failed,
// gate_blocked.
//
// Two things these tests are really guarding:
//   1. The kinds and their `label` vocabulary round-trip into `event` intact —
//      especially a FAILED IMPORT (`<origin>:<stage>`) and a triggered gate,
//      the two signals that were previously invisible.
//   2. They stay OUT of the Google Ads conversion path. `CONVERSION_KINDS` in
//      worker/events/routes.ts and `ALL_UPLOAD_KINDS` in
//      worker/marketing/ads/oci.ts must both stay at four; a funnel event must
//      never acquire `oci_email_sha256`, even from a credentialed caller.

import { beforeEach, describe, expect, it } from 'vitest';
import { makeClient, type TestClient } from './_client';
import { applyMigrations, dbAll, dbGet, dbRun, resetDb, seedUser } from './_setup';

interface EventRow {
  kind: string;
  path: string;
  label: string | null;
  session_id: string;
  gclid: string | null;
  oci_email_sha256: string | null;
}

async function loginAsFreeUser(): Promise<TestClient> {
  const user = await seedUser({ plan: 'free' });
  const client = makeClient();
  const res = await client.post('/auth/login', { email: user.email, password: user.password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return client;
}

// The four kinds the Google Ads uploader can send. Mirrors ALL_UPLOAD_KINDS.
const CONVERSION_KINDS = ['feed_exported', 'paywall_view', 'demo_request', 'sign_up'];

// Every first-run funnel kind, with a representative label from its enum.
const FUNNEL_EVENTS: { kind: string; label: string | null }[] = [
  { kind: 'feed_opened', label: 'upload' },
  { kind: 'feed_import_failed', label: 'url:fetch' },
  { kind: 'feed_edited', label: 'stops' },
  { kind: 'export_attempt', label: 'blocked_validation' },
  { kind: 'export_failed', label: 'gtfs_zip' },
  { kind: 'gate_blocked', label: 'save_signin' },
];

describe('first-run funnel events', () => {
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    // resetDb() leaves `event` alone (analytics rows sit outside the
    // user/project graph) — wipe it for deterministic assertions.
    await dbRun(`DELETE FROM event`);
  });

  it('accepts and persists every funnel kind with its label', async () => {
    const client = makeClient();
    for (const { kind, label } of FUNNEL_EVENTS) {
      const res = await client.post('/api/events/track', {
        kind,
        path: '/',
        ref: null,
        sessionId: `sess-funnel-${kind}`,
        label,
      });
      expect(res.status, `${kind} should be accepted`).toBe(204);
    }

    const rows = await dbAll<EventRow>(`SELECT kind, label FROM event ORDER BY kind`);
    expect(rows.map((r) => `${r.kind}=${r.label}`).sort()).toEqual(
      FUNNEL_EVENTS.map((e) => `${e.kind}=${e.label}`).sort(),
    );
  });

  it('records a failed import as <origin>:<stage>, groupable either way', async () => {
    const client = makeClient();
    // A first-run visitor pastes a feed URL that 404s, then drags in a zip that
    // isn't GTFS. Before this, both were completely silent.
    const failures = ['url:fetch', 'upload:parse', 'catalog:fetch', 'demo:parse'];
    for (const label of failures) {
      const res = await client.post('/api/events/track', {
        kind: 'feed_import_failed',
        path: '/',
        ref: null,
        sessionId: 'sess-import-fail-0001',
        label,
      });
      expect(res.status).toBe(204);
    }

    const byOrigin = await dbAll<{ label: string }>(
      `SELECT label FROM event WHERE kind = 'feed_import_failed' AND label LIKE 'url:%'`,
    );
    expect(byOrigin.map((r) => r.label)).toEqual(['url:fetch']);

    const byStage = await dbAll<{ label: string }>(
      `SELECT label FROM event WHERE kind = 'feed_import_failed' AND label LIKE '%:fetch'
        ORDER BY label`,
    );
    expect(byStage.map((r) => r.label)).toEqual(['catalog:fetch', 'url:fetch']);
  });

  it('records which wall stopped the user: gate_blocked label + paywall_view feature', async () => {
    const client = makeClient();
    const sessionId = 'sess-walls-000001';

    // The sign-in wall (no paywall overlay fires for this one) …
    await client.post('/api/events/track', {
      kind: 'gate_blocked', path: '/', ref: null, sessionId, label: 'save_signin',
    });
    // … and a plan paywall, whose triggering feature key rides in the SAME
    // `label` column. Together they answer "which wall" for every wall.
    await client.post('/api/events/track', {
      kind: 'paywall_view', path: '/', ref: null, sessionId, label: 'analysis_basic',
    });

    const rows = await dbAll<EventRow>(
      `SELECT kind, label FROM event WHERE session_id = ? ORDER BY ts, kind`,
      sessionId,
    );
    expect(rows).toEqual([
      { kind: 'gate_blocked', label: 'save_signin' },
      { kind: 'paywall_view', label: 'analysis_basic' },
    ]);
  });

  it('keeps carrying a session gclid so funnel drop-off is attributable to paid traffic', async () => {
    const client = makeClient();
    const sessionId = 'sess-paid-funnel-01';
    const gclid = 'EAIaIQobChMI_funnel_test';

    for (const kind of ['editor_loaded', 'feed_opened', 'feed_edited', 'gate_blocked']) {
      await client.post('/api/events/track', {
        kind, path: '/', ref: null, sessionId, gclid,
        label: kind === 'feed_opened' ? 'demo' : kind === 'feed_edited' ? 'stops' : null,
      });
    }

    const rows = await dbAll<EventRow>(
      `SELECT kind, gclid FROM event WHERE session_id = ? ORDER BY ts`,
      sessionId,
    );
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.gclid === gclid)).toBe(true);
  });

  it('never stamps a hashed email on a funnel kind, even for a signed-in caller', async () => {
    // The browser beacon sends credentials: 'omit', so this can't happen from a
    // real page — but a credentialed caller of this endpoint must still not turn
    // a funnel event into something the Ads uploader could pick up.
    const client = await loginAsFreeUser();

    for (const { kind, label } of FUNNEL_EVENTS) {
      const res = await client.post('/api/events/track', {
        kind, path: '/', ref: null, sessionId: `sess-authed-${kind}`, label,
      });
      expect(res.status).toBe(204);
    }

    const hashed = await dbAll<EventRow>(
      `SELECT kind FROM event WHERE oci_email_sha256 IS NOT NULL`,
    );
    expect(hashed).toEqual([]);

    // Control: a real conversion kind from the same credentialed client DOES
    // get one, proving the assertion above isn't passing for the wrong reason.
    await client.post('/api/events/track', {
      kind: 'paywall_view', path: '/', ref: null, sessionId: 'sess-authed-control', label: 'embeds',
    });
    const control = await dbGet<EventRow>(
      `SELECT kind, oci_email_sha256 FROM event WHERE session_id = 'sess-authed-control'`,
    );
    expect(control!.oci_email_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the conversion-kind set is still exactly four (funnel kinds did not join it)', async () => {
    // Guards the invariant by construction rather than by reading the source:
    // send one of every kind the endpoint accepts as a credentialed caller, and
    // assert only the conversion kinds came back hashed.
    const client = await loginAsFreeUser();
    const allKinds = [
      'page_view', 'editor_loaded', 'feed_exported', 'paywall_view', 'cta_click', 'demo_request',
      ...FUNNEL_EVENTS.map((e) => e.kind),
    ];
    for (const kind of allKinds) {
      await client.post('/api/events/track', {
        kind, path: '/', ref: null, sessionId: `sess-all-${kind}`,
      });
    }
    const hashed = await dbAll<{ kind: string }>(
      `SELECT DISTINCT kind FROM event WHERE oci_email_sha256 IS NOT NULL ORDER BY kind`,
    );
    // 'sign_up' is written server-side, never through this endpoint.
    expect(hashed.map((r) => r.kind)).toEqual(
      CONVERSION_KINDS.filter((k) => k !== 'sign_up').sort(),
    );
  });

  it('rejects an unknown kind (the enum is still closed)', async () => {
    const client = makeClient();
    const res = await client.post('/api/events/track', {
      kind: 'feed_deleted',
      path: '/',
      ref: null,
      sessionId: 'sess-bogus-kind-01',
    });
    expect(res.status).toBe(422);
  });

  it('rejects a label longer than the 128-char cap', async () => {
    const client = makeClient();
    const res = await client.post('/api/events/track', {
      kind: 'feed_import_failed',
      path: '/',
      ref: null,
      sessionId: 'sess-long-label-01',
      label: 'x'.repeat(129),
    });
    expect(res.status).toBe(422);
  });
});
