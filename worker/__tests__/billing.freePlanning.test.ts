// Free planning (Sep 2026): every planning/analysis feature is granted to the
// free plan; organizational user management stays paid. Guards three things:
//   1. the server matrix (worker/billing/plans.ts),
//   2. lockstep parity with the client mirror (src/components/billing/planConfig.ts),
//   3. the server-side gates themselves — a free owner passes the planning
//      feature gate, and a free org is still refused member management (402).
import { beforeEach, describe, expect, it } from 'vitest';
import { FEATURE_PLANS as SERVER_PLANS, PLAN_CATALOG, planHasFeature, cheapestPlanFor, type FeatureKey } from '../billing/plans';
import { FEATURE_PLANS as CLIENT_PLANS } from '../../src/components/billing/planConfig';
import { requireOwnerFeature, describeFeatureAccess } from '../billing/middleware';
import { makeClient, type TestClient } from './_client';
import { applyMigrations, env as testEnv, resetDb, seedUser } from './_setup';

const PLANNING_FEATURES = [
  'analysis_basic',       // route-level cost & coverage, stop analysis
  'analysis_title_vi',    // Title VI equity analysis
  'analysis_propensity',  // demand dots (already free)
  'network_walksheds',    // street-network walksheds in Coverage
  'access_isochrones',    // transit access isochrones
  'variants',             // feed variants + compare-to-baseline (scenario comparison)
  'geojson_export',       // GIS export (already free)
] as const satisfies readonly FeatureKey[];

// Organizational user management — must stay off the free plan.
const ORG_MANAGEMENT_FEATURES = ['org_workspace', 'cross_org_member', 'multi_org'] as const satisfies readonly FeatureKey[];

describe('free-planning entitlement matrix', () => {
  it('grants every planning feature to every plan, free included', () => {
    for (const f of PLANNING_FEATURES) {
      expect(planHasFeature('free', f), f).toBe(true);
      expect(planHasFeature('agency', f), f).toBe(true);
      expect(planHasFeature('enterprise', f), f).toBe(true);
      expect(cheapestPlanFor(f), f).toBe('free');
    }
  });

  it('keeps organizational user management paid', () => {
    for (const f of ORG_MANAGEMENT_FEATURES) {
      expect(planHasFeature('free', f), f).toBe(false);
    }
    expect(planHasFeature('agency', 'org_workspace')).toBe(true);
    expect(planHasFeature('agency', 'cross_org_member')).toBe(true);
    expect(planHasFeature('enterprise', 'multi_org')).toBe(true);
  });

  it('server and client matrices are in exact lockstep', () => {
    expect(Object.keys(CLIENT_PLANS).sort()).toEqual(Object.keys(SERVER_PLANS).sort());
    for (const key of Object.keys(SERVER_PLANS) as FeatureKey[]) {
      expect([...CLIENT_PLANS[key]].sort(), key).toEqual([...SERVER_PLANS[key]].sort());
    }
  });

  it('pricing catalog advertises planning on the free card and team management on Planner', () => {
    const free = PLAN_CATALOG.find((p) => p.plan === 'free')!;
    const planner = PLAN_CATALOG.find((p) => p.plan === 'agency')!;
    expect(free.features.join(' ')).toMatch(/planning suite/i);
    expect(free.features.join(' ')).toMatch(/Title VI/);
    expect(planner.features.join(' ')).toMatch(/Team workspaces/);
    expect(planner.features.join(' ')).not.toMatch(/Title VI|coverage|cost estimates|Scenario comparison/i);
  });
});

describe('server-side gates', () => {
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
  });

  it('a free user passes the planning feature gate for every planning feature', async () => {
    const user = await seedUser({ email: 'free-planner@example.com', plan: 'free' });
    for (const f of PLANNING_FEATURES) {
      await expect(requireOwnerFeature(testEnv, 'user', user.id, f), f).resolves.toBe('free');
      const access = await describeFeatureAccess(testEnv, 'user', user.id, f);
      expect(access.hasAccess, f).toBe(true);
    }
  });

  it('a free-plan org passes the planning gate but not the org-workspace gate', async () => {
    const user = await seedUser({ email: 'free-org-owner@example.com', plan: 'free' });
    const client = await login(user.email, user.password);
    const res = await client.post('/api/orgs', { slug: 'free-planning-org', name: 'Free Planning Org' });
    expect(res.status).toBe(201);
    const { organization } = await client.json<{ organization: { id: string } }>(res);

    await expect(requireOwnerFeature(testEnv, 'org', organization.id, 'access_isochrones')).resolves.toBe('free');
    await expect(requireOwnerFeature(testEnv, 'org', organization.id, 'org_workspace')).rejects.toMatchObject({
      status: 402,
    });
  });

  it('a free-plan org cannot invite members (402 org_workspace)', async () => {
    const user = await seedUser({ email: 'free-inviter@example.com', plan: 'free' });
    const client = await login(user.email, user.password);
    const created = await client.post('/api/orgs', { slug: 'free-invite-org', name: 'Free Invite Org' });
    const { organization } = await client.json<{ organization: { id: string } }>(created);

    const res = await client.post(`/api/orgs/${organization.id}/invitations`, {
      email: 'teammate@example.com',
      role: 'editor',
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { code: string; feature?: string; upgradeTo?: string } } & Record<string, unknown>;
    expect(JSON.stringify(body)).toContain('org_workspace');
  });

  it('a paid (agency) org can still invite members', async () => {
    const user = await seedUser({ email: 'paid-inviter@example.com', plan: 'free' });
    const client = await login(user.email, user.password);
    const created = await client.post('/api/orgs', { slug: 'paid-invite-org', name: 'Paid Invite Org' });
    const { organization } = await client.json<{ organization: { id: string } }>(created);
    await testEnv.DB.prepare('UPDATE organization SET plan = ? WHERE id = ?').bind('agency', organization.id).run();

    const res = await client.post(`/api/orgs/${organization.id}/invitations`, {
      email: 'teammate2@example.com',
      role: 'editor',
    });
    expect(res.status).toBe(204);
  });

  it('a free user who owns an org cannot create a second one (402 multi_org)', async () => {
    const user = await seedUser({ email: 'two-orgs@example.com', plan: 'free' });
    const client = await login(user.email, user.password);
    const first = await client.post('/api/orgs', { slug: 'first-free-org', name: 'First' });
    expect(first.status).toBe(201);
    const second = await client.post('/api/orgs', { slug: 'second-free-org', name: 'Second' });
    expect(second.status).toBe(402);
    expect(JSON.stringify(await second.json())).toContain('multi_org');
  });
});

async function login(email: string, password: string): Promise<TestClient> {
  const client = makeClient();
  const res = await client.post('/auth/login', { email, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return client;
}
