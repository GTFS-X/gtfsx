// Regression guards for the 2026-06 checkout outage (handoffs/fix-stripe-checkout.md):
//   1. A raw Stripe error message can embed our secret key verbatim
//      ("Expired API Key provided: sk_live_…") — it must NEVER reach the browser.
//   2. The Planner (internal id 'agency') price IDs must resolve so checkout
//      hands Stripe a valid line item (a missing price ID was a silent failure mode).
//
// The end-to-end "a real Stripe Checkout page renders for Planner" check is
// done manually with the live/test key per the handoff's "Done = verified" — it
// needs a real Stripe secret, which (by design) isn't in the test bindings.

import { beforeEach, describe, it, expect, vi } from 'vitest';
import { ulid } from 'ulidx';
import type { Env } from '../env';
import { assertOrgCanStartCheckout, resolvePortalReturnUrl, stripeFailure } from '../billing/routes';
import { resolvePriceId } from '../billing/stripe';
import { applyMigrations, dbRun, env, resetDb } from './_setup';

const testEnv = env as unknown as Env;

async function seedOrg(plan: 'free' | 'agency' | 'enterprise', opts: { trialEndsAt?: number } = {}): Promise<{ id: string; slug: string }> {
  const id = ulid();
  const slug = `co-${id.toLowerCase()}`;
  await dbRun(
    `INSERT INTO organization (id, slug, name, plan, plan_status, plan_expires_at, created_at)
     VALUES (?, ?, 'Checkout Org', ?, 'active', ?, ?)`,
    id, slug, plan, opts.trialEndsAt ?? null, Date.now(),
  );
  return { id, slug };
}

async function seedSubscription(orgId: string, status: string): Promise<void> {
  const now = Date.now();
  const rowId = ulid();
  await dbRun(
    `INSERT INTO subscription
       (id, owner_type, owner_id, stripe_subscription_id, stripe_customer_id, stripe_price_id,
        plan, status, current_period_start, current_period_end, created_at, updated_at)
     VALUES (?, 'org', ?, ?, 'cus_co', 'price_x', 'agency', ?, ?, ?, ?, ?)`,
    rowId, orgId, `sub_${rowId}`, status, now, now + 1000, now, now,
  );
}

describe('checkout guard against a second subscription (W1-09)', () => {
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    await dbRun(`DELETE FROM subscription`);
  });

  it('an org with an active subscription → 409 already_subscribed', async () => {
    const org = await seedOrg('agency');
    await seedSubscription(org.id, 'active');
    await expect(assertOrgCanStartCheckout(testEnv, org.id)).rejects.toMatchObject({ status: 409 });
  });

  it('a past_due subscription still counts as live', async () => {
    const org = await seedOrg('agency');
    await seedSubscription(org.id, 'past_due');
    await expect(assertOrgCanStartCheckout(testEnv, org.id)).rejects.toMatchObject({ status: 409 });
  });

  it('an Enterprise (staff-granted) org → 409', async () => {
    const org = await seedOrg('enterprise');
    await expect(assertOrgCanStartCheckout(testEnv, org.id)).rejects.toMatchObject({ status: 409 });
  });

  it('an in-app trial org (agency + expiry, no subscription row) may still subscribe', async () => {
    const org = await seedOrg('agency', { trialEndsAt: Date.now() + 86_400_000 });
    await expect(assertOrgCanStartCheckout(testEnv, org.id)).resolves.toBeUndefined();
  });

  it('a free org with only a canceled subscription may subscribe again', async () => {
    const org = await seedOrg('free');
    await seedSubscription(org.id, 'canceled');
    await expect(assertOrgCanStartCheckout(testEnv, org.id)).resolves.toBeUndefined();
  });
});

describe('billing portal return URL (W1-13, W1-20)', () => {
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
  });

  it('defaults to the org billing page keyed by slug, not id', async () => {
    const org = await seedOrg('agency');
    const url = await resolvePortalReturnUrl(testEnv, 'org', org.id, undefined);
    expect(url).toBe(`${testEnv.APP_ORIGIN}/orgs/${org.slug}/billing`);
  });

  it('accepts a same-origin path or absolute same-origin URL', async () => {
    expect(await resolvePortalReturnUrl(testEnv, 'user', 'u1', '/account/billing?x=1'))
      .toBe(`${testEnv.APP_ORIGIN}/account/billing?x=1`);
    expect(await resolvePortalReturnUrl(testEnv, 'user', 'u1', `${testEnv.APP_ORIGIN}/account/billing`))
      .toBe(`${testEnv.APP_ORIGIN}/account/billing`);
  });

  it('rejects off-origin and protocol-relative values with 422', async () => {
    for (const bad of ['https://evil.example/', '//evil.example/x', '/\\evil.example', 'javascript:alert(1)', 'billing']) {
      await expect(resolvePortalReturnUrl(testEnv, 'user', 'u1', bad), bad).rejects.toMatchObject({ status: 422 });
    }
  });
});

describe('billing checkout — Stripe error hygiene', () => {
  it('never echoes the raw Stripe message (incl. the secret key) to the client', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const leaky = {
      message: 'Expired API Key provided: sk_live_51AbCdEf************a1cjVy',
      code: 'api_key_expired',
      type: 'invalid_request_error',
      statusCode: 401,
    };

    const apiErr = stripeFailure(leaky, 'checkout.sessions.create');
    const body = (await apiErr.getResponse().json()) as { error: string; message: string };

    // Client payload is generic and carries no secret / raw Stripe text.
    expect(body.error).toBe('bad_gateway');
    expect(body.message).toMatch(/payment processing is temporarily unavailable/i);
    expect(JSON.stringify(body)).not.toMatch(/sk_live|Expired API Key/);

    // The full detail still reaches the Worker logs (for us, not the user).
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(spy.mock.calls)).toContain('sk_live');
    spy.mockRestore();
  });
});

describe('billing checkout — price resolution', () => {
  const env = {
    STRIPE_PRICE_TEAM_MONTHLY: 'price_agency_m',
    STRIPE_PRICE_TEAM_ANNUAL: 'price_agency_a',
  } as unknown as Parameters<typeof resolvePriceId>[0];

  it('resolves the configured Planner (agency) price IDs for both intervals', () => {
    expect(resolvePriceId(env, 'agency', 'month')).toBe('price_agency_m');
    expect(resolvePriceId(env, 'agency', 'year')).toBe('price_agency_a');
  });

  it('throws (rather than handing Stripe an empty price) when a price ID is unset', () => {
    const empty = {} as unknown as Parameters<typeof resolvePriceId>[0];
    expect(() => resolvePriceId(empty, 'agency', 'month')).toThrow();
  });

  it('throws for plans with no self-serve price (free / enterprise)', () => {
    expect(() => resolvePriceId(env, 'free', 'month')).toThrow();
    expect(() => resolvePriceId(env, 'enterprise', 'year')).toThrow();
  });
});
