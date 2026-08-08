import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../env';
import { insertEvent } from './insert';
import { hashEmailHex } from '../marketing/ads/userIdentifiers';
import { validationFailed } from '../util/errors';
import { clientIp, rateLimit } from '../util/rateLimit';

// The event kinds the Google Ads uploader can send (ALL_UPLOAD_KINDS in
// worker/marketing/ads/oci.ts). Only these carry a hashed email; page_view /
// editor_loaded / cta_click never do — there is nothing to upload them to, so
// there is no reason to stamp an identifier on them.
const CONVERSION_KINDS = new Set(['feed_exported', 'paywall_view', 'demo_request', 'sign_up']);

// ─── Public, cookieless event ingestion ────────────────────────────────────
//
// One row per page view. No PII stored: no IP, no User-Agent, no user id.
// `session_id` is a random value the client holds in sessionStorage — it
// scopes a "visit" without using a cookie. The `ref` field is captured once
// per session from the `?ref=` query parameter on the inbound URL.
//
// CSRF protection via the global requireClientHeader middleware on /api/* is
// still in effect: legitimate calls send X-GB-Client: web and the beacon uses
// `fetch(..., { keepalive: true })` to survive page unload while keeping the
// header. We don't accept cross-origin POSTs.

const TrackSchema = z.object({
  // page_view is the original signal; the others feed the marketing funnel
  // (editor sessions, exports, paywall intent, marketing-CTA clicks). See
  // migration 0013. `kind` is a plain TEXT column — new kinds need no migration.
  // demo_request is normally written server-side by the /book-demo lead-form
  // submit (POST /api/demo-leads, worker/marketing/demoLead.ts); it's listed
  // here for kind parity with src/services/trackBeacon.ts — the client has no
  // beacon call site for it.
  kind: z.enum(['page_view', 'editor_loaded', 'feed_exported', 'paywall_view', 'cta_click', 'demo_request']),
  path: z.string().min(1).max(512),
  ref: z.string().min(1).max(128).nullable().optional(),
  sessionId: z.string().min(8).max(64),
  // Optional sub-type, e.g. the feature key behind a paywall_view.
  label: z.string().min(1).max(128).nullable().optional(),
  // Google Ads click identifier — captured from ?gclid= on the landing URL
  // and forwarded with every event in the session. First-touch wins. Length
  // isn't formally documented by Google; ~50 chars is typical, 256 is a safe
  // ceiling. See migration 0014. Not linked to user_id.
  gclid: z.string().min(1).max(256).nullable().optional(),
  // gbraid / wbraid — same handling as gclid, captured from ?gbraid= / ?wbraid=
  // when a plain gclid isn't present (iOS / consent-limited clicks). See
  // migration 0030. A session normally carries at most one of the three.
  gbraid: z.string().min(1).max(256).nullable().optional(),
  wbraid: z.string().min(1).max(256).nullable().optional(),
});

async function parseJson<T extends z.ZodTypeAny>(
  c: { req: { json: () => Promise<unknown> } },
  schema: T,
): Promise<z.infer<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw validationFailed('Invalid JSON body');
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    throw validationFailed('Invalid request', { issues: result.error.issues });
  }
  return result.data;
}

export const eventsRouter = new Hono<AppContext>();

eventsRouter.post('/track', async (c) => {
  const body = await parseJson(c, TrackSchema);

  // Generous cap: 120 events/min/IP. A real user clicking through the editor
  // tops out well below this; anything higher is almost certainly broken.
  await rateLimit(c.env, {
    key: `track:${clientIp(c.req.raw)}`,
    limit: 120,
    windowSec: 60,
  });

  // Hashed user identifier for the Google Ads uploader. `sessionMiddleware`
  // runs on /api/* and populates c.var.user when the caller has a live session,
  // so a signed-in visitor's conversion can carry hex(sha256(email)) beside its
  // click id. Deliberately narrow: conversion kinds only, hashed here (no
  // address is passed to insertEvent or stored), and anonymous callers are
  // completely unchanged.
  //
  // ⚠️ INERT FOR THE REAL BROWSER BEACON, ON PURPOSE. `src/services/
  // trackBeacon.ts` sends `credentials: 'omit'`, so the SPA's page-view /
  // paywall / export beacons arrive WITHOUT the session cookie and c.var.user is
  // always undefined — `paywall_view` and `feed_exported` therefore upload on
  // their click id alone, exactly as before. Making them resolve an email means
  // attaching credentials to the analytics beacon, which would let the server
  // correlate every page view with an account: a much larger change than this
  // one, squarely against the locked cookieless design and against what
  // public/privacy-policy §3.5 currently promises. That is an owner decision,
  // not an implementation detail — so this stays a correct-but-unreached branch
  // rather than a silent flip of the beacon's contract. It DOES cover any
  // credentialed caller of this endpoint (and is exercised by the worker tests).
  const emailSha256 = CONVERSION_KINDS.has(body.kind) && c.var.user
    ? await hashEmailHex(c.var.user.email)
    : null;

  await insertEvent(c.env.DB, {
    kind: body.kind,
    path: body.path,
    ref: body.ref ?? null,
    sessionId: body.sessionId,
    country: c.req.header('CF-IPCountry') ?? null,
    label: body.label ?? null,
    gclid: body.gclid ?? null,
    gbraid: body.gbraid ?? null,
    wbraid: body.wbraid ?? null,
    emailSha256,
  });

  return c.body(null, 204);
});
