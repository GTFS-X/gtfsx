// Google Ads Offline Conversion Import (OCI) — server-side conversion
// uploader. Pushes click-id-stamped `event` rows (feed_exported, paywall_view,
// demo_request, sign_up) to Google Ads as offline conversions. This is the cookieless
// replacement for the standard gtag.js conversion pixel and preserves the
// locked no-cookies analytics architecture (see docs/GOOGLE_ADS_PLAN.md §3.2).
//
// Flow:
//   1. Read OCI config from env. Bail (no-op) if any core secret is missing —
//      Mark hasn't run the one-time OAuth setup yet. See README.md.
//   2. Query `event` rows that carry an ad click id, oci_uploaded_at IS NULL,
//      kind IN (the kinds whose conversion action is configured),
//      ts > now - 90 days.
//      (Older click ids are silently dropped — Google rejects them anyway.)
//   3. Exchange the long-lived refresh token for a short-lived access token.
//   4. POST each row to the Data Manager API's events:ingest (one event per
//      request, so every row gets an unambiguous accept/reject), or — on the
//      dead legacy fallback — batches to uploadClickConversions.
//   5. Per row: success → set oci_uploaded_at = now (idempotent for future
//      runs). Failure → increment oci_attempts and store oci_last_error.
//      Once oci_attempts >= MAX_ATTEMPTS we set oci_uploaded_at = -1 as a
//      "permanently failed, stop retrying" sentinel.
//
// USER IDENTIFIERS (2026-08). When a row carries hex(sha256(normalized email))
// in `event.oci_email_sha256` (migration 0032) the Data Manager path also sends
// it as `userData.userIdentifiers[].emailAddress`, with the top-level
// `encoding: "HEX"` that field requires. The email RIDES ALONG with the click
// id — it does NOT change which rows are candidates. See the
// GOOGLE_ADS_UPLOAD_WITHOUT_CLICK_ID note on emailOnlyCutover() for why that
// separation matters.
//
// The destination account has NOT yet accepted Google's customer-data terms, so
// a userData-bearing event is currently rejected with
// DESTINATION_ACCOUNT_ENHANCED_CONVERSIONS_TERMS_NOT_SIGNED. Rather than take
// the working pipeline down, a row rejected for THAT reason (matched on the
// structured error reason, never on message text) is retried once without
// userData and the retry decides the row's fate. Today that means uploads
// behave exactly as they did before; the day the terms are accepted, hashed
// emails start flowing with no deploy.

import type { Env } from '../../env';
import { sendOciAlert } from '../../email';
import { isSha256Hex, redactHash } from './userIdentifiers';

// Google Ads API version. Bump to the latest stable when the current version
// is sunset (Google retires major versions ~14 months after release). The
// uploadClickConversions endpoint shape has been stable since v3; bumping the
// version string is usually sufficient (verified against the v24 proto: the
// request/ClickConversion/response fields we use are unchanged — v24 only
// *adds* an optional job_id we don't send or read). Last bumped 2026-06-22
// (v17 → v24). Release notes: https://developers.google.com/google-ads/api/docs/release-notes
const API_VERSION = 'v24';
// Data Manager API — Google's supported endpoint for offline event ingestion
// (the replacement this account was told to use). Versionless host path.
const DATA_MANAGER_ENDPOINT = 'https://datamanager.googleapis.com/v1/events:ingest';
// Google Ads uploadClickConversions accepts up to 2000 conversions per call;
// keep below that with headroom in case we ever extend the payload shape.
const BATCH_SIZE = 1000;
// gclids expire from Google Ads' side at ~90 days. Drop anything older.
const GCLID_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 3;
// Uploads only run on the production Worker. Even though staging normally lacks
// the GOOGLE_ADS_* secrets (readOciConfig → null), gate explicitly on the prod
// origin so a copied secret can never fire test/staging traffic into the live
// Google Ads account. env.APP_ORIGIN is 'https://www.gtfsx.com' on prod and
// 'https://staging.gtfsx.com' on staging (wrangler.jsonc vars).
const PROD_ORIGIN = 'https://www.gtfsx.com';
// Conversion kinds we can upload. Anything not in this set is ignored by the
// uploader; the per-run SQL WHERE clause narrows further to the kinds whose
// conversion action is actually configured (see configuredKinds).
export type UploadedKind = 'feed_exported' | 'paywall_view' | 'demo_request' | 'sign_up';
const ALL_UPLOAD_KINDS: UploadedKind[] = ['feed_exported', 'paywall_view', 'demo_request', 'sign_up'];

export interface OciConfig {
  developerToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  customerId: string;
  // feed_exported / paywall_view are required — the uploader refuses to run
  // without them (live in prod since 2026-05-26). demo_request and sign_up are
  // OPTIONAL: making either required would silently no-op the two live uploads
  // until Mark creates the new conversion action in the Ads UI. Unset simply
  // means that kind's rows stay pending (and are surfaced on the admin status
  // page) until GOOGLE_ADS_CONVERSION_ACTION_DEMO_REQUEST /
  // GOOGLE_ADS_CONVERSION_ACTION_SIGN_UP is set.
  conversionActions: ConversionActionMap;
}

// ─── Data Manager API config ────────────────────────────────────────────────
// The Data Manager API (datamanager.googleapis.com) is Google's supported
// replacement for the de-allowlisted ConversionUploadService. It needs NO
// developer token and NO login-customer-id header — the login/manager account
// is carried in the request body. It reuses the existing OAuth client
// (GOOGLE_ADS_CLIENT_ID/SECRET) but the refresh token must be minted with the
// `https://www.googleapis.com/auth/datamanager` scope, and the request carries
// an x-goog-user-project header naming the GCP project. See README.md.
export interface DataManagerConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string; // datamanager-scoped
  projectId: string; // x-goog-user-project
  operatingAccountId: string; // conversion (operating) account, no hyphens
  loginAccountId?: string; // manager (MCC) account, when accessed via one
  conversionActions: ConversionActionMap;
}

// Conversion-action IDs per kind — the shape shared by both the legacy and the
// Data Manager configs (feed/paywall required, demo/sign_up optional).
export interface ConversionActionMap {
  feed_exported: string;
  paywall_view: string;
  demo_request?: string;
  sign_up?: string;
}

// The kinds this config can actually upload, in ALL_UPLOAD_KINDS order.
export function configuredKinds(cfg: { conversionActions: ConversionActionMap }): UploadedKind[] {
  return ALL_UPLOAD_KINDS.filter((k) => cfg.conversionActions[k] !== undefined);
}

export interface OciResult {
  ranAt: number;
  configured: boolean;
  // Set when the run short-circuited without attempting anything (e.g. a
  // non-production origin). Distinguishes a deliberate skip from configured:false.
  skippedReason?: string;
  // Rows the candidate query returned. Equals `attempted` for a normal run and
  // diverges only under dryRun, where nothing is sent.
  candidates: number;
  // Counts across this run. `attempted` counts rows actually sent (after the
  // 90-day cutoff filter); `uploaded` counts rows Google accepted.
  attempted: number;
  uploaded: number;
  failedThisRun: number;
  markedPermanentlyFailed: number;
  skippedExpired: number;
  // Rows whose upload carried a hashed email as a user identifier.
  withUserData: number;
  // Rows Google rejected for the enhanced-conversions terms gate and that we
  // re-sent without userData. >0 means the account terms are still outstanding.
  userDataFallbacks: number;
  // Structured Google error reasons seen this run, most frequent first. Reasons
  // are exact enum tokens from the response, not message text.
  topErrorReasons: Array<{ reason: string; count: number }>;
  // Kinds that have pending rows but NO configured conversion action, so their
  // rows are never even selected. Silent starvation until now — surfaced so the
  // caller can alert on it.
  pendingUnconfigured: Array<{ kind: UploadedKind; pending: number }>;
  // True when the run only counted candidates and sent/wrote nothing.
  dryRun?: boolean;
  // Per-row errors from this run (truncated for log noise).
  errors: Array<{ id: string; gclid: string; message: string }>;
}

/**
 * Per-invocation overrides. The cron passes NOTHING — its behaviour must stay
 * byte-identical to what ships today. Everything here exists for the deliberate,
 * owner-triggered historical backfill (see the admin oci-backfill endpoint and
 * README "Draining the organic backlog").
 */
export interface UploadOptions {
  /**
   * Also consider rows with NO ad click id, on the strength of their hashed
   * email alone. Default: whatever readEmailOnlyCutover(env) resolves, which is
   * off unless BOTH the flag and a cutover timestamp are configured.
   */
  allowMissingClickId?: boolean;
  /** Lower bound (exclusive) on event ts for email-only rows. */
  emailOnlySince?: number;
  /** Extra lower bound (exclusive) on event ts for ALL candidates. */
  since?: number;
  /** Extra upper bound (inclusive) on event ts for ALL candidates. */
  until?: number;
  /** Cap on rows considered this run. Defaults to BATCH_SIZE * 5. */
  limit?: number;
  /** Count candidates, send nothing, write nothing. */
  dryRun?: boolean;
}

export interface UploaderDeps {
  // Override fetch in tests. Defaults to global fetch.
  fetch?: typeof fetch;
  // Override "now" in tests for deterministic timestamps.
  now?: () => number;
}

// ─── Config ───────────────────────────────────────────────────────────────

export function readOciConfig(env: Env): OciConfig | null {
  const dev = env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const cid = env.GOOGLE_ADS_CLIENT_ID;
  const cs = env.GOOGLE_ADS_CLIENT_SECRET;
  const rt = env.GOOGLE_ADS_REFRESH_TOKEN;
  const cust = env.GOOGLE_ADS_CUSTOMER_ID;
  const feedAction = env.GOOGLE_ADS_CONVERSION_ACTION_FEED_EXPORTED;
  const paywallAction = env.GOOGLE_ADS_CONVERSION_ACTION_PAYWALL_VIEW;
  // Optional — see the OciConfig.conversionActions comment above.
  const demoAction = env.GOOGLE_ADS_CONVERSION_ACTION_DEMO_REQUEST;
  const signUpAction = env.GOOGLE_ADS_CONVERSION_ACTION_SIGN_UP;
  if (!dev || !cid || !cs || !rt || !cust || !feedAction || !paywallAction) {
    return null;
  }
  return {
    developerToken: dev,
    clientId: cid,
    clientSecret: cs,
    refreshToken: rt,
    customerId: cust,
    conversionActions: {
      feed_exported: feedAction,
      paywall_view: paywallAction,
      ...(demoAction ? { demo_request: demoAction } : {}),
      ...(signUpAction ? { sign_up: signUpAction } : {}),
    },
  };
}

// Data Manager config. Present (→ preferred over legacy) only when BOTH the
// datamanager-scoped refresh token AND the GCP project id are set. Everything
// else is reused from the GOOGLE_ADS_* secrets.
export function readDataManagerConfig(env: Env): DataManagerConfig | null {
  const rt = env.GOOGLE_DATAMANAGER_REFRESH_TOKEN;
  const projectId = env.GOOGLE_DATAMANAGER_PROJECT_ID;
  const cid = env.GOOGLE_ADS_CLIENT_ID;
  const cs = env.GOOGLE_ADS_CLIENT_SECRET;
  const cust = env.GOOGLE_ADS_CUSTOMER_ID;
  const feedAction = env.GOOGLE_ADS_CONVERSION_ACTION_FEED_EXPORTED;
  const paywallAction = env.GOOGLE_ADS_CONVERSION_ACTION_PAYWALL_VIEW;
  const demoAction = env.GOOGLE_ADS_CONVERSION_ACTION_DEMO_REQUEST;
  const signUpAction = env.GOOGLE_ADS_CONVERSION_ACTION_SIGN_UP;
  if (!rt || !projectId || !cid || !cs || !cust || !feedAction || !paywallAction) {
    return null;
  }
  return {
    clientId: cid,
    clientSecret: cs,
    refreshToken: rt,
    projectId,
    operatingAccountId: cust,
    // Include the manager account only when one is configured; when the user
    // has direct access it's omitted (see README "Data Manager API").
    loginAccountId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || undefined,
    conversionActions: {
      feed_exported: feedAction,
      paywall_view: paywallAction,
      ...(demoAction ? { demo_request: demoAction } : {}),
      ...(signUpAction ? { sign_up: signUpAction } : {}),
    },
  };
}

// ─── Email-only candidates (default OFF) ────────────────────────────────────
//
// Attaching a hashed email makes rows WITHOUT a click id technically
// uploadable for the first time. Prod D1 holds thousands of such rows going
// back to 2026-05 — overwhelmingly organic traffic that was never an ad
// conversion. Letting them become candidates would dump the whole backlog into
// the live Google Ads account on the next cron run: large, irreversible, and
// nobody asked for it.
//
// So this is a capability, not a behaviour change. TWO things must be true:
//   1. GOOGLE_ADS_UPLOAD_WITHOUT_CLICK_ID is explicitly enabled, and
//   2. GOOGLE_ADS_UPLOAD_WITHOUT_CLICK_ID_SINCE names a cutover timestamp.
// The cutover is mandatory precisely so flipping the flag alone can never
// retroactively drain history: with no cutover we log loudly and stay off.

function truthy(v: string | undefined): boolean {
  return v === '1' || v?.toLowerCase() === 'true';
}

/** Parse a cutover as unix-ms digits or any Date-parseable string (e.g. ISO 8601). */
export function parseCutover(raw: string | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * The cutover timestamp for email-only candidates, or null when the capability
 * is off. Null is the default and the fail-safe: any misconfiguration (flag on
 * with no cutover, or an unparseable cutover) resolves to null.
 */
export function readEmailOnlyCutover(env: Env): number | null {
  if (!truthy(env.GOOGLE_ADS_UPLOAD_WITHOUT_CLICK_ID)) return null;
  const cutover = parseCutover(env.GOOGLE_ADS_UPLOAD_WITHOUT_CLICK_ID_SINCE);
  if (cutover === null) {
    console.warn(
      '[oci] GOOGLE_ADS_UPLOAD_WITHOUT_CLICK_ID is on but '
      + 'GOOGLE_ADS_UPLOAD_WITHOUT_CLICK_ID_SINCE is missing or unparseable — '
      + 'staying OFF. A cutover is mandatory so enabling the flag can never drain history.',
    );
    return null;
  }
  return cutover;
}

// ─── OAuth ────────────────────────────────────────────────────────────────

interface OAuthTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

export async function exchangeRefreshToken(
  cfg: { clientId: string; clientSecret: string; refreshToken: string },
  deps: UploaderDeps = {},
): Promise<string> {
  const fetchImpl = deps.fetch ?? fetch;
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: cfg.refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OAuth token exchange failed: ${res.status} ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as OAuthTokenResponse;
  if (!data.access_token) {
    throw new Error('OAuth token exchange returned no access_token');
  }
  return data.access_token;
}

// ─── Payload helpers ──────────────────────────────────────────────────────

// Google Ads requires conversion_date_time in the format
//   "yyyy-mm-dd hh:mm:ss±hh:mm"
// We emit UTC ("+00:00") so we don't have to deal with Mountain DST swings.
// Google normalizes to the account timezone server-side for reporting.
export function formatConversionDateTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+00:00`
  );
}

export interface PendingRow {
  id: string;
  ts: number;
  kind: UploadedKind;
  // A row carries at most one of these (first-touch wins client-side). The
  // legacy path uploads gclid only; the Data Manager path uploads whichever
  // one is present (gbraid/wbraid close the iOS/consent attribution hole).
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
  attempts: number;
  // hex(sha256(normalized email)) from event.oci_email_sha256, or null. Sent as
  // a Data Manager user identifier ALONGSIDE the ad identifier when present.
  // Anything that isn't a well-formed 64-char lowercase hex digest is treated
  // as absent — we never put a malformed identifier on the wire.
  emailSha256: string | null;
}

/** True when the row has at least one Google-acceptable identifier. */
export function hasAdIdentifier(row: PendingRow): boolean {
  return !!(row.gclid || row.gbraid || row.wbraid);
}

/** True when the row carries a usable hashed email. */
export function hasUserIdentifier(row: PendingRow): boolean {
  return isSha256Hex(row.emailSha256);
}

// The identifier we'd report/upload for a row, gclid first. Used for logging
// and the legacy payload; the DM path builds adIdentifiers explicitly. An
// email-only row has no click id at all — report the redacted hash instead of
// an empty string so an error line still says which row it was about, without
// exposing a full digest.
export function rowIdentifier(row: PendingRow): string {
  return row.gclid ?? row.gbraid ?? row.wbraid
    ?? (isSha256Hex(row.emailSha256) ? `email:${redactHash(row.emailSha256)}` : '');
}

export interface UploadPayloadConversion {
  gclid: string;
  conversion_action: string;
  conversion_date_time: string;
}

export function buildConversionPayload(
  cfg: OciConfig,
  rows: PendingRow[],
): { conversions: UploadPayloadConversion[]; partial_failure: boolean; validate_only: boolean } {
  return {
    conversions: rows.map((r) => {
      // loadPending only selects kinds present in cfg.conversionActions, so
      // this lookup can't miss — the throw is a tripwire for future drift.
      const actionId = cfg.conversionActions[r.kind];
      if (!actionId) {
        throw new Error(`No conversion action configured for kind '${r.kind}'`);
      }
      // The legacy path uploads gclid only; loadPending (legacy mode) selects
      // gclid rows, so this is present. Braid-only rows go via the DM path.
      if (!r.gclid) {
        throw new Error(`Legacy path row '${r.id}' has no gclid`);
      }
      return {
        gclid: r.gclid,
        conversion_action: `customers/${cfg.customerId}/conversionActions/${actionId}`,
        conversion_date_time: formatConversionDateTime(r.ts),
        // No conversion_value — all Google Ads conversion actions are
        // configured "Don't use a value" (handoff §2). Sending one would
        // cause Google to silently flip them to value-using mode.
      };
    }),
    partial_failure: true,
    validate_only: false,
  };
}

// ─── Upload ───────────────────────────────────────────────────────────────

// uploadClickConversions response shape we care about. Successful conversions
// echo back in `results`; per-row failures appear in `partialFailureError`
// as a google.rpc.Status with embedded GoogleAdsFailure details containing
// the offending conversion index.
//
// CASING: the Google Ads REST API returns proto3-JSON in **camelCase**
// (`partialFailureError`, `fieldPathElements`, `fieldName`) even though it
// accepts snake_case in the REQUEST. Reading the response as snake_case (the
// original bug) made extractRowErrors always return empty → every rejected row
// was marked "uploaded", which silently masked a month-long outage when the
// account was de-allowlisted from this endpoint. We read camelCase and keep a
// snake_case fallback so a shape change in either direction can't re-hide
// failures.
interface PartialFailure {
  code?: number;
  message?: string;
  details?: Array<{
    errors?: Array<{
      message?: string;
      location?: {
        fieldPathElements?: PathElement[];
        field_path_elements?: PathElement[];
      };
    }>;
  }>;
}
interface PathElement { fieldName?: string; field_name?: string; index?: number }
interface UploadClickConversionsResponse {
  results?: Array<{ gclid?: string; conversionAction?: string }>;
  partialFailureError?: PartialFailure;
  partial_failure_error?: PartialFailure;
}

// The top-level partial-failure status, whichever casing Google used.
function partialFailure(resp: UploadClickConversionsResponse): PartialFailure | undefined {
  return resp.partialFailureError ?? resp.partial_failure_error;
}

function extractRowErrors(resp: UploadClickConversionsResponse): Map<number, string> {
  const errs = new Map<number, string>();
  for (const d of partialFailure(resp)?.details ?? []) {
    for (const e of d.errors ?? []) {
      const loc = e.location ?? {};
      const path = loc.fieldPathElements ?? loc.field_path_elements ?? [];
      // The row index lives on the `conversions[N]` path element — the only one
      // that carries a numeric index. Match on the index itself, not a field
      // name: the request field is `conversions` (not `operations`, which is
      // the mutate-endpoint name the original code wrongly looked for), and we
      // don't want to depend on that name or the JSON casing.
      const indexed = path.find((p) => typeof p.index === 'number');
      if (indexed && typeof indexed.index === 'number') {
        errs.set(indexed.index, (e.message ?? 'unknown error').slice(0, 500));
      }
    }
  }
  return errs;
}

async function postBatch(
  cfg: OciConfig,
  accessToken: string,
  payload: ReturnType<typeof buildConversionPayload>,
  deps: UploaderDeps,
): Promise<UploadClickConversionsResponse> {
  const fetchImpl = deps.fetch ?? fetch;
  const url = `https://googleads.googleapis.com/${API_VERSION}/customers/${cfg.customerId}:uploadClickConversions`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'developer-token': cfg.developerToken,
      'login-customer-id': cfg.customerId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`uploadClickConversions HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text) as UploadClickConversionsResponse;
}

// ─── Data Manager upload ────────────────────────────────────────────────────

// The ad identifier for a row — gclid preferred, else gbraid, else wbraid. The
// Data Manager API accepts exactly these keys under adIdentifiers.
export function buildAdIdentifiers(row: PendingRow): Record<string, string> {
  if (row.gclid) return { gclid: row.gclid };
  if (row.gbraid) return { gbraid: row.gbraid };
  if (row.wbraid) return { wbraid: row.wbraid };
  return {};
}

export interface IngestBodyOptions {
  /**
   * Attach the row's hashed email as a user identifier. Default true. Set false
   * to rebuild the same event without userData — the one-shot retry we perform
   * when Google rejects the event for the enhanced-conversions terms gate.
   */
  includeUserData?: boolean;
}

// One Data Manager events:ingest request body for a single row. We send one
// event per request (volume is tiny) so each row gets an unambiguous accept/
// reject and its own transactionId dedup — events:ingest partial-failure
// semantics aren't documented, so per-event is the safe, correct choice.
export function buildIngestBody(
  cfg: DataManagerConfig,
  row: PendingRow,
  opts: IngestBodyOptions = {},
): Record<string, unknown> {
  const actionId = cfg.conversionActions[row.kind];
  if (!actionId) {
    throw new Error(`No conversion action configured for kind '${row.kind}'`);
  }
  const destination: Record<string, unknown> = {
    operatingAccount: { accountType: 'GOOGLE_ADS', accountId: cfg.operatingAccountId },
    productDestinationId: actionId,
  };
  if (cfg.loginAccountId) {
    destination.loginAccount = { accountType: 'GOOGLE_ADS', accountId: cfg.loginAccountId };
  }

  const adIdentifiers = buildAdIdentifiers(row);
  const withUserData = opts.includeUserData !== false && hasUserIdentifier(row);
  // An event with neither an ad identifier nor a user identifier is a hard
  // Google failure (NO_IDENTIFIERS_PROVIDED). Refuse to build it at all — a
  // throw here is a caller bug, and the caller records it as a row failure
  // rather than sending garbage.
  if (Object.keys(adIdentifiers).length === 0 && !withUserData) {
    throw new Error(
      `Row '${row.id}' has neither an ad identifier nor a user identifier — refusing to build an event`,
    );
  }

  const event: Record<string, unknown> = {
    // RFC 3339; Google normalizes to the account timezone for reporting.
    eventTimestamp: new Date(row.ts).toISOString(),
    // Dedup key: our row id (ulid). Re-uploading the same row (e.g. the
    // requeue recovery) sends the same transactionId, so Google de-dupes and
    // it can't double-count.
    transactionId: row.id,
    eventSource: 'WEB',
    // No conversionValue/currency — the actions are "Don't use a value".
  };
  // Omit the key entirely rather than sending an empty object: an email-only
  // event has no ad identifier at all.
  if (Object.keys(adIdentifiers).length > 0) event.adIdentifiers = adIdentifiers;
  if (withUserData) {
    // userData is a SIBLING of adIdentifiers, not nested inside it. Max 10
    // identifiers per event; we send exactly one.
    event.userData = { userIdentifiers: [{ emailAddress: row.emailSha256 }] };
  }

  const body: Record<string, unknown> = {
    destinations: [destination],
    events: [event],
    validateOnly: false,
  };
  // Conditionally required: the moment ANY event in the request carries
  // userData, the top-level encoding must say how the digest bytes were
  // encoded. Omitted otherwise, so click-id-only requests are byte-identical
  // to what shipped before this change.
  if (withUserData) body.encoding = 'HEX';
  return body;
}

// ─── Data Manager error reasons ─────────────────────────────────────────────
//
// A rejected events:ingest returns a google.rpc.Status. The useful signal is
// the STRUCTURED reason token, which appears in two places (verbatim from a
// live validateOnly probe, 2026-08-08):
//
//   error.details[] = [
//     { "@type": ".../google.rpc.ErrorInfo",  "reason": "INVALID_ARGUMENT", ... },
//     { "@type": ".../google.rpc.RequestInfo", "requestId": "t-…" },
//     { "@type": ".../google.rpc.BadRequest",
//       "fieldViolations": [{
//         "field": "events.events[0].destination_references[0]",
//         "description": "The destination account hasn't agreed to the terms for enhanced conversions.",
//         "reason": "DESTINATION_ACCOUNT_ENHANCED_CONVERSIONS_TERMS_NOT_SIGNED" }] }
//   ]
//
// We read `reason` only. Matching on the human-readable `description`/`message`
// would break the moment Google rewords it, and matching on the bare 400 would
// silently swallow unrelated failures.

interface DataManagerErrorDetail {
  '@type'?: string;
  reason?: string;
  fieldViolations?: Array<{ field?: string; reason?: string; description?: string }>;
}
interface DataManagerErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: DataManagerErrorDetail[];
  };
}

/** Every structured reason token in a Data Manager error body, in order. */
export function extractErrorReasons(parsed: unknown): string[] {
  const body = parsed as DataManagerErrorBody | null | undefined;
  const reasons: string[] = [];
  for (const detail of body?.error?.details ?? []) {
    if (typeof detail?.reason === 'string') reasons.push(detail.reason);
    for (const violation of detail?.fieldViolations ?? []) {
      if (typeof violation?.reason === 'string') reasons.push(violation.reason);
    }
  }
  return reasons;
}

/**
 * Reasons that mean "this account may not send user-provided data (yet)".
 * All three are account-state gates, not payload problems: the identical event
 * without userData is perfectly acceptable, which is exactly why we retry.
 */
export const TERMS_GATE_REASONS: ReadonlySet<string> = new Set([
  'DESTINATION_ACCOUNT_ENHANCED_CONVERSIONS_TERMS_NOT_SIGNED',
  'TERMS_AND_CONDITIONS_NOT_SIGNED',
  'DESTINATION_ACCOUNT_DATA_POLICY_PROHIBITS_ENHANCED_CONVERSIONS',
]);

/** Exact-token match against TERMS_GATE_REASONS — never a substring search. */
export function isTermsGateError(reasons: string[]): boolean {
  return reasons.some((r) => TERMS_GATE_REASONS.has(r));
}

interface IngestEventsResponse {
  requestId?: string;
  // Defensive: some ingestion surfaces echo per-event problems in a 200 body.
  // Treat any error signal as a failure — never repeat the legacy bug of
  // marking a rejected row "uploaded".
  error?: { message?: string };
  errors?: unknown[];
  warnings?: unknown[];
}

/** One POST to events:ingest. `error` is null on acceptance. */
interface IngestAttempt {
  error: string | null;
  reasons: string[];
}

async function postIngest(
  cfg: DataManagerConfig,
  accessToken: string,
  body: Record<string, unknown>,
  deps: UploaderDeps,
): Promise<IngestAttempt> {
  const fetchImpl = deps.fetch ?? fetch;
  const res = await fetchImpl(DATA_MANAGER_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'x-goog-user-project': cfg.projectId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: (IngestEventsResponse & DataManagerErrorBody) | null;
  try {
    parsed = text ? (JSON.parse(text) as IngestEventsResponse & DataManagerErrorBody) : {};
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    return {
      error: `events:ingest HTTP ${res.status}: ${text.slice(0, 500)}`,
      reasons: extractErrorReasons(parsed),
    };
  }
  // A 2xx with an unparseable body — treat as accepted (nothing to object to).
  if (parsed === null) return { error: null, reasons: [] };
  if (parsed.error?.message) {
    return { error: parsed.error.message.slice(0, 500), reasons: extractErrorReasons(parsed) };
  }
  if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
    return { error: JSON.stringify(parsed.errors).slice(0, 500), reasons: [] };
  }
  return { error: null, reasons: [] };
}

/** Outcome of ingesting one row, including whether the terms fallback fired. */
export interface IngestOutcome {
  /** null on success; otherwise the error recorded against the row. */
  error: string | null;
  /** True when the accepted/failed attempt carried a hashed email. */
  sentUserData: boolean;
  /** True when the first attempt hit the terms gate and we re-sent without userData. */
  termsFallback: boolean;
  /** Structured reasons from the attempt that decided this row. */
  reasons: string[];
}

// Ingest a single row via the Data Manager API.
//
// The terms-gate fallback is the whole reason this isn't a one-liner: the
// account has not accepted the customer-data terms, so a userData-bearing event
// is rejected today. Rather than regress every currently-succeeding upload into
// a 400, we notice THAT SPECIFIC reason and re-send the identical event without
// userData; the retry's outcome becomes the row's outcome. Any other 400 — bad
// action id, malformed timestamp, expired click id — fails the row as before.
async function ingestOne(
  cfg: DataManagerConfig,
  accessToken: string,
  row: PendingRow,
  deps: UploaderDeps,
): Promise<IngestOutcome> {
  const withUserData = hasUserIdentifier(row);
  const first = await postIngest(cfg, accessToken, buildIngestBody(cfg, row), deps);
  if (first.error === null) {
    return { error: null, sentUserData: withUserData, termsFallback: false, reasons: [] };
  }
  // Only retry when (a) we actually sent userData, (b) Google's structured
  // reason is the terms gate, and (c) the row still has an ad identifier to
  // fall back TO — an email-only row has nothing left to send.
  if (withUserData && isTermsGateError(first.reasons) && hasAdIdentifier(row)) {
    const retry = await postIngest(
      cfg, accessToken, buildIngestBody(cfg, row, { includeUserData: false }), deps,
    );
    return { error: retry.error, sentUserData: false, termsFallback: true, reasons: retry.reasons };
  }
  return { error: first.error, sentUserData: withUserData, termsFallback: false, reasons: first.reasons };
}

// ─── DB ────────────────────────────────────────────────────────────────────

// SQL predicate for "row carries an ad identifier we can upload". The legacy
// path handles gclid only; the Data Manager path also handles gbraid/wbraid.
function identifierSql(includeBraids: boolean): string {
  return includeBraids
    ? '(gclid IS NOT NULL OR gbraid IS NOT NULL OR wbraid IS NOT NULL)'
    : 'gclid IS NOT NULL';
}

/**
 * The candidate predicate plus its bindings.
 *
 * DEFAULT (emailOnlySince === null): identical to what has always shipped — a
 * row needs an ad click id, full stop. A hashed email is an EXTRA identifier
 * that rides along on those rows; it never widens the candidate set.
 *
 * Only when the capability is explicitly enabled (see readEmailOnlyCutover)
 * does the second disjunct appear, and even then it is bounded by the cutover
 * so history cannot be swept in.
 */
function candidateSql(
  includeBraids: boolean,
  emailOnlySince: number | null,
): { sql: string; binds: number[] } {
  const base = identifierSql(includeBraids);
  if (emailOnlySince === null) return { sql: base, binds: [] };
  return {
    sql: `(${base} OR (oci_email_sha256 IS NOT NULL AND ts > ?))`,
    binds: [emailOnlySince],
  };
}

interface LoadPendingArgs {
  now: number;
  limit: number;
  kinds: UploadedKind[];
  includeBraids: boolean;
  emailOnlySince: number | null;
  since?: number;
  until?: number;
}

// Only kinds whose conversion action is configured are selected — an
// unconfigured kind's rows stay pending (visible on the admin status page, and
// alerted on via pendingUnconfigured) instead of failing per-row against a
// missing action.
async function loadPending(env: Env, args: LoadPendingArgs): Promise<PendingRow[]> {
  const { now, limit, kinds, includeBraids, emailOnlySince, since, until } = args;
  const cutoff = now - GCLID_TTL_MS;
  const placeholders = kinds.map(() => '?').join(', ');
  const candidate = candidateSql(includeBraids, emailOnlySince);
  const extra: string[] = [];
  const extraBinds: number[] = [];
  if (since !== undefined) { extra.push('AND ts > ?'); extraBinds.push(since); }
  if (until !== undefined) { extra.push('AND ts <= ?'); extraBinds.push(until); }
  const res = await env.DB.prepare(
    `SELECT id, ts, kind, gclid, gbraid, wbraid,
            COALESCE(oci_attempts, 0) AS attempts,
            oci_email_sha256 AS emailSha256
       FROM event
      WHERE ${candidate.sql}
        AND oci_uploaded_at IS NULL
        AND kind IN (${placeholders})
        AND ts > ?
        ${extra.join('\n        ')}
      ORDER BY ts ASC
      LIMIT ?`,
  )
    .bind(...candidate.binds, ...kinds, cutoff, ...extraBinds, limit)
    .all<PendingRow>();
  return res.results ?? [];
}

/**
 * Kinds that have candidate rows waiting but no conversion-action id, so
 * loadPending never even selects them. Before this, such rows accumulated
 * forever with `attempted: 0` and no alert — the silent-failure hole from
 * §A1.5(2). Uses the SAME candidate predicate as loadPending so the count means
 * "rows this run would have sent, if the kind were configured".
 */
async function pendingUnconfiguredKinds(
  env: Env,
  now: number,
  configured: UploadedKind[],
  includeBraids: boolean,
  emailOnlySince: number | null,
): Promise<Array<{ kind: UploadedKind; pending: number }>> {
  const missing = ALL_UPLOAD_KINDS.filter((k) => !configured.includes(k));
  if (missing.length === 0) return [];
  const cutoff = now - GCLID_TTL_MS;
  const placeholders = missing.map(() => '?').join(', ');
  const candidate = candidateSql(includeBraids, emailOnlySince);
  const res = await env.DB.prepare(
    `SELECT kind, COUNT(*) AS pending
       FROM event
      WHERE ${candidate.sql}
        AND oci_uploaded_at IS NULL
        AND kind IN (${placeholders})
        AND ts > ?
      GROUP BY kind`,
  )
    .bind(...candidate.binds, ...missing, cutoff)
    .all<{ kind: UploadedKind; pending: number }>();
  return (res.results ?? []).filter((r) => r.pending > 0);
}

// Mark rows older than the 90-day cutoff so they stop showing as "pending"
// on the admin status page. Sentinel -1 = permanently dropped. Covers ALL
// upload kinds (not just the configured ones): Google would reject the stale
// identifier regardless, so an unconfigured kind's out-of-window rows are
// flagged too rather than pending forever. `includeBraids` matches the active
// path so we don't expire braid-only rows the legacy path can't send.
//
// DELIBERATELY ad-identifier-only: it does NOT take the email-only predicate.
// Widening it would stamp the -1 sentinel across thousands of historical
// organic rows on the first run after the flag flipped — a mass write to prod
// D1 dressed up as bookkeeping. Out-of-window email-only rows simply stay NULL,
// exactly as they do today.
async function markExpiredOnly(env: Env, now: number, includeBraids: boolean): Promise<number> {
  const cutoff = now - GCLID_TTL_MS;
  const placeholders = ALL_UPLOAD_KINDS.map(() => '?').join(', ');
  const res = await env.DB.prepare(
    `UPDATE event
        SET oci_uploaded_at = -1,
            oci_last_error = 'expired (>90 days)'
      WHERE ${identifierSql(includeBraids)}
        AND oci_uploaded_at IS NULL
        AND kind IN (${placeholders})
        AND ts <= ?`,
  )
    .bind(...ALL_UPLOAD_KINDS, cutoff)
    .run();
  return res.meta.changes ?? 0;
}

// ─── Row outcome (shared by both upload paths) ──────────────────────────────

async function markRowUploaded(env: Env, id: string, now: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE event SET oci_uploaded_at = ?, oci_last_error = NULL WHERE id = ?`,
  ).bind(now, id).run();
}

// Records a failed attempt. Returns true when this attempt tipped the row over
// MAX_ATTEMPTS into the permanent-fail sentinel (-1).
async function markRowFailed(env: Env, row: PendingRow, err: string): Promise<boolean> {
  const nextAttempts = row.attempts + 1;
  if (nextAttempts >= MAX_ATTEMPTS) {
    await env.DB.prepare(
      `UPDATE event SET oci_uploaded_at = -1, oci_attempts = ?, oci_last_error = ? WHERE id = ?`,
    ).bind(nextAttempts, err, row.id).run();
    return true;
  }
  await env.DB.prepare(
    `UPDATE event SET oci_attempts = ?, oci_last_error = ? WHERE id = ?`,
  ).bind(nextAttempts, err, row.id).run();
  return false;
}

// ─── Main entry ───────────────────────────────────────────────────────────

/** Empty counters, so every early return has the full OciResult shape. */
function emptyResult(now: number, partial: Partial<OciResult>): OciResult {
  return {
    ranAt: now, configured: false,
    candidates: 0, attempted: 0, uploaded: 0, failedThisRun: 0,
    markedPermanentlyFailed: 0, skippedExpired: 0,
    withUserData: 0, userDataFallbacks: 0,
    topErrorReasons: [], pendingUnconfigured: [], errors: [],
    ...partial,
  };
}

/** Reason tallies, most frequent first. */
function tallyReasons(reasons: string[]): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const r of reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
}

export async function uploadPendingConversions(
  env: Env,
  deps: UploaderDeps = {},
  opts: UploadOptions = {},
): Promise<OciResult> {
  const now = (deps.now ?? Date.now)();

  // Hard prod-only gate — see PROD_ORIGIN. Runs before config/DB work so a
  // non-prod worker is an immediate no-op.
  if (env.APP_ORIGIN !== PROD_ORIGIN) {
    console.warn(`[oci] skipped — non-production origin (${env.APP_ORIGIN}); uploads run on prod only`);
    return emptyResult(now, { skippedReason: `non-production origin (${env.APP_ORIGIN})` });
  }

  // Prefer the Data Manager API when its credentials are present; otherwise
  // fall back to the legacy uploadClickConversions path (dead at Google's side
  // but now loud on failure). Exactly one path is active per run.
  const dmCfg = readDataManagerConfig(env);
  const legacyCfg = dmCfg ? null : readOciConfig(env);
  const activeCfg = dmCfg ?? legacyCfg;
  if (!activeCfg) {
    // NOT a silent no-op any more: the caller alerts on configured:false with
    // no skippedReason. A rotated-away secret used to leave only this warn line
    // in a log nobody reads (§A1.5 hole 1).
    console.warn('[oci] NOT CONFIGURED — no upload path resolvable (see worker/marketing/ads/README.md)');
    return emptyResult(now, {});
  }
  const usingDataManager = dmCfg !== null;

  // Email-only candidates: off unless deliberately enabled. `opts` lets the
  // owner-triggered backfill widen this for one bounded run without touching
  // the env flag; the cron passes no opts and therefore gets the env default,
  // which is null (see readEmailOnlyCutover).
  const envCutover = readEmailOnlyCutover(env);
  let emailOnlySince: number | null = envCutover;
  if (opts.allowMissingClickId === true) {
    emailOnlySince = opts.emailOnlySince ?? envCutover;
    if (emailOnlySince === null) {
      throw new Error(
        'allowMissingClickId requires an emailOnlySince cutover — refusing to consider the entire history',
      );
    }
  } else if (opts.allowMissingClickId === false) {
    emailOnlySince = null;
  }
  // The legacy endpoint has no user-identifier field at all, so an email-only
  // row is unsendable there however the flag is set.
  if (!usingDataManager) emailOnlySince = null;

  const dryRun = opts.dryRun === true;
  const skippedExpired = dryRun ? 0 : await markExpiredOnly(env, now, usingDataManager);
  const kinds = configuredKinds(activeCfg);
  const pendingUnconfigured = await pendingUnconfiguredKinds(
    env, now, kinds, usingDataManager, emailOnlySince,
  );
  const rows = await loadPending(env, {
    now,
    limit: opts.limit ?? BATCH_SIZE * 5,
    kinds,
    includeBraids: usingDataManager,
    emailOnlySince,
    since: opts.since,
    until: opts.until,
  });

  if (rows.length === 0 || dryRun) {
    const withUserData = rows.filter(hasUserIdentifier).length;
    if (dryRun) {
      console.log(
        `[oci] DRY RUN — ${rows.length} candidate(s), ${withUserData} carrying a hashed email. `
        + 'Nothing sent, nothing written.',
      );
    }
    return emptyResult(now, {
      configured: true, candidates: rows.length, skippedExpired, pendingUnconfigured,
      ...(dryRun ? { dryRun: true, withUserData } : {}),
    });
  }

  const accessToken = await exchangeRefreshToken(activeCfg, deps);

  let uploaded = 0;
  let failedThisRun = 0;
  let markedPermanentlyFailed = 0;
  let withUserData = 0;
  let userDataFallbacks = 0;
  const allReasons: string[] = [];
  const errors: OciResult['errors'] = [];

  const recordFailure = async (row: PendingRow, err: string): Promise<void> => {
    failedThisRun++;
    errors.push({ id: row.id, gclid: rowIdentifier(row), message: err });
    if (await markRowFailed(env, row, err)) markedPermanentlyFailed++;
  };

  if (dmCfg) {
    // Data Manager path: one event per request → each row gets an unambiguous
    // accept/reject and its own transactionId dedup.
    for (const row of rows) {
      let outcome: IngestOutcome;
      try {
        outcome = await ingestOne(dmCfg, accessToken, row, deps);
      } catch (e) {
        outcome = {
          error: e instanceof Error ? e.message : String(e),
          sentUserData: false, termsFallback: false, reasons: [],
        };
      }
      if (outcome.termsFallback) userDataFallbacks++;
      if (outcome.sentUserData) withUserData++;
      allReasons.push(...outcome.reasons);
      if (outcome.error === null) {
        await markRowUploaded(env, row.id, now);
        uploaded++;
      } else {
        console.error('[oci] events:ingest failed:', outcome.error);
        await recordFailure(row, outcome.error);
      }
    }
    // ONE line per run, not one per row. Its presence is the standing signal
    // that the account's customer-data terms are still unsigned.
    if (userDataFallbacks > 0) {
      console.warn(
        `[oci] enhanced-conversions terms NOT accepted on the destination account: `
        + `${userDataFallbacks}/${rows.length} row(s) were re-sent without a hashed email. `
        + 'Uploads succeeded, but user identifiers are being dropped. Accept the customer-data '
        + 'terms in Google Ads (Goals → Conversions → Settings) to turn them on — no deploy needed.',
      );
    }
  } else {
    // Legacy uploadClickConversions path.
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const payload = buildConversionPayload(legacyCfg!, batch);

      let rowErrors = new Map<number, string>();
      try {
        const resp = await postBatch(legacyCfg!, accessToken, payload, deps);
        rowErrors = extractRowErrors(resp);
        // Safety net: if Google reported a partial failure but we mapped zero
        // per-row errors (a shape we don't recognize, or a batch-level error
        // with no conversion index), fail the WHOLE batch rather than silently
        // marking every row uploaded. Never mark a row success while Google is
        // unhappy.
        const pf = partialFailure(resp);
        if (pf && rowErrors.size === 0) {
          const msg = (pf.message ?? 'partial failure with no parseable row errors').slice(0, 500);
          console.error('[oci] unmapped partial failure — failing whole batch:', msg);
          for (let j = 0; j < batch.length; j++) rowErrors.set(j, msg);
        }
      } catch (err) {
        // Fatal (auth, network, malformed response) — treat every row as
        // failed-this-run so attempts increment and we retry next cron.
        const batchFatalError = err instanceof Error ? err.message : String(err);
        console.error('[oci] batch POST failed:', batchFatalError);
        for (let j = 0; j < batch.length; j++) rowErrors.set(j, batchFatalError.slice(0, 500));
      }

      for (let j = 0; j < batch.length; j++) {
        const row = batch[j];
        const err = rowErrors.get(j);
        if (err === undefined) {
          await markRowUploaded(env, row.id, now);
          uploaded++;
        } else {
          await recordFailure(row, err);
        }
      }
    }
  }

  const result: OciResult = {
    ranAt: now, configured: true,
    candidates: rows.length,
    attempted: rows.length, uploaded, failedThisRun,
    markedPermanentlyFailed, skippedExpired,
    withUserData, userDataFallbacks,
    topErrorReasons: tallyReasons(allReasons),
    pendingUnconfigured,
    errors: errors.slice(0, 50),
  };
  // The §A1.5 per-run summary: one structured line covering candidates,
  // attempted, succeeded, failed and the top error reasons.
  console.log('[oci] run summary', JSON.stringify({
    candidates: result.candidates,
    attempted: result.attempted,
    uploaded: result.uploaded,
    failed: result.failedThisRun,
    permanentlyFailed: result.markedPermanentlyFailed,
    expired: result.skippedExpired,
    withUserData: result.withUserData,
    userDataFallbacks: result.userDataFallbacks,
    topErrorReasons: result.topErrorReasons,
    pendingUnconfigured: result.pendingUnconfigured,
    // Never a full digest — see redactHash.
    sampleUserIdentifier: redactHash(rows.find(hasUserIdentifier)?.emailSha256),
  }));
  return result;
}

// ─── Alerting ───────────────────────────────────────────────────────────────

/**
 * Should this run wake the owner, and what should the email say? Extracted from
 * the cron so the admin "Run upload now" endpoint alerts identically — before
 * this, a manual run could fail completely in silence (§A1.5 hole 3).
 *
 * Returns null when the run was healthy or was a deliberate skip (non-prod
 * origin, dry run). At most ONE alert per run, never one per row.
 */
export function ociAlertReason(result: OciResult): string | null {
  // A deliberate skip (staging origin) is not a failure.
  if (result.skippedReason) return null;
  if (result.dryRun) return null;
  if (!result.configured) return 'not-configured';
  if (result.failedThisRun > 0 || result.markedPermanentlyFailed > 0) return 'rejections';
  if (result.pendingUnconfigured.length > 0) return 'unconfigured-kinds';
  return null;
}

/**
 * Send at most one owner alert for a completed run. Best-effort: an email
 * failure must never fail the run that produced it. Shared by the cron and the
 * admin "Run upload now" endpoint so both are equally loud.
 */
export async function alertOnOciRun(
  env: Env,
  result: OciResult,
  source: 'cron' | 'admin',
): Promise<void> {
  const reason = ociAlertReason(result);
  if (reason === null) return;
  await sendOciAlert(env, {
    source,
    candidates: result.candidates,
    attempted: result.attempted,
    uploaded: result.uploaded,
    failedThisRun: result.failedThisRun,
    markedPermanentlyFailed: result.markedPermanentlyFailed,
    sampleErrors: result.errors.map((e) => e.message),
    notConfigured: reason === 'not-configured',
    unconfiguredKinds: result.pendingUnconfigured.map((p) => ({ kind: p.kind, pending: p.pending })),
    topErrorReasons: result.topErrorReasons,
    userDataFallbacks: result.userDataFallbacks,
  }).catch((e) => console.error(`[oci:${source}] alert failed`, e));
}

/** Alert for a run that threw before producing a result. */
export async function alertOnOciFatal(
  env: Env,
  err: unknown,
  source: 'cron' | 'admin',
): Promise<void> {
  await sendOciAlert(env, {
    source,
    attempted: 0, uploaded: 0, failedThisRun: 0, markedPermanentlyFailed: 0,
    sampleErrors: [],
    fatal: err instanceof Error ? err.message : String(err),
  }).catch((e) => console.error(`[oci:${source}] alert failed`, e));
}
