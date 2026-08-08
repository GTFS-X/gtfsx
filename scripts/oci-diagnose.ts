#!/usr/bin/env node
// One-shot Google Ads Offline Conversion Import (OCI) diagnostic.
//
// Answers, with evidence rather than inference:
//   1. Which upload path production actually takes (Data Manager vs the legacy
//      ConversionUploadService.UploadClickConversions), and why.
//   2. Whether that path still works — by exercising it against a real row.
//   3. Whether the legacy endpoint is still de-allowlisted for this account,
//      printing the FULLY DECODED `partialFailureError` (the GoogleAdsFailure
//      inside Status.details: every GoogleAdsError, its errorCode, message,
//      trigger, and location.fieldPathElements[].index).
//   4. Whether conversions are actually registering in Google Ads — read
//      straight from GoogleAdsService.search, which is authoritative and is
//      not subject to the Goals UI's reporting lag.
//   5. Whether the pipeline is broken or merely starved: the D1 census
//      separates "rows we failed to upload" from "rows that never existed".
//
// It deliberately reuses the production module (worker/marketing/ads/oci.ts)
// for config resolution, OAuth, and payload construction, so "authenticates
// and builds the payload exactly the way the production job does" is true by
// construction rather than by copy-paste.
//
// SAFETY. Every Google call this script makes is validate-only or a read-only
// GAQL query. It will not record a conversion. The `--live` flag exists for
// completeness but additionally requires `--i-understand-this-records-a-real-conversion`,
// and even then only sends the single sampled row. Default is always safe.
//
// Usage:
//   npx tsx scripts/oci-diagnose.ts
//   npx tsx scripts/oci-diagnose.ts --env-dir=/Users/you/proj/gtfsx   # secrets live elsewhere
//   npx tsx scripts/oci-diagnose.ts --row-id=01J…                     # probe a specific event row
//   npx tsx scripts/oci-diagnose.ts --days=90                         # Ads reporting window
//   npx tsx scripts/oci-diagnose.ts --skip-d1                         # no wrangler / no prod D1 read
//
// Reads secrets from process.env, then `.env`, then `.dev.vars` (first wins),
// in --env-dir (default: cwd). Secret VALUES are never printed.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  readOciConfig,
  readDataManagerConfig,
  readEmailOnlyPolicy,
  EMAIL_ONLY_ELIGIBLE_KINDS,
  configuredKinds,
  exchangeRefreshToken,
  buildIngestBody,
  buildConversionPayload,
  formatConversionDateTime,
  extractErrorReasons,
  isTermsGateError,
  type PendingRow,
  type UploadedKind,
  type OciConfig,
  type DataManagerConfig,
} from '../worker/marketing/ads/oci';
// The PRODUCTION normalization + hashing. Imported rather than reimplemented so
// "this is the exact identifier the uploader would send" is true by
// construction; a drift between the two would otherwise be invisible here.
import { normalizeEmail, hashEmailHex } from '../worker/marketing/ads/userIdentifiers';
import type { Env } from '../worker/env';

// ─── args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const ENV_DIR = flag('env-dir') ?? process.cwd();
const ROW_ID = flag('row-id');
const REPORT_DAYS = Number(flag('days') ?? 60);
const SKIP_D1 = args.includes('--skip-d1');
// Synthetic by default — the userData probe only needs a well-formed address to
// learn whether the account accepts user-provided data at all.
const PROBE_EMAIL = flag('email') ?? 'oci.diagnostic@example.com';
const WORKER_NAME = flag('worker') ?? 'gtfs-builder';
const D1_NAME = flag('d1') ?? 'gtfs-builder';
// Two independent flags. Neither alone records anything.
const LIVE = args.includes('--live')
  && args.includes('--i-understand-this-records-a-real-conversion');
if (args.includes('--live') && !LIVE) {
  console.error(
    '--live also requires --i-understand-this-records-a-real-conversion. '
    + 'Refusing to send a recording upload. Exiting.',
  );
  process.exit(2);
}
const VALIDATE_ONLY = !LIVE;

// The Google Ads API version the production uploader targets. Kept in step with
// API_VERSION in worker/marketing/ads/oci.ts (not exported there).
const API_VERSION = 'v24';
const DATA_MANAGER_ENDPOINT = 'https://datamanager.googleapis.com/v1/events:ingest';
const CONVERSION_KINDS: UploadedKind[] = ['feed_exported', 'paywall_view', 'demo_request', 'sign_up'];

// ─── output helpers ────────────────────────────────────────────────────────

let sectionNo = 0;
const h1 = (s: string) => console.log(`\n${'═'.repeat(78)}\n${++sectionNo}. ${s}\n${'═'.repeat(78)}`);
const h2 = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 74 - s.length))}`);
const kv = (k: string, v: unknown) => console.log(`  ${k.padEnd(38)} ${String(v)}`);
const note = (s: string) => console.log(`  · ${s}`);

/** Never print a credential or a full click id. Prefix + length only. */
function redact(v: string | null | undefined, keep = 8): string {
  if (v === null || v === undefined) return '(null)';
  if (v === '') return '(empty)';
  return `${v.slice(0, keep)}…[${v.length} chars]`;
}

/** Recursively redact click ids / tokens inside an arbitrary payload for printing. */
const SENSITIVE_KEYS = new Set([
  'gclid', 'gbraid', 'wbraid', 'hashedEmail', 'hashed_email',
  'hashedPhoneNumber', 'hashed_phone_number', 'thirdPartyUserId', 'mobileId',
  'access_token', 'refresh_token', 'client_secret', 'developerToken',
]);
function redactDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.has(k) && typeof val === 'string' ? redact(val) : redactDeep(val);
    }
    return out;
  }
  return v;
}
const dump = (label: string, v: unknown) =>
  console.log(`  ${label}:\n${JSON.stringify(v, null, 2).split('\n').map((l) => `    ${l}`).join('\n')}`);

const verdicts: string[] = [];
const record = (s: string) => { verdicts.push(s); };

// ─── env loading ───────────────────────────────────────────────────────────

/** Parse a dotenv-ish file. Values are NOT logged anywhere. */
function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return out;
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/**
 * The production Worker sees one flat `env`. Locally the same values are split
 * across `.env` (the Google Ads secrets) and `.dev.vars` (the Data Manager
 * ones), so we merge both to reconstruct it. process.env wins, then .env,
 * then .dev.vars.
 */
function loadEnv(): { env: Env; sources: Record<string, string> } {
  const dotEnv = parseEnvFile(join(ENV_DIR, '.env'));
  const devVars = parseEnvFile(join(ENV_DIR, '.dev.vars'));
  const merged: Record<string, string> = {};
  const sources: Record<string, string> = {};
  for (const [k, v] of Object.entries(devVars)) { merged[k] = v; sources[k] = '.dev.vars'; }
  for (const [k, v] of Object.entries(dotEnv)) { merged[k] = v; sources[k] = '.env'; }
  for (const k of Object.keys(merged)) {
    const fromProc = process.env[k];
    if (fromProc) { merged[k] = fromProc; sources[k] = 'process.env'; }
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (v && (k.startsWith('GOOGLE_ADS_') || k.startsWith('GOOGLE_DATAMANAGER_'))) {
      merged[k] = v; sources[k] = 'process.env';
    }
  }
  // APP_ORIGIN is a wrangler var, not a secret; the uploader's prod gate reads
  // it. We don't call uploadPendingConversions() here, but readOciConfig /
  // readDataManagerConfig take the same Env shape.
  merged.APP_ORIGIN ??= 'https://www.gtfsx.com';
  return { env: merged as unknown as Env, sources };
}

// ─── prod D1 (read-only) ───────────────────────────────────────────────────

interface D1Row { [k: string]: unknown }

function d1Query(sql: string): D1Row[] {
  const trimmed = sql.trim().replace(/\s+/g, ' ');
  if (!/^select /i.test(trimmed)) throw new Error(`refusing non-SELECT: ${trimmed.slice(0, 60)}`);
  const out = execFileSync(
    'npx',
    ['--yes', 'wrangler@4', 'd1', 'execute', D1_NAME, '--remote', '--json', '--command', trimmed],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, npm_config_cache: '/tmp/npm-cache-gtfsx' },
    },
  );
  const start = out.indexOf('[');
  if (start < 0) throw new Error('no JSON in wrangler output');
  const parsed = JSON.parse(out.slice(start)) as Array<{ results?: D1Row[] }>;
  return parsed[0]?.results ?? [];
}

function prodSecretNames(): string[] {
  const out = execFileSync(
    'npx',
    ['--yes', 'wrangler@4', 'secret', 'list', '--name', WORKER_NAME],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, npm_config_cache: '/tmp/npm-cache-gtfsx' },
    },
  );
  const start = out.indexOf('[');
  if (start < 0) return [];
  return (JSON.parse(out.slice(start)) as Array<{ name: string }>).map((s) => s.name).sort();
}

// ─── Google Ads read-only reporting ────────────────────────────────────────

interface GaqlRow { [k: string]: unknown }

async function gaql(cfg: OciConfig, accessToken: string, query: string): Promise<GaqlRow[]> {
  const url = `https://googleads.googleapis.com/${API_VERSION}/customers/${cfg.customerId}/googleAds:search`;
  const rows: GaqlRow[] = [];
  let pageToken: string | undefined;
  do {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'developer-token': cfg.developerToken,
        'login-customer-id': cfg.customerId,
        'Content-Type': 'application/json',
      },
      // NB: v24 rejects `pageSize` on googleAds:search outright
      // (requestError=PAGE_SIZE_NOT_SUPPORTED); the page size is fixed at 10000.
      body: JSON.stringify({ query, ...(pageToken ? { pageToken } : {}) }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`googleAds:search HTTP ${res.status}: ${text.slice(0, 800)}`);
    const body = JSON.parse(text) as { results?: GaqlRow[]; nextPageToken?: string };
    rows.push(...(body.results ?? []));
    pageToken = body.nextPageToken;
  } while (pageToken);
  return rows;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

// ─── partialFailureError decoding ──────────────────────────────────────────

interface GoogleAdsError {
  errorCode?: Record<string, unknown>;
  message?: string;
  trigger?: Record<string, unknown>;
  location?: { fieldPathElements?: Array<{ fieldName?: string; index?: number }> };
  details?: unknown;
}
interface RpcStatus {
  code?: number;
  message?: string;
  details?: Array<{ '@type'?: string; errors?: GoogleAdsError[]; requestId?: string }>;
}

/**
 * Print every GoogleAdsError inside a google.rpc.Status, fully decoded. This is
 * the §A1.1/§A1.3 deliverable: error code, message, trigger, and the
 * location.fieldPathElements[].index that identifies the offending row.
 */
function decodeStatus(status: RpcStatus | undefined, label: string): string[] {
  const codes: string[] = [];
  if (!status) { note(`${label}: absent`); return codes; }
  console.log(`  ${label}: code=${status.code ?? '(none)'} message=${JSON.stringify(status.message ?? '')}`);
  const details = status.details ?? [];
  if (details.length === 0) { note('  (no Status.details — nothing further to decode)'); return codes; }
  details.forEach((d, di) => {
    console.log(`    details[${di}] @type=${d['@type'] ?? '(none)'}`);
    if (d.requestId) console.log(`      requestId: ${d.requestId}`);
    const errs = d.errors ?? [];
    if (errs.length === 0) console.log('      (no GoogleAdsError entries)');
    errs.forEach((e, ei) => {
      // errorCode is a oneof: {"conversionUploadError":"..."} etc. Flatten it.
      const codeEntries = Object.entries(e.errorCode ?? {});
      const codeStr = codeEntries.length
        ? codeEntries.map(([k, v]) => `${k}=${String(v)}`).join(', ')
        : '(no errorCode)';
      codes.push(codeStr);
      const path = (e.location?.fieldPathElements ?? [])
        .map((p) => (p.index === undefined ? p.fieldName : `${p.fieldName}[${p.index}]`))
        .join('.');
      console.log(`      errors[${ei}]`);
      console.log(`        errorCode : ${codeStr}`);
      console.log(`        message   : ${e.message ?? '(none)'}`);
      console.log(`        trigger   : ${e.trigger ? JSON.stringify(redactDeep(e.trigger)) : '(none)'}`);
      console.log(`        location  : ${path || '(none)'}`);
      const rowIdx = (e.location?.fieldPathElements ?? []).find((p) => typeof p.index === 'number')?.index;
      console.log(`        row index : ${rowIdx ?? '(none)'}`);
      if (e.details) console.log(`        details   : ${JSON.stringify(redactDeep(e.details))}`);
    });
  });
  return codes;
}

// ─── main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('GTFS·X — Google Ads OCI diagnostic');
  console.log(`Run at ${new Date().toISOString()}`);
  console.log(VALIDATE_ONLY
    ? 'MODE: VALIDATE-ONLY / READ-ONLY. No conversion will be recorded.'
    : '*** MODE: LIVE. This run WILL record a real conversion. ***');

  const { env, sources } = loadEnv();

  // ── 1. Config ────────────────────────────────────────────────────────────
  h1('Configuration (names + presence only, never values)');
  const relevant = [
    'GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET',
    'GOOGLE_ADS_REFRESH_TOKEN', 'GOOGLE_ADS_CUSTOMER_ID', 'GOOGLE_ADS_LOGIN_CUSTOMER_ID',
    'GOOGLE_ADS_CONVERSION_ACTION_FEED_EXPORTED', 'GOOGLE_ADS_CONVERSION_ACTION_PAYWALL_VIEW',
    'GOOGLE_ADS_CONVERSION_ACTION_DEMO_REQUEST', 'GOOGLE_ADS_CONVERSION_ACTION_SIGN_UP',
    'GOOGLE_DATAMANAGER_REFRESH_TOKEN', 'GOOGLE_DATAMANAGER_PROJECT_ID',
  ];
  h2(`local (${ENV_DIR})`);
  for (const k of relevant) {
    const v = (env as unknown as Record<string, string | undefined>)[k];
    kv(k, v ? `set   (${sources[k] ?? '?'})` : 'MISSING');
  }

  let prodNames: string[] = [];
  if (!SKIP_D1) {
    h2(`prod Worker secrets (${WORKER_NAME})`);
    try {
      prodNames = prodSecretNames();
      for (const k of relevant) kv(k, prodNames.includes(k) ? 'set on prod' : 'not a prod secret');
      const localOnly = relevant.filter((k) => (env as unknown as Record<string, unknown>)[k] && !prodNames.includes(k));
      const prodOnly = relevant.filter((k) => prodNames.includes(k) && !(env as unknown as Record<string, unknown>)[k]);
      if (prodOnly.length) note(`PROD-ONLY (this script cannot exercise these): ${prodOnly.join(', ')}`);
      if (localOnly.length) note(`LOCAL-ONLY: ${localOnly.join(', ')}`);
    } catch (e) {
      note(`could not list prod secrets: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── 2. Which path does prod take? ────────────────────────────────────────
  h1('Active upload path (production selection logic, verbatim)');
  const dmCfg: DataManagerConfig | null = readDataManagerConfig(env);
  const legacyCfg: OciConfig | null = readOciConfig(env);
  kv('readDataManagerConfig(env)', dmCfg ? 'RESOLVED → Data Manager path' : 'null');
  kv('readOciConfig(env)', legacyCfg ? 'resolved (legacy fallback available)' : 'null');
  const activePath = dmCfg ? 'data-manager' : legacyCfg ? 'legacy' : 'none';
  kv('ACTIVE PATH (this config)', activePath);
  note('uploadPendingConversions() prefers Data Manager whenever readDataManagerConfig() is non-null;');
  note('the legacy path only runs when it is null. Exactly one path runs per invocation.');
  if (prodNames.length) {
    const prodDm = ['GOOGLE_DATAMANAGER_REFRESH_TOKEN', 'GOOGLE_DATAMANAGER_PROJECT_ID',
      'GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_CUSTOMER_ID',
      'GOOGLE_ADS_CONVERSION_ACTION_FEED_EXPORTED', 'GOOGLE_ADS_CONVERSION_ACTION_PAYWALL_VIEW']
      .every((k) => prodNames.includes(k));
    kv('ACTIVE PATH ON PROD', prodDm ? 'data-manager' : 'legacy or unconfigured');
    record(`Prod upload path: ${prodDm ? 'Data Manager API' : 'legacy uploadClickConversions'}`);
  }
  if (dmCfg) {
    kv('configured kinds (DM)', configuredKinds(dmCfg).join(', ') || '(none)');
    kv('loginAccount sent?', dmCfg.loginAccountId ? 'yes' : 'no');
  }
  if (legacyCfg) kv('configured kinds (legacy)', configuredKinds(legacyCfg).join(', ') || '(none)');

  h2('email-only uploads (GOOGLE_ADS_UPLOAD_WITHOUT_CLICK_ID_KINDS)');
  const emailOnly = readEmailOnlyPolicy(env);
  kv('eligible kinds (structural ceiling)', EMAIL_ONLY_ELIGIBLE_KINDS.join(', '));
  kv('capability', emailOnly === null
    ? 'OFF for every kind — a candidate still requires an ad click id (the default)'
    : `ON for [${emailOnly.kinds.join(', ')}], cutover ${new Date(emailOnly.since).toISOString()} `
      + '(only rows newer than this)');
  note('Off means the hashed email is an EXTRA identifier on click-id rows and nothing more —');
  note('it cannot widen the candidate set, so the organic backlog stays untouched.');
  note('paywall_view / feed_exported can NEVER be widened: the beacon sends credentials:\'omit\',');
  note('so they resolve no email and a row without a click id has no identifier at all.');

  // ── 3. D1 census ─────────────────────────────────────────────────────────
  let sampleRow: PendingRow | null = null;
  if (!SKIP_D1) {
    h1('Production D1 census — is there anything to upload?');
    try {
      h2('conversion-kind rows by identifier and upload state');
      const census = d1Query(`
        SELECT kind,
               CASE WHEN gclid IS NOT NULL THEN 'gclid'
                    WHEN gbraid IS NOT NULL THEN 'gbraid'
                    WHEN wbraid IS NOT NULL THEN 'wbraid'
                    ELSE 'no-ad-identifier' END AS ident,
               CASE WHEN oci_uploaded_at IS NULL THEN 'pending'
                    WHEN oci_uploaded_at = -1 THEN 'sentinel(-1)'
                    ELSE 'uploaded' END AS state,
               COUNT(*) AS n,
               SUM(CASE WHEN oci_last_error IS NOT NULL THEN 1 ELSE 0 END) AS with_error,
               MIN(date(ts/1000,'unixepoch')) AS first_day,
               MAX(date(ts/1000,'unixepoch')) AS last_day
          FROM event
         WHERE kind IN ('feed_exported','paywall_view','demo_request','sign_up')
         GROUP BY 1,2,3 ORDER BY 1,2,3`);
      console.table(census);

      h2('upload timeline (oci_uploaded_at)');
      console.table(d1Query(`
        SELECT date(oci_uploaded_at/1000,'unixepoch') AS upload_day, kind, COUNT(*) AS n
          FROM event WHERE oci_uploaded_at > 0 GROUP BY 1,2 ORDER BY 1`));

      h2('ad-identifier reach across ALL event kinds (funnel shape)');
      console.table(d1Query(`
        SELECT kind,
               CASE WHEN gclid IS NOT NULL THEN 'gclid'
                    WHEN gbraid IS NOT NULL THEN 'gbraid' ELSE 'wbraid' END AS ident,
               COUNT(*) AS events, COUNT(DISTINCT session_id) AS sessions,
               MIN(date(ts/1000,'unixepoch')) AS first_day,
               MAX(date(ts/1000,'unixepoch')) AS last_day
          FROM event
         WHERE gclid IS NOT NULL OR gbraid IS NOT NULL OR wbraid IS NOT NULL
         GROUP BY 1,2 ORDER BY events DESC`));

      const totals = d1Query(`
        SELECT
          SUM(CASE WHEN oci_uploaded_at IS NULL THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN oci_uploaded_at > 0 THEN 1 ELSE 0 END) AS uploaded,
          SUM(CASE WHEN oci_uploaded_at = -1 THEN 1 ELSE 0 END) AS sentinel_failed,
          SUM(CASE WHEN oci_last_error IS NOT NULL THEN 1 ELSE 0 END) AS with_error
        FROM event
        WHERE kind IN ('feed_exported','paywall_view','demo_request','sign_up')
          AND (gclid IS NOT NULL OR gbraid IS NOT NULL OR wbraid IS NOT NULL)`)[0];
      h2('candidate totals (conversion kinds WITH an ad identifier)');
      console.log(totals);
      record(
        `D1 candidates: pending=${totals?.pending ?? '?'}, uploaded=${totals?.uploaded ?? '?'}, `
        + `permanently-failed=${totals?.sentinel_failed ?? '?'}, carrying oci_last_error=${totals?.with_error ?? '?'}`,
      );

      // migration 0032 adds event.oci_email_sha256. Prod may not have it yet, so
      // detect rather than assume — selecting a missing column is a hard error.
      const hasEmailColumn = d1Query(
        `SELECT name FROM pragma_table_info('event') WHERE name = 'oci_email_sha256'`,
      ).length > 0;
      kv('event.oci_email_sha256 (migration 0032)', hasEmailColumn ? 'present' : 'NOT YET APPLIED');
      const emailCol = hasEmailColumn ? 'oci_email_sha256 AS emailSha256' : `NULL AS emailSha256`;

      // ── rows with no ad identifier, and what could ever reach them ──
      // `eligible_with_hash` is the only column that can become non-zero
      // candidates: an eligible kind, no click id, but a hashed email to match
      // on. Everything else in this table is structurally un-uploadable — no
      // click id and no email is no identifier at all.
      const eligibleList = EMAIL_ONLY_ELIGIBLE_KINDS.map((k) => `'${k}'`).join(',');
      const withHash = hasEmailColumn
        ? `SUM(CASE WHEN oci_email_sha256 IS NOT NULL AND kind IN (${eligibleList}) THEN 1 ELSE 0 END)`
        : '0';
      h2('rows with NO ad identifier (what the email-only capability could expose)');
      console.table(d1Query(`
        SELECT kind, COUNT(*) AS rows_no_click_id,
               SUM(CASE WHEN oci_uploaded_at IS NULL THEN 1 ELSE 0 END) AS still_pending,
               SUM(CASE WHEN ts > (strftime('%s','now') - 90*86400) * 1000 THEN 1 ELSE 0 END) AS within_90d,
               ${withHash} AS eligible_with_hash,
               MIN(date(ts/1000,'unixepoch')) AS first_day,
               MAX(date(ts/1000,'unixepoch')) AS last_day
          FROM event
         WHERE kind IN ('feed_exported','paywall_view','demo_request','sign_up')
           AND gclid IS NULL AND gbraid IS NULL AND wbraid IS NULL
         GROUP BY kind ORDER BY rows_no_click_id DESC`));
      note('The cron will NOT touch these: a candidate still requires an ad click id.');
      note('Only `eligible_with_hash` can ever become candidates, and only behind');
      note('GOOGLE_ADS_UPLOAD_WITHOUT_CLICK_ID_KINDS + _SINCE, bounded by the cutover.');
      note('A zero there means the capability would expose nothing however it is configured.');

      const sel = ROW_ID
        ? `SELECT id, ts, kind, gclid, gbraid, wbraid, COALESCE(oci_attempts,0) AS attempts,
                  ${emailCol}, oci_uploaded_at FROM event WHERE id = '${ROW_ID.replace(/'/g, '')}'`
        : `SELECT id, ts, kind, gclid, gbraid, wbraid, COALESCE(oci_attempts,0) AS attempts,
                  ${emailCol}, oci_uploaded_at
             FROM event
            WHERE kind IN ('feed_exported','paywall_view','demo_request','sign_up')
              AND (gclid IS NOT NULL OR gbraid IS NOT NULL OR wbraid IS NOT NULL)
            ORDER BY (oci_uploaded_at IS NULL) DESC, ts DESC LIMIT 1`;
      const found = d1Query(sel)[0];
      if (found) {
        sampleRow = {
          id: String(found.id), ts: Number(found.ts), kind: found.kind as UploadedKind,
          gclid: (found.gclid as string) ?? null, gbraid: (found.gbraid as string) ?? null,
          wbraid: (found.wbraid as string) ?? null, attempts: Number(found.attempts ?? 0),
          emailSha256: (found.emailSha256 as string) ?? null,
        };
        const sampleWasUploaded = Number(found.oci_uploaded_at ?? 0) > 0;
        h2('sampled real conversion candidate');
        kv('id', sampleRow.id);
        kv('kind', sampleRow.kind);
        kv('ts', `${sampleRow.ts} (${new Date(sampleRow.ts).toISOString()})`);
        kv('gclid', redact(sampleRow.gclid));
        kv('gbraid', redact(sampleRow.gbraid));
        kv('wbraid', redact(sampleRow.wbraid));
        kv('oci_email_sha256', redact(sampleRow.emailSha256, 10));
        kv('already uploaded?', sampleWasUploaded
          ? 'YES — no pending candidate existed, so we sampled an already-uploaded row'
          : 'no — genuinely pending');
        kv('age (days)', ((Date.now() - sampleRow.ts) / 86400000).toFixed(1));
      } else {
        note('no conversion-kind row with an ad identifier exists at all');
      }
    } catch (e) {
      note(`D1 read failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Fall back to a synthetic row so the API probes still run without D1.
  const probeRow: PendingRow = sampleRow ?? {
    id: 'diagnostic-synthetic-row',
    ts: Date.now() - 3 * 86400000,
    kind: 'paywall_view',
    gclid: 'DIAGNOSTIC_SYNTHETIC_GCLID_NOT_A_REAL_CLICK',
    gbraid: null,
    wbraid: null,
    attempts: 0,
    emailSha256: null,
  };
  if (!sampleRow) note('using a SYNTHETIC row for the API probes (no real candidate available)');

  // ── 4. Data Manager probe ────────────────────────────────────────────────
  h1(`Probe A — Data Manager API events:ingest (validateOnly=${VALIDATE_ONLY})`);
  if (!dmCfg) {
    note('skipped: Data Manager config not resolvable from this environment');
    record('Data Manager probe: SKIPPED (no local DM credentials)');
  } else {
    try {
      const token = await exchangeRefreshToken(dmCfg);
      note(`OAuth (datamanager scope): OK, access token ${redact(token, 6)}`);
      // buildIngestBody is the PRODUCTION payload builder. We flip only
      // validateOnly — everything else is byte-identical to what the cron sends.
      const body = buildIngestBody(dmCfg, probeRow) as Record<string, unknown>;
      body.validateOnly = VALIDATE_ONLY;
      dump('request body (redacted)', redactDeep(body));
      const res = await fetch(DATA_MANAGER_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'x-goog-user-project': dmCfg.projectId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      kv('HTTP status', `${res.status} ${res.statusText}`);
      let parsed: unknown = text;
      try { parsed = JSON.parse(text); } catch { /* keep raw */ }
      dump('response', redactDeep(parsed));
      if (res.ok) {
        record(`Data Manager events:ingest → HTTP ${res.status} ACCEPTED (validateOnly=${VALIDATE_ONLY}). The live upload path works.`);
      } else {
        record(`Data Manager events:ingest → HTTP ${res.status} REJECTED. The live upload path is BROKEN.`);
      }
      note('events:ingest has no partial_failure_error: it returns {requestId} on success');
      note('and a non-2xx google.rpc.Status on failure. gtfsx sends one event per request,');
      note('so HTTP status IS the per-row verdict — there is no hidden per-row rejection channel.');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      kv('FAILED', msg);
      record(`Data Manager probe threw: ${msg}`);
    }
  }

  // ── 4b. Data Manager + userData (enhanced conversions for leads) ─────────
  h1(`Probe A2 — Data Manager events:ingest WITH hashed email (validateOnly=true, ALWAYS)`);
  note('The §A1.4 structural fix as SHIPPED: buildIngestBody() attaches userData itself when the');
  note('row carries event.oci_email_sha256, and sets the top-level encoding:"HEX" that field then');
  note('requires. Nothing is hand-assembled here — we only hand it a row with a hash and flip');
  note('validateOnly, so the bytes below are the bytes the cron would send.');
  if (!dmCfg) {
    note('skipped: Data Manager config not resolvable from this environment');
    record('Data Manager userData probe: SKIPPED (no local DM credentials)');
  } else {
    try {
      const token = await exchangeRefreshToken(dmCfg);
      const probeHash = await hashEmailHex(PROBE_EMAIL);
      // Production builder, production hashing — the ONLY change vs. the cron
      // is validateOnly.
      const body = buildIngestBody(dmCfg, { ...probeRow, emailSha256: probeHash });
      body.validateOnly = true; // never false in this probe, even under --live
      kv('probe email (not sent in clear)', redact(normalizeEmail(PROBE_EMAIL) ?? '', 4));
      kv('sha256 hex (redacted)', redact(probeHash, 10));
      kv('top-level encoding', String(body.encoding));
      kv('userData is a sibling of adIdentifiers?',
        String(Object.hasOwn((body.events as Array<Record<string, unknown>>)[0], 'userData')));
      dump('request body (redacted)', redactDeep(body));
      const res = await fetch(DATA_MANAGER_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'x-goog-user-project': dmCfg.projectId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      kv('HTTP status', `${res.status} ${res.statusText}`);
      let parsed: unknown = text;
      try { parsed = JSON.parse(text); } catch { /* keep raw */ }
      dump('response', redactDeep(parsed));
      // Decide with the PRODUCTION matcher, not a regex over the message. This
      // is the assertion that the shipped fallback will actually recognise the
      // live error and retry without userData rather than failing the row.
      const reasons = extractErrorReasons(parsed);
      kv('structured error reasons', reasons.length ? reasons.join(', ') : '(none)');
      kv('isTermsGateError(reasons)', String(isTermsGateError(reasons)));
      if (res.ok) {
        record('Data Manager + hashed email → ACCEPTED under validateOnly. User identifiers are live; the uploader will stop falling back.');
      } else if (isTermsGateError(reasons)) {
        record(
          `Data Manager + hashed email → REJECTED for the customer-data terms gate (HTTP ${res.status}, `
          + `reason ${reasons.filter((r) => r !== 'INVALID_ARGUMENT').join('/')}). The shipped uploader `
          + 'detects exactly this and re-sends without userData, so uploads keep working until Mark accepts the terms.',
        );
      } else {
        record(`Data Manager + hashed email → REJECTED HTTP ${res.status} (NOT a terms error — the uploader would fail the row, correctly).`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      kv('FAILED', msg);
      record(`Data Manager userData probe threw: ${msg}`);
    }
  }

  // ── 4c. The fallback payload, byte for byte ──────────────────────────────
  h1('Probe A3 — the terms-gate FALLBACK payload (validateOnly=true, ALWAYS)');
  note('When probe A2 is rejected for the terms gate, the uploader re-sends this: the identical');
  note('event rebuilt with includeUserData:false. If this is accepted, the fallback holds the');
  note('pipeline up unchanged while the account terms are outstanding.');
  if (!dmCfg) {
    note('skipped: Data Manager config not resolvable from this environment');
  } else {
    try {
      const token = await exchangeRefreshToken(dmCfg);
      const probeHash = await hashEmailHex(PROBE_EMAIL);
      const body = buildIngestBody(
        dmCfg, { ...probeRow, emailSha256: probeHash }, { includeUserData: false },
      );
      body.validateOnly = true;
      kv('userData present?',
        String(Object.hasOwn((body.events as Array<Record<string, unknown>>)[0], 'userData')));
      kv('top-level encoding present?', String(Object.hasOwn(body, 'encoding')));
      dump('request body (redacted)', redactDeep(body));
      const res = await fetch(DATA_MANAGER_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'x-goog-user-project': dmCfg.projectId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      kv('HTTP status', `${res.status} ${res.statusText}`);
      let parsed: unknown = text;
      try { parsed = JSON.parse(text); } catch { /* keep raw */ }
      dump('response', redactDeep(parsed));
      record(res.ok
        ? 'Terms-gate fallback payload → ACCEPTED. Today\'s uploads are unaffected by the userData change.'
        : `Terms-gate fallback payload → REJECTED HTTP ${res.status}. The fallback would NOT save the row — investigate.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      kv('FAILED', msg);
      record(`Fallback probe threw: ${msg}`);
    }
  }

  // ── 5. Legacy probe ──────────────────────────────────────────────────────
  h1('Probe B — legacy ConversionUploadService.UploadClickConversions (validate_only=true, ALWAYS)');
  note('This probe is diagnostic only and is hard-wired to validate_only=true even under --live:');
  note('its sole purpose is to record whether the 2026-06 de-allowlisting still stands.');
  if (!legacyCfg) {
    note('skipped: legacy config not resolvable (needs GOOGLE_ADS_DEVELOPER_TOKEN + REFRESH_TOKEN)');
    record('Legacy probe: SKIPPED (no local legacy credentials)');
  } else if (!probeRow.gclid) {
    note('skipped: the sampled row carries no gclid and the legacy path is gclid-only');
    record('Legacy probe: SKIPPED (sampled row is braid-only)');
  } else {
    let adsToken: string | null = null;
    try {
      adsToken = await exchangeRefreshToken(legacyCfg);
      note(`OAuth (adwords scope): OK, access token ${redact(adsToken, 6)}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      kv('OAuth FAILED', msg);
      record(`Legacy OAuth failed: ${msg}`);
    }
    if (adsToken) {
      // Google Ads rejects partial_failure=true together with validate_only=true
      // on some services, so try both and fall back.
      const attempts: Array<{ partial: boolean; label: string }> = [
        { partial: true, label: 'partial_failure=true, validate_only=true' },
        { partial: false, label: 'partial_failure=false, validate_only=true' },
      ];
      for (const attempt of attempts) {
        h2(attempt.label);
        // buildConversionPayload is the PRODUCTION legacy builder. We flip only
        // the two request flags.
        const payload = buildConversionPayload(legacyCfg, [probeRow]) as unknown as Record<string, unknown>;
        payload.partial_failure = attempt.partial;
        payload.validate_only = true; // never false, in any mode
        dump('request payload (redacted)', redactDeep(payload));
        kv('conversion_date_time', formatConversionDateTime(probeRow.ts));
        const url = `https://googleads.googleapis.com/${API_VERSION}/customers/${legacyCfg.customerId}:uploadClickConversions`;
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${adsToken}`,
            'developer-token': legacyCfg.developerToken,
            'login-customer-id': legacyCfg.customerId,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });
        const text = await res.text();
        kv('HTTP status', `${res.status} ${res.statusText}`);
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { console.log(`  raw body: ${text.slice(0, 2000)}`); }
        dump('FULL response body (redacted)', redactDeep(parsed));

        // Decode both shapes of failure: a top-level error (non-2xx) and the
        // in-band partialFailureError (HTTP 200 with rejected rows).
        const topLevel = (parsed.error ?? undefined) as RpcStatus | undefined;
        const pf = (parsed.partialFailureError ?? parsed.partial_failure_error) as RpcStatus | undefined;
        h2('decoded errors');
        const topCodes = topLevel ? decodeStatus(topLevel, 'top-level error (google.rpc.Status)') : [];
        const pfCodes = decodeStatus(pf, 'partialFailureError (google.rpc.Status)');
        const results = (parsed.results ?? []) as unknown[];
        kv('results[] length', results.length);
        note('results[] entries are accepted rows; a rejected row appears ONLY inside partialFailureError.');

        const allCodes = [...topCodes, ...pfCodes];
        if (allCodes.length) {
          record(`Legacy endpoint (${attempt.label}) → HTTP ${res.status}, error codes: ${allCodes.join(' | ')}`);
        } else if (res.ok && results.length > 0) {
          record(`Legacy endpoint (${attempt.label}) → HTTP ${res.status}, ${results.length} row(s) VALIDATED with no errors — de-allowlisting appears LIFTED.`);
        } else {
          record(`Legacy endpoint (${attempt.label}) → HTTP ${res.status}, no decodable errors and no results.`);
        }
        // If the first attempt was rejected purely for the flag combination,
        // the fallback attempt tells us the real story; otherwise stop here.
        const flagClash = allCodes.some((c) => /PARTIAL_FAILURE|VALIDATE_ONLY|CANNOT_BE|MUTUALLY/i.test(c))
          || /partial.?failure.*validate.?only|validate.?only.*partial/i.test(String(topLevel?.message ?? ''));
        if (!flagClash) break;
        note('retrying without partial_failure — the two flags appear mutually exclusive here');
      }
    }
  }

  // ── 6. Are conversions registering in Google Ads? ────────────────────────
  h1(`Google Ads reporting (read-only GAQL, last ${REPORT_DAYS} days)`);
  if (!legacyCfg) {
    note('skipped: GoogleAdsService.search needs the developer token + adwords-scoped refresh token');
  } else {
    try {
      const adsToken = await exchangeRefreshToken(legacyCfg);
      const end = new Date();
      const start = new Date(Date.now() - REPORT_DAYS * 86400000);

      h2('customer.conversion_tracking_setting — is enhanced conversions for leads already on?');
      try {
        const cust = await gaql(legacyCfg, adsToken, `
          SELECT customer.id, customer.descriptive_name, customer.time_zone, customer.currency_code,
                 customer.conversion_tracking_setting.conversion_tracking_id,
                 customer.conversion_tracking_setting.cross_account_conversion_tracking_id,
                 customer.conversion_tracking_setting.conversion_tracking_status,
                 customer.conversion_tracking_setting.accepted_customer_data_terms,
                 customer.conversion_tracking_setting.enhanced_conversions_for_leads_enabled,
                 customer.conversion_tracking_setting.google_ads_conversion_customer
            FROM customer`);
        dump('customer (verbatim)', cust);
        const cts = ((cust[0]?.customer ?? {}) as Record<string, unknown>)
          .conversionTrackingSetting as Record<string, unknown> | undefined;
        // proto3 JSON omits non-optional bools that are false, so `undefined`
        // here means FALSE, not "unknown". Probe A2 corroborates it directly.
        const ecl = cts?.enhancedConversionsForLeadsEnabled === true;
        const terms = cts?.acceptedCustomerDataTerms === true;
        kv('enhancedConversionsForLeadsEnabled',
          `${ecl} (raw: ${String(cts?.enhancedConversionsForLeadsEnabled)} — absent means false in proto3 JSON)`);
        kv('acceptedCustomerDataTerms',
          `${terms} (raw: ${String(cts?.acceptedCustomerDataTerms)} — absent means false)`);
        record(
          `Account enhanced-conversions-for-leads: enabled=${ecl}, customer-data terms accepted=${terms} `
          + `(handoff Part B item 1 is ${ecl && terms ? 'ALREADY DONE' : 'STILL NEEDED'}).`,
        );
      } catch (e) {
        note(`conversion_tracking_setting query failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      h2('conversion actions (status / counting / windows)');
      const actions = await gaql(legacyCfg, adsToken, `
        SELECT conversion_action.id, conversion_action.name, conversion_action.status,
               conversion_action.type, conversion_action.category,
               conversion_action.counting_type,
               conversion_action.include_in_conversions_metric,
               conversion_action.click_through_lookback_window_days,
               conversion_action.primary_for_goal
          FROM conversion_action`);
      console.table(actions.map((r) => {
        const a = (r.conversionAction ?? {}) as Record<string, unknown>;
        return {
          id: a.id, name: a.name, status: a.status, type: a.type, category: a.category,
          counting: a.countingType,
          in_conversions: a.includeInConversionsMetric,
          window_days: a.clickThroughLookbackWindowDays,
          primary: a.primaryForGoal,
        };
      }));
      h2('conversion actions — VERBATIM API payload (exact enum values, for the record)');
      dump('conversion_action rows', actions);

      // Cross-check the configured ids against what the account actually has.
      const known = new Map(actions.map((r) => {
        const a = (r.conversionAction ?? {}) as Record<string, unknown>;
        return [String(a.id), String(a.name)];
      }));
      h2('configured conversion action ids vs. the account');
      for (const kind of CONVERSION_KINDS) {
        const id = (dmCfg ?? legacyCfg)?.conversionActions[kind];
        if (!id) { kv(kind, 'NOT CONFIGURED in this environment'); continue; }
        kv(kind, known.has(id) ? `id ${id} → "${known.get(id)}" ✓` : `id ${id} → NOT FOUND in account ✗`);
      }

      h2(`conversions by action and date (${ymd(start)} … ${ymd(end)})`);
      const byDate = await gaql(legacyCfg, adsToken, `
        SELECT segments.date, segments.conversion_action_name, segments.conversion_action,
               metrics.all_conversions, metrics.conversions
          FROM customer
         WHERE segments.date BETWEEN '${ymd(start)}' AND '${ymd(end)}'`);
      const rows = byDate
        .map((r) => ({
          date: (r.segments as Record<string, unknown>)?.date,
          action: (r.segments as Record<string, unknown>)?.conversionActionName,
          all_conversions: Number((r.metrics as Record<string, unknown>)?.allConversions ?? 0),
          conversions: Number((r.metrics as Record<string, unknown>)?.conversions ?? 0),
        }))
        .filter((r) => r.all_conversions > 0 || r.conversions > 0);
      if (rows.length === 0) {
        note(`ZERO conversions of any kind recorded in the last ${REPORT_DAYS} days.`);
        record(`Google Ads reporting: 0 conversions in the last ${REPORT_DAYS} days.`);
      } else {
        console.table(rows);
        const total = rows.reduce((s, r) => s + r.all_conversions, 0);
        const perAction = new Map<string, number>();
        for (const r of rows) perAction.set(String(r.action), (perAction.get(String(r.action)) ?? 0) + r.all_conversions);
        record(
          `Google Ads reporting: ${total} all_conversions over ${REPORT_DAYS}d — `
          + [...perAction].map(([a, n]) => `${a}=${n}`).join(', '),
        );
        // Offline conversions are dated by the CLICK, not the upload, so a
        // backfill retro-fills old dates and a trailing-30d read looks empty
        // even when the uploader is healthy. Report both windows explicitly.
        const cut30 = ymd(new Date(Date.now() - 30 * 86400000));
        const last30 = rows.filter((r) => String(r.date) >= cut30);
        const total30 = last30.reduce((s, r) => s + r.all_conversions, 0);
        note(`trailing 30d (${cut30} …): ${total30} all_conversions`);
        note('conversion dates above are CLICK dates, not upload dates — a backfill');
        note('credits the original click date, which is why an old window can grow retroactively.');
        record(`Google Ads reporting: ${total30} all_conversions in the trailing 30d (click-dated).`);
      }

      h2(`campaign spend & clicks (${ymd(start)} … ${ymd(end)})`);
      const camp = await gaql(legacyCfg, adsToken, `
        SELECT campaign.name, campaign.status, campaign.bidding_strategy_type,
               metrics.clicks, metrics.impressions, metrics.cost_micros,
               metrics.conversions, metrics.all_conversions
          FROM campaign
         WHERE segments.date BETWEEN '${ymd(start)}' AND '${ymd(end)}'`);
      console.table(camp.map((r) => {
        const c = (r.campaign ?? {}) as Record<string, unknown>;
        const m = (r.metrics ?? {}) as Record<string, unknown>;
        return {
          campaign: c.name, status: c.status, bidding: c.biddingStrategyType,
          clicks: m.clicks, impressions: m.impressions,
          cost: `$${(Number(m.costMicros ?? 0) / 1e6).toFixed(2)}`,
          conversions: m.conversions, all_conversions: m.allConversions,
        };
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      kv('GAQL FAILED', msg);
      record(`Google Ads reporting query failed: ${msg}`);
    }
  }

  // ── 7. Verdict ───────────────────────────────────────────────────────────
  h1('VERDICT');
  for (const v of verdicts) console.log(`  • ${v}`);
  console.log('\n  Read it this way:');
  console.log('    - Data Manager probe ACCEPTED + zero pending/failed rows in D1  → the pipeline works;');
  console.log('      any shortfall in Google Ads conversions is a FUNNEL problem, not an upload problem.');
  console.log('    - Data Manager probe REJECTED, or pending/errored rows in D1     → the pipeline is broken.');
  console.log('    - Legacy probe returning CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE');
  console.log('      → the 2026-06 de-allowlisting still stands; do not migrate back.');
  console.log(VALIDATE_ONLY
    ? '\n  No conversion was recorded by this run.'
    : '\n  *** A REAL CONVERSION MAY HAVE BEEN RECORDED. ***');
}

main().catch((e) => {
  console.error('\nDIAGNOSTIC FAILED:', e instanceof Error ? e.stack : e);
  process.exit(1);
});
