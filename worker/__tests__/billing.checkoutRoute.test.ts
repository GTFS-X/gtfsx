// Route-level wiring for the checkout / portal guards (W1-09, W1-13, W1-20).
// The helpers (assertOrgCanStartCheckout, resolvePortalReturnUrl) are unit
// tested in billing.checkout.test.ts; these drive the real routes through the
// Worker entrypoint with a Stripe test key in the env and a stubbed Stripe
// HTTP API, so removing a guard call from a handler turns a test red.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ulid } from 'ulidx';
import worker from '../index';
import type { Env } from '../env';
import { makeClient, type TestClient } from './_client';
import { applyMigrations, dbRun, env, resetDb, seedUser } from './_setup';

const billingEnv = {
  ...env,
  STRIPE_SECRET_KEY: 'sk_test_route_wiring',
  STRIPE_PRICE_TEAM_MONTHLY: 'price_agency_m',
  STRIPE_PRICE_TEAM_ANNUAL: 'price_agency_a',
} as unknown as Env;

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

interface StripeCall {
  url: string;
  body: string;
}
let stripeCalls: StripeCall[] = [];

function stubStripe(): void {
  stripeCalls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : null;
    const url = req ? req.url : String(input);
    if (!url.includes('api.stripe.com')) throw new Error(`unexpected outbound fetch ${url}`);
    const body = req ? await req.text() : String(init?.body ?? '');
    stripeCalls.push({ url, body });
    const json = url.includes('/customers')
      ? { id: 'cus_route', object: 'customer' }
      : url.includes('/billing_portal/')
        ? { id: 'bps_1', object: 'billing_portal.session', url: 'https://billing.stripe.test/p' }
        : { id: 'cs_1', object: 'checkout.session', url: 'https://checkout.stripe.test/c' };
    return new Response(JSON.stringify(json), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
}

/** POST through the Worker entrypoint with the Stripe-enabled env. */
async function post(c: TestClient, path: string, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-GB-Client': 'web' };
  if (c.cookie) headers.Cookie = c.cookie;
  return worker.fetch(
    new Request(`http://127.0.0.1${path}`, { method: 'POST', headers, body: JSON.stringify(body) }),
    billingEnv,
    ctx,
  );
}

async function orgAdmin(slug: string): Promise<{ c: TestClient; orgId: string }> {
  const u = await seedUser({ email: `${slug}@example.com`, plan: 'free' });
  const c = makeClient();
  expect((await c.post('/auth/login', { email: u.email, password: u.password })).status).toBe(200);
  const res = await c.json<{ organization?: { id: string }; id?: string }>(
    await c.post('/api/orgs', { slug, name: `Org ${slug}` }),
  );
  return { c, orgId: (res.organization?.id ?? res.id)! };
}

async function seedSubscription(orgId: string, status: string): Promise<void> {
  const now = Date.now();
  const rowId = ulid();
  await dbRun(
    `INSERT INTO subscription
       (id, owner_type, owner_id, stripe_subscription_id, stripe_customer_id, stripe_price_id,
        plan, status, current_period_start, current_period_end, created_at, updated_at)
     VALUES (?, 'org', ?, ?, 'cus_route', 'price_x', 'agency', ?, ?, ?, ?, ?)`,
    rowId, orgId, `sub_${rowId}`, status, now, now + 1000, now, now,
  );
}

describe('POST /api/billing/checkout wiring (W1-09)', () => {
  beforeEach(async () => {
    await applyMigrations();
    await dbRun(`DELETE FROM checkout_session`); // FK to user; resetDb does not clear it
    await resetDb();
    await dbRun(`DELETE FROM subscription`);
    stubStripe();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await dbRun(`DELETE FROM checkout_session`);
  });

  it('an org with a live subscription gets 409 already_subscribed and Stripe is never called', async () => {
    const { c, orgId } = await orgAdmin('co-live');
    await seedSubscription(orgId, 'active');
    const res = await post(c, '/api/billing/checkout', { ownerType: 'org', ownerId: orgId, plan: 'agency', interval: 'month' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { reason?: string; details?: { reason?: string } };
    expect(body.reason ?? body.details?.reason).toBe('already_subscribed');
    expect(stripeCalls).toHaveLength(0);
  });

  it('a staff-granted Enterprise org also gets 409 with no Stripe call', async () => {
    const { c, orgId } = await orgAdmin('co-ent');
    await dbRun(`UPDATE organization SET plan = 'enterprise' WHERE id = ?`, orgId);
    const res = await post(c, '/api/billing/checkout', { ownerType: 'org', ownerId: orgId, plan: 'agency', interval: 'month' });
    expect(res.status).toBe(409);
    expect(stripeCalls).toHaveLength(0);
  });

  it('control: a free org with no subscription reaches Stripe and gets a checkout URL', async () => {
    const { c, orgId } = await orgAdmin('co-free');
    const res = await post(c, '/api/billing/checkout', { ownerType: 'org', ownerId: orgId, plan: 'agency', interval: 'month' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { url: string }).url).toBe('https://checkout.stripe.test/c');
    expect(stripeCalls.some((s) => s.url.includes('/checkout/sessions'))).toBe(true);
  });
});

describe('POST /api/billing/portal return URL wiring (W1-13, W1-20)', () => {
  let orgId: string;
  let c: TestClient;
  let slug: string;
  beforeEach(async () => {
    await applyMigrations();
    await dbRun(`DELETE FROM checkout_session`);
    await resetDb();
    await dbRun(`DELETE FROM subscription`);
    stubStripe();
    slug = 'po-org';
    ({ c, orgId } = await orgAdmin(slug));
    await dbRun(`UPDATE organization SET stripe_customer_id = 'cus_route' WHERE id = ?`, orgId);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await dbRun(`DELETE FROM checkout_session`);
  });

  it('an off-origin returnUrl is rejected with 422 and Stripe is never called', async () => {
    const res = await post(c, '/api/billing/portal', {
      ownerType: 'org', ownerId: orgId, returnUrl: 'https://evil.example/',
    });
    expect(res.status).toBe(422);
    expect(stripeCalls).toHaveLength(0);
  });

  it('with no returnUrl, Stripe is handed the slug-keyed org billing page', async () => {
    const res = await post(c, '/api/billing/portal', { ownerType: 'org', ownerId: orgId });
    expect(res.status).toBe(200);
    const portalCall = stripeCalls.find((s) => s.url.includes('/billing_portal/sessions'));
    expect(portalCall).toBeTruthy();
    const returnUrl = new URLSearchParams(portalCall!.body).get('return_url');
    expect(returnUrl).toBe(`${billingEnv.APP_ORIGIN}/orgs/${slug}/billing`);
    expect(returnUrl).not.toContain(orgId);
  });

  it('a same-origin path is accepted and passed through', async () => {
    const res = await post(c, '/api/billing/portal', { ownerType: 'org', ownerId: orgId, returnUrl: '/account/billing' });
    expect(res.status).toBe(200);
    const portalCall = stripeCalls.find((s) => s.url.includes('/billing_portal/sessions'));
    expect(new URLSearchParams(portalCall!.body).get('return_url')).toBe(`${billingEnv.APP_ORIGIN}/account/billing`);
  });
});
