// Hashed-email user identifiers on the Google Ads Data Manager upload path.
//
// Covers:
//   - Google's email normalization + SHA-256 hex, pinned to worked vectors.
//   - buildIngestBody attaching userData / encoding:"HEX", and refusing to emit
//     an event with no identifier at all.
//   - The customer-data terms fallback: a terms-gate rejection retries WITHOUT
//     userData and the row still succeeds; an unrelated 400 still fails it.
//   - Candidate selection: a hashed email must NOT widen the candidate set
//     unless the email-only capability is explicitly armed with a cutover, and
//     even then only for the two kinds that can ever resolve an email.
//   - The alert conditions that close the three silent-failure holes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ulid } from 'ulidx';
import {
  buildIngestBody,
  extractErrorReasons,
  isTermsGateError,
  ociAlertReason,
  parseCutover,
  parseEmailOnlyKinds,
  readDataManagerConfig,
  readEmailOnlyPolicy,
  uploadPendingConversions,
  EMAIL_ONLY_ELIGIBLE_KINDS,
  type OciResult,
  type PendingRow,
} from '../marketing/ads/oci';
import {
  hashEmailHex,
  isSha256Hex,
  normalizeEmail,
  redactHash,
} from '../marketing/ads/userIdentifiers';
import {
  applyMigrations, dbGet, dbRun, env as testEnv, resetDb, seedUser,
  setupEmailCapture, type EmailCapture,
} from './_setup';
import { makeClient } from './_client';

// Same fixed clock as oci.test.ts (whose comment misdates it by a year — it is
// 2025-05-26T16:00:00Z). Only its determinism matters.
const FIXED_NOW = 1748275200000;
const now = () => FIXED_NOW;

// Verified independently with `shasum -a 256` against the normalized string.
const GMAIL_VECTOR = {
  raw: 'cloudy.sanfrancisco+shopping@gmail.com',
  normalized: 'cloudysanfrancisco@gmail.com',
  sha256: '223ebda6f6889b1494551ba902d9d381daf2f642bae055888e96343d53e9f9c4',
};
const NON_GMAIL_VECTOR = {
  raw: 'User.Name+NYC@Example.com',
  normalized: 'user.name+nyc@example.com',
  sha256: 'f109a2a632fbcea5fc82049f50beed3d8621bf9034399f437fb622222acccdac',
};

const DM_SECRETS = {
  GOOGLE_DATAMANAGER_REFRESH_TOKEN: 'dm-refresh',
  GOOGLE_DATAMANAGER_PROJECT_ID: 'gtfsx-ads-oci',
  GOOGLE_ADS_CLIENT_ID: 'client-id',
  GOOGLE_ADS_CLIENT_SECRET: 'client-secret',
  GOOGLE_ADS_CUSTOMER_ID: '1001841562',
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: '9998887777',
  GOOGLE_ADS_CONVERSION_ACTION_FEED_EXPORTED: '111111',
  GOOGLE_ADS_CONVERSION_ACTION_PAYWALL_VIEW: '222222',
  GOOGLE_ADS_CONVERSION_ACTION_DEMO_REQUEST: '333333',
  GOOGLE_ADS_CONVERSION_ACTION_SIGN_UP: '444444',
};
const EXTRA_KEYS = [
  'GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_REFRESH_TOKEN',
  'GOOGLE_ADS_UPLOAD_WITHOUT_CLICK_ID_KINDS', 'GOOGLE_ADS_UPLOAD_WITHOUT_CLICK_ID_SINCE',
];

function clearSecrets(): void {
  for (const k of [...Object.keys(DM_SECRETS), ...EXTRA_KEYS]) {
    delete (testEnv as unknown as Record<string, unknown>)[k];
  }
}
function withDataManager(): void {
  Object.assign(testEnv, DM_SECRETS);
}
function setEnv(key: string, value: string): void {
  (testEnv as unknown as Record<string, string>)[key] = value;
}

async function seedEvent(opts: {
  ts?: number;
  kind?: string;
  gclid?: string | null;
  emailSha256?: string | null;
  oci_uploaded_at?: number | null;
  oci_attempts?: number;
}): Promise<string> {
  const id = ulid();
  await dbRun(
    `INSERT INTO event (id, ts, kind, path, ref, session_id, country, label, gclid, gbraid, wbraid, oci_uploaded_at, oci_attempts, oci_last_error, oci_email_sha256)
     VALUES (?, ?, ?, '/', NULL, ?, NULL, NULL, ?, NULL, NULL, ?, ?, NULL, ?)`,
    id,
    opts.ts ?? FIXED_NOW - 1000,
    opts.kind ?? 'feed_exported',
    `sess-${id}`,
    opts.gclid ?? null,
    opts.oci_uploaded_at ?? null,
    opts.oci_attempts ?? 0,
    opts.emailSha256 ?? null,
  );
  return id;
}

const baseRow = (over: Partial<PendingRow>): PendingRow => ({
  id: 'evt-1', ts: Date.UTC(2026, 4, 26, 14, 0, 0), kind: 'feed_exported',
  gclid: null, gbraid: null, wbraid: null, attempts: 0, emailSha256: null, ...over,
});

function oauthResponse(): Response {
  return new Response(JSON.stringify({ access_token: 'access-xyz', expires_in: 3600, token_type: 'Bearer' }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}
function dmSuccessResponse(): Response {
  return new Response(JSON.stringify({ requestId: 'req-abc-123' }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * The VERBATIM terms-gate rejection, captured from a live validateOnly probe
 * against the production account on 2026-08-08. Reproduced exactly (including
 * the generic ErrorInfo.reason of INVALID_ARGUMENT sitting next to the real
 * one) so the matcher is tested against Google's real shape, not a guess.
 */
function termsGateResponse(): Response {
  return new Response(JSON.stringify({
    error: {
      code: 400,
      message: 'There was a problem with the request.',
      status: 'INVALID_ARGUMENT',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          reason: 'INVALID_ARGUMENT',
          domain: 'datamanager.googleapis.com',
          metadata: { requestId: 't-208c37c6' },
        },
        { '@type': 'type.googleapis.com/google.rpc.RequestInfo', requestId: 't-208c37c6' },
        {
          '@type': 'type.googleapis.com/google.rpc.BadRequest',
          fieldViolations: [{
            field: 'events.events[0].destination_references[0]',
            description: "The destination account hasn't agreed to the terms for enhanced conversions.",
            reason: 'DESTINATION_ACCOUNT_ENHANCED_CONVERSIONS_TERMS_NOT_SIGNED',
          }],
        },
      ],
    },
  }), { status: 400, headers: { 'Content-Type': 'application/json' } });
}

/** A 400 that has nothing to do with the terms — must NOT trigger a retry. */
function unrelatedBadRequestResponse(): Response {
  return new Response(JSON.stringify({
    error: {
      code: 400,
      message: 'There was a problem with the request.',
      status: 'INVALID_ARGUMENT',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.BadRequest',
          fieldViolations: [{
            field: 'events.events[0].event_timestamp',
            description: 'The event timestamp is outside the conversion window.',
            reason: 'EVENT_TIMESTAMP_OUTSIDE_CONVERSION_WINDOW',
          }],
        },
      ],
    },
  }), { status: 400, headers: { 'Content-Type': 'application/json' } });
}

type FetchHandler = (req: { url: string; init: RequestInit | undefined }) => Promise<Response> | Response;
function stubFetch(handler: FetchHandler): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return handler({ url, init });
  });
  return mock as unknown as ReturnType<typeof vi.fn>;
}

// ─── Normalization + hashing ────────────────────────────────────────────────

describe('userIdentifiers: normalizeEmail', () => {
  it('gmail: strips dots and the +tag from the local part', () => {
    expect(normalizeEmail(GMAIL_VECTOR.raw)).toBe(GMAIL_VECTOR.normalized);
  });

  it('googlemail is treated exactly like gmail', () => {
    expect(normalizeEmail('a.b+c@googlemail.com')).toBe('ab@googlemail.com');
  });

  it('non-gmail: dots and +tags are LEFT ALONE, only case-folded', () => {
    expect(normalizeEmail(NON_GMAIL_VECTOR.raw)).toBe(NON_GMAIL_VECTOR.normalized);
  });

  it('uppercase anywhere is lowercased', () => {
    expect(normalizeEmail('MARK@GTFSX.COM')).toBe('mark@gtfsx.com');
  });

  it('surrounding whitespace (incl. newlines/tabs) is trimmed', () => {
    expect(normalizeEmail('  \t mark@gtfsx.com \n ')).toBe('mark@gtfsx.com');
  });

  it('absent or malformed input yields null, never a partial value', () => {
    for (const bad of [
      null, undefined, '', '   ', 'not-an-email', 'no-at-sign.com', '@gtfsx.com',
      'mark@', 'mark@localhost', 'two@at@signs.com', 'a b@gtfsx.com', '+tag@gmail.com',
    ]) {
      expect(normalizeEmail(bad as string | null | undefined)).toBeNull();
    }
  });
});

describe('userIdentifiers: hashEmailHex', () => {
  it('matches the pinned gmail vector', async () => {
    const hash = await hashEmailHex(GMAIL_VECTOR.raw);
    expect(hash).toBe(GMAIL_VECTOR.sha256);
    expect(hash).toHaveLength(64);
  });

  it('matches the pinned non-gmail vector', async () => {
    const hash = await hashEmailHex(NON_GMAIL_VECTOR.raw);
    expect(hash).toBe(NON_GMAIL_VECTOR.sha256);
    expect(hash).toHaveLength(64);
  });

  it('hashes the NORMALIZED form: gmail variants collapse to one digest', async () => {
    expect(await hashEmailHex('CloudySanFrancisco@gmail.com')).toBe(GMAIL_VECTOR.sha256);
    expect(await hashEmailHex(' cloudy.san.francisco+anything@GMAIL.com ')).toBe(GMAIL_VECTOR.sha256);
  });

  it('non-gmail dots are significant — a dotless variant is a DIFFERENT digest', async () => {
    expect(await hashEmailHex('username@example.com'))
      .not.toBe(await hashEmailHex('user.name@example.com'));
  });

  it('returns null for absent/malformed input — never an empty-string hash', async () => {
    expect(await hashEmailHex(null)).toBeNull();
    expect(await hashEmailHex('')).toBeNull();
    expect(await hashEmailHex('   ')).toBeNull();
    expect(await hashEmailHex('nonsense')).toBeNull();
    // Guard against the specific footgun: sha256('') must never be emitted.
    const emptyDigest = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    expect(await hashEmailHex('')).not.toBe(emptyDigest);
  });
});

describe('userIdentifiers: isSha256Hex / redactHash', () => {
  it('accepts only 64 lowercase hex chars', () => {
    expect(isSha256Hex(GMAIL_VECTOR.sha256)).toBe(true);
    expect(isSha256Hex(GMAIL_VECTOR.sha256.toUpperCase())).toBe(false);
    expect(isSha256Hex(GMAIL_VECTOR.sha256.slice(0, 63))).toBe(false);
    expect(isSha256Hex('mark@gtfsx.com')).toBe(false);
    expect(isSha256Hex(null)).toBe(false);
  });

  it('redaction never reveals the full digest', () => {
    const red = redactHash(GMAIL_VECTOR.sha256);
    expect(red).not.toContain(GMAIL_VECTOR.sha256);
    expect(red.startsWith(GMAIL_VECTOR.sha256.slice(0, 8))).toBe(true);
    expect(redactHash(null)).toBe('(none)');
  });
});

// ─── Payload shape ──────────────────────────────────────────────────────────

describe('OCI: buildIngestBody with userData', () => {
  beforeEach(() => { clearSecrets(); withDataManager(); });

  it('attaches userData as a SIBLING of adIdentifiers and sets encoding HEX', () => {
    const cfg = readDataManagerConfig(testEnv)!;
    const body = buildIngestBody(cfg, baseRow({ gclid: 'gA', emailSha256: GMAIL_VECTOR.sha256 }));
    expect(body.encoding).toBe('HEX');
    const ev = (body.events as Array<Record<string, unknown>>)[0];
    expect(ev.adIdentifiers).toEqual({ gclid: 'gA' });
    expect(ev.userData).toEqual({ userIdentifiers: [{ emailAddress: GMAIL_VECTOR.sha256 }] });
    // userData must NOT be nested inside adIdentifiers.
    expect((ev.adIdentifiers as Record<string, unknown>).userData).toBeUndefined();
  });

  it('omits userData AND encoding when the row has no hashed email', () => {
    const cfg = readDataManagerConfig(testEnv)!;
    const body = buildIngestBody(cfg, baseRow({ gclid: 'gA' }));
    expect(body.encoding).toBeUndefined();
    expect((body.events as Array<Record<string, unknown>>)[0].userData).toBeUndefined();
  });

  it('treats a malformed stored hash as absent — never puts it on the wire', () => {
    const cfg = readDataManagerConfig(testEnv)!;
    for (const bad of ['', 'mark@gtfsx.com', 'ZZZZ', GMAIL_VECTOR.sha256.toUpperCase()]) {
      const body = buildIngestBody(cfg, baseRow({ gclid: 'gA', emailSha256: bad }));
      expect(body.encoding).toBeUndefined();
      expect((body.events as Array<Record<string, unknown>>)[0].userData).toBeUndefined();
    }
  });

  it('includeUserData:false rebuilds the identical event without userData', () => {
    const cfg = readDataManagerConfig(testEnv)!;
    const row = baseRow({ id: 'evt-x', gclid: 'gA', emailSha256: GMAIL_VECTOR.sha256 });
    const withUd = buildIngestBody(cfg, row) as Record<string, unknown>;
    const without = buildIngestBody(cfg, row, { includeUserData: false }) as Record<string, unknown>;
    expect(without.encoding).toBeUndefined();
    const a = (withUd.events as Array<Record<string, unknown>>)[0];
    const b = (without.events as Array<Record<string, unknown>>)[0];
    expect(b.userData).toBeUndefined();
    // Same dedup key + timestamp + click id — only userData differs.
    expect(b.transactionId).toBe(a.transactionId);
    expect(b.eventTimestamp).toBe(a.eventTimestamp);
    expect(b.adIdentifiers).toEqual(a.adIdentifiers);
    expect(without.destinations).toEqual(withUd.destinations);
  });

  it('email-only row: userData alone, adIdentifiers key omitted entirely', () => {
    const cfg = readDataManagerConfig(testEnv)!;
    const body = buildIngestBody(cfg, baseRow({ emailSha256: NON_GMAIL_VECTOR.sha256 }));
    const ev = (body.events as Array<Record<string, unknown>>)[0];
    expect(ev.adIdentifiers).toBeUndefined();
    expect(ev.userData).toBeDefined();
    expect(body.encoding).toBe('HEX');
  });

  it('REFUSES to build an event with neither an ad nor a user identifier', () => {
    const cfg = readDataManagerConfig(testEnv)!;
    expect(() => buildIngestBody(cfg, baseRow({}))).toThrow(/neither an ad identifier nor a user identifier/);
    // …and the same for a row whose only "email" is malformed.
    expect(() => buildIngestBody(cfg, baseRow({ emailSha256: 'not-a-hash' })))
      .toThrow(/neither an ad identifier nor a user identifier/);
    // …and when the fallback would strip the only identifier it has.
    expect(() => buildIngestBody(
      cfg, baseRow({ emailSha256: GMAIL_VECTOR.sha256 }), { includeUserData: false },
    )).toThrow(/neither an ad identifier nor a user identifier/);
  });
});

// ─── Error-reason parsing ───────────────────────────────────────────────────

describe('OCI: Data Manager error reasons', () => {
  it('extracts reasons from ErrorInfo and BadRequest.fieldViolations', async () => {
    const parsed = await termsGateResponse().json();
    expect(extractErrorReasons(parsed)).toEqual([
      'INVALID_ARGUMENT',
      'DESTINATION_ACCOUNT_ENHANCED_CONVERSIONS_TERMS_NOT_SIGNED',
    ]);
  });

  it('recognises the terms gate by exact reason token', () => {
    expect(isTermsGateError(['DESTINATION_ACCOUNT_ENHANCED_CONVERSIONS_TERMS_NOT_SIGNED'])).toBe(true);
    expect(isTermsGateError(['TERMS_AND_CONDITIONS_NOT_SIGNED'])).toBe(true);
    expect(isTermsGateError(['DESTINATION_ACCOUNT_DATA_POLICY_PROHIBITS_ENHANCED_CONVERSIONS'])).toBe(true);
  });

  it('does NOT match on message text or a near-miss token', () => {
    expect(isTermsGateError(['INVALID_ARGUMENT'])).toBe(false);
    expect(isTermsGateError(['EVENT_TIMESTAMP_OUTSIDE_CONVERSION_WINDOW'])).toBe(false);
    // A reason that merely CONTAINS a gate token is not a gate token.
    expect(isTermsGateError(['NOT_TERMS_AND_CONDITIONS_NOT_SIGNED_X'])).toBe(false);
    expect(isTermsGateError([])).toBe(false);
  });

  it('survives shapes it does not recognise', () => {
    expect(extractErrorReasons(null)).toEqual([]);
    expect(extractErrorReasons('a string')).toEqual([]);
    expect(extractErrorReasons({ error: {} })).toEqual([]);
    expect(extractErrorReasons({ error: { details: [{}] } })).toEqual([]);
  });
});

// ─── The terms fallback, end to end ─────────────────────────────────────────

describe('OCI: customer-data terms fallback', () => {
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    await dbRun(`DELETE FROM event`);
    clearSecrets();
    (testEnv as unknown as Record<string, unknown>).APP_ORIGIN = 'https://www.gtfsx.com';
  });

  it('a terms-gate rejection retries WITHOUT userData and the row still succeeds', async () => {
    withDataManager();
    const id = await seedEvent({ gclid: 'gA', kind: 'paywall_view', emailSha256: GMAIL_VECTOR.sha256 });

    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = stubFetch(({ url, init }) => {
      if (url.includes('oauth2.googleapis.com')) return oauthResponse();
      if (url.includes('events:ingest')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        bodies.push(body);
        const ev = (body.events as Array<Record<string, unknown>>)[0];
        return ev.userData ? termsGateResponse() : dmSuccessResponse();
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await uploadPendingConversions(
      testEnv, { fetch: fetchMock as unknown as typeof fetch, now },
    );

    expect(bodies).toHaveLength(2);
    expect((bodies[0].events as Array<Record<string, unknown>>)[0].userData).toBeDefined();
    expect(bodies[0].encoding).toBe('HEX');
    expect((bodies[1].events as Array<Record<string, unknown>>)[0].userData).toBeUndefined();
    expect(bodies[1].encoding).toBeUndefined();

    expect(result.uploaded).toBe(1);
    expect(result.failedThisRun).toBe(0);
    expect(result.userDataFallbacks).toBe(1);
    expect(result.withUserData).toBe(0); // the accepted attempt carried none

    const row = await dbGet<{ oci_uploaded_at: number | null; oci_last_error: string | null }>(
      `SELECT oci_uploaded_at, oci_last_error FROM event WHERE id = ?`, id,
    );
    expect(row!.oci_uploaded_at).toBe(FIXED_NOW);
    expect(row!.oci_last_error).toBeNull();
  });

  it('logs the fallback ONCE per run, not once per row', async () => {
    withDataManager();
    for (let i = 0; i < 3; i++) {
      await seedEvent({ gclid: `g${i}`, kind: 'paywall_view', emailSha256: GMAIL_VECTOR.sha256 });
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = stubFetch(({ url, init }) => {
      if (url.includes('oauth2.googleapis.com')) return oauthResponse();
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      const ev = (body.events as Array<Record<string, unknown>>)[0];
      return ev.userData ? termsGateResponse() : dmSuccessResponse();
    });

    const result = await uploadPendingConversions(
      testEnv, { fetch: fetchMock as unknown as typeof fetch, now },
    );
    expect(result.uploaded).toBe(3);
    expect(result.userDataFallbacks).toBe(3);
    const termsWarnings = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('enhanced-conversions terms NOT accepted'));
    expect(termsWarnings).toHaveLength(1);
    warn.mockRestore();
  });

  it('an UNRELATED 400 fails the row — no silent retry', async () => {
    withDataManager();
    const id = await seedEvent({ gclid: 'gA', kind: 'paywall_view', emailSha256: GMAIL_VECTOR.sha256 });

    let calls = 0;
    const fetchMock = stubFetch(({ url }) => {
      if (url.includes('oauth2.googleapis.com')) return oauthResponse();
      calls++;
      return unrelatedBadRequestResponse();
    });

    const result = await uploadPendingConversions(
      testEnv, { fetch: fetchMock as unknown as typeof fetch, now },
    );
    expect(calls).toBe(1); // exactly one attempt — no fallback
    expect(result.uploaded).toBe(0);
    expect(result.failedThisRun).toBe(1);
    expect(result.userDataFallbacks).toBe(0);
    expect(result.topErrorReasons.map((r) => r.reason))
      .toContain('EVENT_TIMESTAMP_OUTSIDE_CONVERSION_WINDOW');

    const row = await dbGet<{ oci_uploaded_at: number | null; oci_last_error: string | null }>(
      `SELECT oci_uploaded_at, oci_last_error FROM event WHERE id = ?`, id,
    );
    expect(row!.oci_uploaded_at).toBeNull(); // still pending, will retry next run
    expect(row!.oci_last_error).toMatch(/HTTP 400/);
  });

  it('a row with a hashed email but no terms problem uploads WITH userData', async () => {
    withDataManager();
    await seedEvent({ gclid: 'gA', kind: 'paywall_view', emailSha256: NON_GMAIL_VECTOR.sha256 });
    let sentUserData = false;
    const fetchMock = stubFetch(({ url, init }) => {
      if (url.includes('oauth2.googleapis.com')) return oauthResponse();
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      sentUserData = !!(body.events as Array<Record<string, unknown>>)[0].userData;
      return dmSuccessResponse();
    });
    const result = await uploadPendingConversions(
      testEnv, { fetch: fetchMock as unknown as typeof fetch, now },
    );
    expect(sentUserData).toBe(true);
    expect(result.uploaded).toBe(1);
    expect(result.withUserData).toBe(1);
    expect(result.userDataFallbacks).toBe(0);
  });
});

// ─── Candidate selection must NOT widen by default, and is per-kind ─────────

describe('OCI: email-only candidacy is per-kind and default-off', () => {
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    await dbRun(`DELETE FROM event`);
    clearSecrets();
    (testEnv as unknown as Record<string, unknown>).APP_ORIGIN = 'https://www.gtfsx.com';
  });

  // Arm the capability for `kinds` with a cutover 10 days back.
  const CUTOVER = FIXED_NOW - 10 * 86400000;
  function arm(kinds: string): void {
    setEnv('GOOGLE_ADS_UPLOAD_WITHOUT_CLICK_ID_KINDS', kinds);
    setEnv('GOOGLE_ADS_UPLOAD_WITHOUT_CLICK_ID_SINCE', new Date(CUTOVER).toISOString());
  }
  // Collects the transactionId of every event actually POSTed to Data Manager.
  function captureSends(sent: string[]): ReturnType<typeof stubFetch> {
    return stubFetch(({ url, init }) => {
      if (url.includes('oauth2.googleapis.com')) return oauthResponse();
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      sent.push(String((body.events as Array<Record<string, unknown>>)[0].transactionId));
      return dmSuccessResponse();
    });
  }
  async function run(sent: string[]): Promise<OciResult> {
    return uploadPendingConversions(
      testEnv, { fetch: captureSends(sent) as unknown as typeof fetch, now },
    );
  }

  // ── the structural ceiling ──

  it('EMAIL_ONLY_ELIGIBLE_KINDS is exactly the two kinds that resolve an email', () => {
    expect([...EMAIL_ONLY_ELIGIBLE_KINDS]).toEqual(['sign_up', 'demo_request']);
  });

  it('parseEmailOnlyKinds honours eligible kinds and DROPS ineligible ones', () => {
    expect(parseEmailOnlyKinds(undefined)).toEqual([]);
    expect(parseEmailOnlyKinds('')).toEqual([]);
    expect(parseEmailOnlyKinds('   ')).toEqual([]);
    expect(parseEmailOnlyKinds('sign_up')).toEqual(['sign_up']);
    expect(parseEmailOnlyKinds(' Demo_Request ')).toEqual(['demo_request']);
    // Order follows the ceiling, not the env string, so binds stay stable.
    expect(parseEmailOnlyKinds('demo_request,sign_up')).toEqual(['sign_up', 'demo_request']);
    expect(parseEmailOnlyKinds('*')).toEqual(['sign_up', 'demo_request']);
    // The kinds with no identifier are never honoured, alone or mixed in.
    expect(parseEmailOnlyKinds('paywall_view')).toEqual([]);
    expect(parseEmailOnlyKinds('feed_exported')).toEqual([]);
    expect(parseEmailOnlyKinds('paywall_view,feed_exported,nonsense')).toEqual([]);
    expect(parseEmailOnlyKinds('paywall_view,sign_up')).toEqual(['sign_up']);
  });

  it('readEmailOnlyPolicy: kinds without a cutover stays OFF', () => {
    setEnv('GOOGLE_ADS_UPLOAD_WITHOUT_CLICK_ID_KINDS', 'sign_up');
    expect(readEmailOnlyPolicy(testEnv)).toBeNull();
    setEnv('GOOGLE_ADS_UPLOAD_WITHOUT_CLICK_ID_SINCE', 'whenever');
    expect(readEmailOnlyPolicy(testEnv)).toBeNull();
  });

  it('readEmailOnlyPolicy: a cutover without kinds stays OFF', () => {
    setEnv('GOOGLE_ADS_UPLOAD_WITHOUT_CLICK_ID_SINCE', new Date(CUTOVER).toISOString());
    expect(readEmailOnlyPolicy(testEnv)).toBeNull();
  });

  it('readEmailOnlyPolicy: only-ineligible kinds + a valid cutover stays OFF', () => {
    arm('paywall_view,feed_exported');
    expect(readEmailOnlyPolicy(testEnv)).toBeNull();
  });

  it('readEmailOnlyPolicy: eligible kinds + cutover resolves', () => {
    arm('sign_up,demo_request');
    expect(readEmailOnlyPolicy(testEnv)).toEqual({
      kinds: ['sign_up', 'demo_request'], since: CUTOVER,
    });
  });

  // ── per-kind candidacy, with and without the capability ──

  // Each kind, in both states. A `null` expectation means "never a candidate".
  const KIND_CASES: Array<{ kind: string; armed: boolean }> = [
    { kind: 'sign_up', armed: true },
    { kind: 'sign_up', armed: false },
    { kind: 'demo_request', armed: true },
    { kind: 'demo_request', armed: false },
    { kind: 'paywall_view', armed: true },
    { kind: 'paywall_view', armed: false },
    { kind: 'feed_exported', armed: true },
    { kind: 'feed_exported', armed: false },
  ];
  const CAN_BE_WIDENED = new Set(['sign_up', 'demo_request']);

  for (const { kind, armed } of KIND_CASES) {
    const eligible = CAN_BE_WIDENED.has(kind);
    const shouldSend = armed && eligible;
    it(
      `${kind}, email-only, capability ${armed ? 'ARMED for every eligible kind' : 'OFF'}: `
      + `${shouldSend ? 'IS' : 'is NOT'} a candidate`,
      async () => {
        withDataManager();
        // Arm for the full ceiling — the point is that arming everything the
        // config CAN name still cannot reach paywall_view / feed_exported.
        if (armed) arm('*');
        const emailOnlyRow = await seedEvent({
          kind, emailSha256: GMAIL_VECTOR.sha256, gclid: null, ts: CUTOVER + 86400000,
        });

        const sent: string[] = [];
        const result = await run(sent);

        expect(sent).toEqual(shouldSend ? [emailOnlyRow] : []);
        expect(result.attempted).toBe(shouldSend ? 1 : 0);

        // A non-candidate is left completely alone: not uploaded, and NOT
        // stamped with the -1 sentinel (markExpiredOnly stays ad-id-only).
        const row = await dbGet<{ oci_uploaded_at: number | null; oci_attempts: number }>(
          `SELECT oci_uploaded_at, COALESCE(oci_attempts, 0) AS oci_attempts FROM event WHERE id = ?`,
          emailOnlyRow,
        );
        if (shouldSend) {
          expect(row!.oci_uploaded_at).toBe(FIXED_NOW);
        } else {
          expect(row!.oci_uploaded_at).toBeNull();
          expect(row!.oci_attempts).toBe(0);
        }
      },
    );
  }

  it('a kind with NO identifier available is never even attempted', async () => {
    withDataManager();
    arm('*');
    // The real shape of a beacon row: no click id AND no hash, because
    // trackBeacon.ts sends credentials:'omit' and the server resolves no email.
    const paywall = await seedEvent({ kind: 'paywall_view', gclid: null, emailSha256: null });
    const exported = await seedEvent({ kind: 'feed_exported', gclid: null, emailSha256: null });

    const sent: string[] = [];
    const result = await run(sent);

    // Excluded at SELECTION — not attempted-then-failed. If these ever became
    // candidates, buildIngestBody would throw NO-identifier and they'd land in
    // errors with oci_attempts incremented, which is exactly what must not happen.
    expect(sent).toEqual([]);
    expect(result.candidates).toBe(0);
    expect(result.attempted).toBe(0);
    expect(result.failedThisRun).toBe(0);
    expect(result.errors).toEqual([]);
    for (const id of [paywall, exported]) {
      const row = await dbGet<{ oci_uploaded_at: number | null; oci_attempts: number; oci_last_error: string | null }>(
        `SELECT oci_uploaded_at, COALESCE(oci_attempts, 0) AS oci_attempts, oci_last_error FROM event WHERE id = ?`,
        id,
      );
      expect(row!.oci_uploaded_at).toBeNull();
      expect(row!.oci_attempts).toBe(0);
      expect(row!.oci_last_error).toBeNull();
    }
  });

  it('arming one kind does not arm the other', async () => {
    withDataManager();
    arm('sign_up');
    const signUp = await seedEvent({
      kind: 'sign_up', emailSha256: GMAIL_VECTOR.sha256, gclid: null, ts: CUTOVER + 86400000,
    });
    await seedEvent({
      kind: 'demo_request', emailSha256: NON_GMAIL_VECTOR.sha256, gclid: null, ts: CUTOVER + 86400000,
    });

    const sent: string[] = [];
    const result = await run(sent);
    expect(sent).toEqual([signUp]);
    expect(result.attempted).toBe(1);
  });

  it('click-id rows of EVERY kind keep uploading regardless of the capability', async () => {
    withDataManager();
    const ids = [
      await seedEvent({ kind: 'paywall_view', gclid: 'gPaywall' }),
      await seedEvent({ kind: 'feed_exported', gclid: 'gExport' }),
    ];
    const sent: string[] = [];
    const result = await run(sent);
    expect(sent.sort()).toEqual([...ids].sort());
    expect(result.attempted).toBe(2);
    expect(result.uploaded).toBe(2);
  });

  it('BY DEFAULT a row with a hashed email but NO click id is not a candidate', async () => {
    withDataManager();
    const organic = await seedEvent({ kind: 'sign_up', emailSha256: GMAIL_VECTOR.sha256, gclid: null });
    const withClick = await seedEvent({ kind: 'sign_up', gclid: 'gA' });

    const sent: string[] = [];
    const result = await run(sent);
    expect(result.attempted).toBe(1);
    expect(sent).toEqual([withClick]);

    // The organic row is untouched: not uploaded, and NOT sentinel-flagged.
    const row = await dbGet<{ oci_uploaded_at: number | null }>(
      `SELECT oci_uploaded_at FROM event WHERE id = ?`, organic,
    );
    expect(row!.oci_uploaded_at).toBeNull();
  });

  it('kinds alone (no cutover) does nothing — the capability stays off', async () => {
    withDataManager();
    setEnv('GOOGLE_ADS_UPLOAD_WITHOUT_CLICK_ID_KINDS', '*');
    expect(readEmailOnlyPolicy(testEnv)).toBeNull();

    await seedEvent({ kind: 'sign_up', emailSha256: GMAIL_VECTOR.sha256, gclid: null });
    const fetchMock = stubFetch(({ url }) => {
      if (url.includes('oauth2.googleapis.com')) return oauthResponse();
      throw new Error('no row should have been sent');
    });
    const result = await uploadPendingConversions(
      testEnv, { fetch: fetchMock as unknown as typeof fetch, now },
    );
    expect(result.attempted).toBe(0);
  });

  it('kinds + cutover: only rows NEWER than the cutover become candidates', async () => {
    withDataManager();
    arm('*');
    expect(readEmailOnlyPolicy(testEnv)).toEqual({
      kinds: ['sign_up', 'demo_request'], since: CUTOVER,
    });

    const older = await seedEvent({
      kind: 'sign_up', emailSha256: GMAIL_VECTOR.sha256, ts: CUTOVER - 86400000,
    });
    const newer = await seedEvent({
      kind: 'sign_up', emailSha256: NON_GMAIL_VECTOR.sha256, ts: CUTOVER + 86400000,
    });

    const sent: string[] = [];
    const result = await run(sent);
    expect(sent).toEqual([newer]);
    expect(result.attempted).toBe(1);

    const stale = await dbGet<{ oci_uploaded_at: number | null }>(
      `SELECT oci_uploaded_at FROM event WHERE id = ?`, older,
    );
    expect(stale!.oci_uploaded_at).toBeNull();
  });

  it('parseCutover accepts unix ms and ISO 8601, rejects nonsense', () => {
    expect(parseCutover('1748275200000')).toBe(1748275200000);
    expect(parseCutover(new Date(1748275200000).toISOString())).toBe(1748275200000);
    expect(parseCutover('2026-08-08T00:00:00.000Z')).toBe(Date.UTC(2026, 7, 8));
    expect(parseCutover(undefined)).toBeNull();
    expect(parseCutover('')).toBeNull();
    expect(parseCutover('   ')).toBeNull();
    expect(parseCutover('whenever')).toBeNull();
  });

  it('a dry run counts candidates and sends/writes NOTHING', async () => {
    withDataManager();
    const id = await seedEvent({
      kind: 'sign_up', emailSha256: GMAIL_VECTOR.sha256, ts: CUTOVER + 86400000,
    });
    const fetchMock = stubFetch(() => { throw new Error('a dry run must not call out'); });

    const result = await uploadPendingConversions(
      testEnv, { fetch: fetchMock as unknown as typeof fetch, now },
      { allowMissingClickId: true, emailOnlySince: CUTOVER, dryRun: true },
    );
    expect(result.dryRun).toBe(true);
    expect(result.candidates).toBe(1);
    expect(result.withUserData).toBe(1);
    expect(result.attempted).toBe(0);
    expect(result.uploaded).toBe(0);

    const row = await dbGet<{ oci_uploaded_at: number | null }>(
      `SELECT oci_uploaded_at FROM event WHERE id = ?`, id,
    );
    expect(row!.oci_uploaded_at).toBeNull();
  });

  it('the backfill option path is capped at the eligible kinds too', async () => {
    withDataManager();
    const signUp = await seedEvent({
      kind: 'sign_up', emailSha256: GMAIL_VECTOR.sha256, gclid: null, ts: CUTOVER + 86400000,
    });
    // A paywall_view that somehow acquired a hash (a credentialed non-beacon
    // caller of /api/events/track). Even an explicit backfill must not send it.
    await seedEvent({
      kind: 'paywall_view', emailSha256: NON_GMAIL_VECTOR.sha256, gclid: null, ts: CUTOVER + 86400000,
    });

    const sent: string[] = [];
    const result = await uploadPendingConversions(
      testEnv, { fetch: captureSends(sent) as unknown as typeof fetch, now },
      { allowMissingClickId: true, emailOnlySince: CUTOVER },
    );
    expect(sent).toEqual([signUp]);
    expect(result.attempted).toBe(1);
  });

  it('an ineligible kind passed in code is dropped, not honoured', async () => {
    withDataManager();
    await seedEvent({
      kind: 'paywall_view', emailSha256: GMAIL_VECTOR.sha256, gclid: null, ts: CUTOVER + 86400000,
    });
    const sent: string[] = [];
    const result = await uploadPendingConversions(
      testEnv, { fetch: captureSends(sent) as unknown as typeof fetch, now },
      {
        allowMissingClickId: true,
        emailOnlySince: CUTOVER,
        emailOnlyKinds: ['paywall_view', 'feed_exported'],
      },
    );
    expect(sent).toEqual([]);
    expect(result.candidates).toBe(0);
  });

  it('allowMissingClickId without any cutover throws rather than draining history', async () => {
    withDataManager();
    await expect(uploadPendingConversions(testEnv, { now }, { allowMissingClickId: true }))
      .rejects.toThrow(/requires an emailOnlySince cutover/);
  });

  it('the legacy path ignores the capability entirely (no userData field exists)', async () => {
    // Legacy secrets only — no Data Manager config, so the legacy uploader runs.
    Object.assign(testEnv, {
      GOOGLE_ADS_DEVELOPER_TOKEN: 'dev', GOOGLE_ADS_CLIENT_ID: 'cid',
      GOOGLE_ADS_CLIENT_SECRET: 'cs', GOOGLE_ADS_REFRESH_TOKEN: 'rt',
      GOOGLE_ADS_CUSTOMER_ID: '1001841562',
      GOOGLE_ADS_CONVERSION_ACTION_FEED_EXPORTED: '111111',
      GOOGLE_ADS_CONVERSION_ACTION_PAYWALL_VIEW: '222222',
      GOOGLE_ADS_CONVERSION_ACTION_SIGN_UP: '444444',
    });
    arm('*');
    await seedEvent({
      kind: 'sign_up', emailSha256: GMAIL_VECTOR.sha256, gclid: null, ts: CUTOVER + 86400000,
    });
    const fetchMock = stubFetch(({ url }) => {
      if (url.includes('oauth2.googleapis.com')) return oauthResponse();
      throw new Error('the legacy path must not send an email-only row');
    });
    const result = await uploadPendingConversions(
      testEnv, { fetch: fetchMock as unknown as typeof fetch, now },
    );
    expect(result.attempted).toBe(0);
  });
});

// ─── Alerting: the three silent-failure holes ───────────────────────────────

describe('OCI: ociAlertReason', () => {
  const result = (over: Partial<OciResult>): OciResult => ({
    ranAt: FIXED_NOW, configured: true,
    candidates: 0, attempted: 0, uploaded: 0, failedThisRun: 0,
    markedPermanentlyFailed: 0, skippedExpired: 0,
    withUserData: 0, userDataFallbacks: 0,
    topErrorReasons: [], pendingUnconfigured: [], errors: [], ...over,
  });

  it('healthy run: no alert', () => {
    expect(ociAlertReason(result({ attempted: 5, uploaded: 5 }))).toBeNull();
  });

  it('HOLE 1 — configured:false on prod alerts (a rotated-away secret)', () => {
    expect(ociAlertReason(result({ configured: false }))).toBe('not-configured');
  });

  it('a deliberate non-prod skip does NOT alert', () => {
    expect(ociAlertReason(result({ configured: false, skippedReason: 'non-production origin' }))).toBeNull();
  });

  it('HOLE 2 — pending rows for a kind with no conversion action alerts', () => {
    expect(ociAlertReason(result({ pendingUnconfigured: [{ kind: 'sign_up', pending: 12 }] })))
      .toBe('unconfigured-kinds');
  });

  it('rejections still alert', () => {
    expect(ociAlertReason(result({ attempted: 2, failedThisRun: 1 }))).toBe('rejections');
    expect(ociAlertReason(result({ markedPermanentlyFailed: 1 }))).toBe('rejections');
  });

  it('a dry run never alerts', () => {
    expect(ociAlertReason(result({ dryRun: true, candidates: 2700 }))).toBeNull();
  });
});

describe('OCI: unconfigured kinds are surfaced by a real run', () => {
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    await dbRun(`DELETE FROM event`);
    clearSecrets();
    (testEnv as unknown as Record<string, unknown>).APP_ORIGIN = 'https://www.gtfsx.com';
  });

  it('reports pending rows whose kind has no conversion action id', async () => {
    withDataManager();
    delete (testEnv as unknown as Record<string, unknown>).GOOGLE_ADS_CONVERSION_ACTION_SIGN_UP;
    await seedEvent({ kind: 'sign_up', gclid: 'gSignup' });
    await seedEvent({ kind: 'sign_up', gclid: 'gSignup2' });

    const fetchMock = stubFetch(({ url }) => {
      if (url.includes('oauth2.googleapis.com')) return oauthResponse();
      throw new Error('sign_up is unconfigured — nothing should be sent');
    });
    const result = await uploadPendingConversions(
      testEnv, { fetch: fetchMock as unknown as typeof fetch, now },
    );
    expect(result.attempted).toBe(0);
    expect(result.pendingUnconfigured).toEqual([{ kind: 'sign_up', pending: 2 }]);
    expect(ociAlertReason(result)).toBe('unconfigured-kinds');
  });

  it('reports nothing when every kind is configured', async () => {
    withDataManager();
    await seedEvent({ kind: 'sign_up', gclid: 'gSignup' });
    const fetchMock = stubFetch(({ url }) => {
      if (url.includes('oauth2.googleapis.com')) return oauthResponse();
      return dmSuccessResponse();
    });
    const result = await uploadPendingConversions(
      testEnv, { fetch: fetchMock as unknown as typeof fetch, now },
    );
    expect(result.pendingUnconfigured).toEqual([]);
    expect(ociAlertReason(result)).toBeNull();
  });
});

// ─── Where the email comes from, per conversion kind ────────────────────────
//
// The `event` table has no user id and no plaintext email by design, so the
// hash is stamped at INSERT by whichever code path already holds the address.
// These tests pin which paths those are.

describe('OCI: hashed email at the emission sites', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    await dbRun(`DELETE FROM event`);
    clearSecrets();
    // Signup rolls itself back if the verify email fails, so the outbound
    // Resend call has to be stubbed for these routes to reach the event write.
    capture = setupEmailCapture();
  });

  afterEach(() => { capture.restore(); });

  it('sign_up (password signup): stamps the hashed account email', async () => {
    const client = makeClient();
    const res = await client.post('/auth/signup', {
      email: NON_GMAIL_VECTOR.raw,
      displayName: 'Convert',
      password: 'correct-horse-battery',
      gclid: 'GCLID-abc123',
    });
    expect(res.status).toBe(200);

    const ev = await dbGet<{ gclid: string | null; oci_email_sha256: string | null }>(
      `SELECT gclid, oci_email_sha256 FROM event WHERE kind = 'sign_up'`,
    );
    expect(ev!.gclid).toBe('GCLID-abc123');
    expect(ev!.oci_email_sha256).toBe(NON_GMAIL_VECTOR.sha256);
  });

  it('the plaintext address is NEVER written to the event row', async () => {
    const client = makeClient();
    await client.post('/auth/signup', {
      email: NON_GMAIL_VECTOR.raw,
      displayName: 'Convert',
      password: 'correct-horse-battery',
      gclid: 'GCLID-abc123',
    });
    const row = await dbGet<Record<string, unknown>>(`SELECT * FROM event WHERE kind = 'sign_up'`);
    const serialized = JSON.stringify(row).toLowerCase();
    expect(serialized).not.toContain('example.com');
    expect(serialized).not.toContain('user.name');
  });

  it('demo_request: stamps the hashed LEAD email from the form', async () => {
    const client = makeClient();
    const res = await client.post('/api/demo-leads', {
      name: 'Sam Planner',
      email: `  ${GMAIL_VECTOR.raw.toUpperCase()}  `,
      org: 'Valley Transit',
      gclid: 'GCLID-demo',
    });
    expect(res.status).toBe(200);

    const ev = await dbGet<{ kind: string; oci_email_sha256: string | null }>(
      `SELECT kind, oci_email_sha256 FROM event WHERE kind = 'demo_request'`,
    );
    // Normalization is applied before hashing: case + gmail dots/+tag folded.
    expect(ev!.oci_email_sha256).toBe(GMAIL_VECTOR.sha256);
  });

  // NOTE: the real SPA beacon sends `credentials: 'omit'`, so in a live browser
  // this branch is never reached and paywall_view / feed_exported upload on
  // their click id alone. The test client DOES send the cookie, which is what
  // makes the branch observable here. See the comment in worker/events/routes.ts.
  it('beacon: a CREDENTIALED conversion carries the hashed account email', async () => {
    const u = await seedUser({ email: NON_GMAIL_VECTOR.raw.toLowerCase() });
    const client = makeClient();
    await client.post('/auth/login', { email: u.email, password: u.password });

    const res = await client.post('/api/events/track', {
      kind: 'feed_exported', path: '/editor', sessionId: 'sess-abcdef12', gclid: 'GCLID-beacon',
    });
    expect(res.status).toBe(204);

    const ev = await dbGet<{ oci_email_sha256: string | null }>(
      `SELECT oci_email_sha256 FROM event WHERE kind = 'feed_exported'`,
    );
    expect(ev!.oci_email_sha256).toBe(NON_GMAIL_VECTOR.sha256);
  });

  it('beacon: an ANONYMOUS conversion carries no identifier at all', async () => {
    const client = makeClient();
    await client.post('/api/events/track', {
      kind: 'paywall_view', path: '/editor', sessionId: 'sess-anon1234', gclid: 'GCLID-anon',
    });
    const ev = await dbGet<{ gclid: string | null; oci_email_sha256: string | null }>(
      `SELECT gclid, oci_email_sha256 FROM event WHERE kind = 'paywall_view'`,
    );
    expect(ev!.gclid).toBe('GCLID-anon');
    expect(ev!.oci_email_sha256).toBeNull();
  });

  it('beacon: NON-conversion kinds are never stamped, even when signed in', async () => {
    const u = await seedUser({ email: 'pageviewer@example.com' });
    const client = makeClient();
    await client.post('/auth/login', { email: u.email, password: u.password });

    await client.post('/api/events/track', {
      kind: 'page_view', path: '/', sessionId: 'sess-pv123456',
    });
    await client.post('/api/events/track', {
      kind: 'editor_loaded', path: '/editor', sessionId: 'sess-pv123456',
    });
    const rows = await testEnv.DB.prepare(
      `SELECT kind, oci_email_sha256 FROM event WHERE kind IN ('page_view','editor_loaded')`,
    ).all<{ kind: string; oci_email_sha256: string | null }>();
    expect(rows.results).toHaveLength(2);
    for (const r of rows.results!) expect(r.oci_email_sha256).toBeNull();
  });
});
