// Stripe webhook delivery semantics (W1-02) and subscription ordering (W1-10).
//
// Drives handleStripeWebhook directly with a hand-built env carrying test
// Stripe secrets (the pool's bindings have none) and real signed payloads, so
// the signature check, the stripe_event idempotency row and the handlers all
// run for real against D1.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { ulid } from 'ulidx';
import type { Env } from '../env';
import { handleStripeWebhook } from '../billing/webhooks';
import { applyMigrations, dbGet, dbRun, env, resetDb } from './_setup';

const WEBHOOK_SECRET = 'whsec_test_b1';
const PRICE = 'price_agency_m';

const baseEnv = {
  ...env,
  STRIPE_SECRET_KEY: 'sk_test_b1',
  STRIPE_WEBHOOK_SIGNING_SECRET: WEBHOOK_SECRET,
  STRIPE_PRICE_TEAM_MONTHLY: PRICE,
} as unknown as Env;

const signer = new Stripe('sk_test_b1', { httpClient: Stripe.createFetchHttpClient() });

async function seedOrg(plan: 'free' | 'agency' | 'enterprise' = 'free'): Promise<string> {
  const id = ulid();
  await dbRun(
    `INSERT INTO organization (id, slug, name, plan, plan_status, created_at)
     VALUES (?, ?, 'Webhook Org', ?, 'active', ?)`,
    id, `org-${id.toLowerCase()}`, plan, Date.now(),
  );
  return id;
}

function subscriptionObject(opts: { id: string; orgId: string; status: string }): Record<string, unknown> {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    id: opts.id,
    object: 'subscription',
    customer: `cus_${opts.orgId}`,
    status: opts.status,
    metadata: { owner_type: 'org', owner_id: opts.orgId, target_plan: 'agency' },
    items: {
      data: [
        {
          price: { id: PRICE },
          quantity: 1,
          current_period_start: nowSec,
          current_period_end: nowSec + 30 * 24 * 3600,
        },
      ],
    },
    trial_end: null,
    cancel_at_period_end: false,
    canceled_at: opts.status === 'canceled' ? nowSec : null,
  };
}

async function deliver(
  type: string,
  object: Record<string, unknown>,
  opts: { eventId?: string; envOverride?: Env } = {},
): Promise<{ status: number; eventId: string }> {
  const eventId = opts.eventId ?? `evt_${ulid()}`;
  const payload = JSON.stringify({
    id: eventId,
    object: 'event',
    type,
    created: Math.floor(Date.now() / 1000),
    data: { object },
  });
  const header = await signer.webhooks.generateTestHeaderStringAsync({ payload, secret: WEBHOOK_SECRET });
  const req = new Request('http://127.0.0.1/api/billing/webhooks/stripe', {
    method: 'POST',
    headers: { 'stripe-signature': header, 'Content-Type': 'application/json' },
    body: payload,
  });
  const res = await handleStripeWebhook(req, opts.envOverride ?? baseEnv);
  return { status: res.status, eventId };
}

/** An env whose DB fails the first `UPDATE organization SET plan` it sees. */
function envFailingOrgPlanUpdateOnce(): Env {
  let armed = true;
  const realDb = baseEnv.DB;
  const db = new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql: string) => {
          if (armed && /UPDATE organization\s+SET plan = \?/.test(sql)) {
            armed = false;
            return {
              bind: () => ({
                run: () => Promise.reject(new Error('D1_ERROR: simulated transient failure')),
              }),
            };
          }
          return target.prepare(sql);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { ...baseEnv, DB: db } as Env;
}

async function orgPlan(orgId: string) {
  return dbGet<{ plan: string; plan_status: string }>(
    `SELECT plan, plan_status FROM organization WHERE id = ?`,
    orgId,
  );
}

describe('Stripe webhook redelivery (W1-02)', () => {
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    await dbRun(`DELETE FROM subscription`);
    await dbRun(`DELETE FROM stripe_event`);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('a delivery that failed is re-dispatched on Stripe\'s retry', async () => {
    const orgId = await seedOrg('free');
    const sub = subscriptionObject({ id: `sub_${ulid()}`, orgId, status: 'active' });

    const first = await deliver('customer.subscription.created', sub, { envOverride: envFailingOrgPlanUpdateOnce() });
    expect(first.status).toBe(500);
    expect((await orgPlan(orgId))?.plan).toBe('free');
    const failedRow = await dbGet<{ processed_at: number | null; error: string | null }>(
      `SELECT processed_at, error FROM stripe_event WHERE id = ?`, first.eventId,
    );
    expect(failedRow?.processed_at).toBeNull();
    expect(failedRow?.error).toContain('simulated');

    const retry = await deliver('customer.subscription.created', sub, { eventId: first.eventId });
    expect(retry.status).toBe(200);
    expect((await orgPlan(orgId))?.plan).toBe('agency');
    const row = await dbGet<{ processed_at: number | null; error: string | null }>(
      `SELECT processed_at, error FROM stripe_event WHERE id = ?`, first.eventId,
    );
    expect(row?.processed_at).not.toBeNull();
    expect(row?.error).toBeNull();
  });

  it('a duplicate of an already-processed event short-circuits without re-running handlers', async () => {
    const orgId = await seedOrg('free');
    const sub = subscriptionObject({ id: `sub_${ulid()}`, orgId, status: 'active' });
    const first = await deliver('customer.subscription.created', sub);
    expect(first.status).toBe(200);

    // Change state behind the webhook's back; a real re-dispatch would undo it.
    await dbRun(`UPDATE organization SET plan = 'free' WHERE id = ?`, orgId);
    const dup = await deliver('customer.subscription.created', sub, { eventId: first.eventId });
    expect(dup.status).toBe(200);
    expect((await orgPlan(orgId))?.plan).toBe('free');
  });
});

describe('subscription ordering + deletion (W1-10)', () => {
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    await dbRun(`DELETE FROM subscription`);
    await dbRun(`DELETE FROM stripe_event`);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('(a) deleting one of two live subscriptions keeps the owner on agency', async () => {
    const orgId = await seedOrg('free');
    const subA = subscriptionObject({ id: `sub_a_${ulid()}`, orgId, status: 'active' });
    const subB = subscriptionObject({ id: `sub_b_${ulid()}`, orgId, status: 'active' });
    expect((await deliver('customer.subscription.created', subA)).status).toBe(200);
    expect((await deliver('customer.subscription.created', subB)).status).toBe(200);

    expect((await deliver('customer.subscription.deleted', { ...subA, status: 'canceled' })).status).toBe(200);
    const org = await orgPlan(orgId);
    expect(org?.plan).toBe('agency');
    expect(org?.plan_status).toBe('active');
  });

  it('(b) a late `updated(active)` after `deleted` does not re-grant the plan', async () => {
    const orgId = await seedOrg('free');
    const sub = subscriptionObject({ id: `sub_${ulid()}`, orgId, status: 'active' });
    await deliver('customer.subscription.created', sub);
    await deliver('customer.subscription.deleted', { ...sub, status: 'canceled' });
    expect((await orgPlan(orgId))?.plan).toBe('free');

    expect((await deliver('customer.subscription.updated', sub)).status).toBe(200);
    expect((await orgPlan(orgId))?.plan).toBe('free');
    const row = await dbGet<{ status: string }>(
      `SELECT status FROM subscription WHERE stripe_subscription_id = ?`, sub.id,
    );
    expect(row?.status).toBe('canceled');
  });

  it('(c) a subscription ending on an Enterprise (staff-granted) owner leaves Enterprise in place', async () => {
    const orgId = await seedOrg('enterprise');
    const nowMs = Date.now();
    const subId = `sub_${ulid()}`;
    await dbRun(
      `INSERT INTO subscription
         (id, owner_type, owner_id, stripe_subscription_id, stripe_customer_id, stripe_price_id,
          plan, status, quantity, current_period_start, current_period_end, created_at, updated_at)
       VALUES (?, 'org', ?, ?, ?, ?, 'agency', 'active', 1, ?, ?, ?, ?)`,
      ulid(), orgId, subId, `cus_${orgId}`, PRICE, nowMs, nowMs + 1000, nowMs, nowMs,
    );

    const sub = subscriptionObject({ id: subId, orgId, status: 'canceled' });
    expect((await deliver('customer.subscription.deleted', sub)).status).toBe(200);
    expect((await orgPlan(orgId))?.plan).toBe('enterprise');
  });

  it('deleting the only subscription still downgrades to free', async () => {
    const orgId = await seedOrg('free');
    const sub = subscriptionObject({ id: `sub_${ulid()}`, orgId, status: 'active' });
    await deliver('customer.subscription.created', sub);
    expect((await orgPlan(orgId))?.plan).toBe('agency');
    await deliver('customer.subscription.deleted', { ...sub, status: 'canceled' });
    const org = await orgPlan(orgId);
    expect(org?.plan).toBe('free');
    expect(org?.plan_status).toBe('canceled');
  });
});
