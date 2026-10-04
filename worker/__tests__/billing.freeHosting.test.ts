// Free hosting (Oct 2026): snapshot history, publishing + hosting, Service
// Alerts and org branding are granted to every plan; the only paid features
// left are org/team management (org_workspace invites, cross_org_member,
// multi_org) and phone_support. Free quotas were raised to 99 saved / 99
// published feeds. Access isochrones + network walksheds need a signed-in
// account, enforced by the auth-gated GET /api/mapbox/isochrone proxy.
//
// These are SERVER-side assertions: they go through the real routes (SELF) or
// the real gate helpers, never the client mirror.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ulid } from 'ulidx';
import { FEATURE_PLANS, planHasFeature, type FeatureKey } from '../billing/plans';
import { requirePublishAccess } from '../billing/middleware';
import { PLAN_QUOTAS } from '../projects/quotas';
import { ISOCHRONE_MISSES_PER_HOUR } from '../mapbox/isochrone';
import { makeClient, type TestClient } from './_client';
import {
  applyMigrations,
  dbAll,
  dbRun,
  env as testEnv,
  gzip,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';

const NOW_FREE: FeatureKey[] = [
  'managed_publishing',
  'draft_links',
  'mobility_db_submit',
  'embeds',
  'embed_remove_badge',
  'snapshot_history',
  'service_alerts',
  'org_logo',
  'brand_color',
];
const STILL_PAID: FeatureKey[] = ['org_workspace', 'cross_org_member', 'multi_org', 'phone_support'];

async function freeClient(email: string): Promise<{ client: TestClient; userId: string }> {
  const user = await seedUser({ email, plan: 'free' });
  const client = makeClient();
  const res = await client.post('/auth/login', { email: user.email, password: user.password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return { client, userId: user.id };
}

async function createSnapshot(client: TestClient, projectId: string, state: unknown, label?: string) {
  const form = new FormData();
  form.append('state', new Blob([await gzip(JSON.stringify(state))], { type: 'application/json' }), 'state.json.gz');
  form.append('meta', JSON.stringify({ label, summary: {}, validationErrors: 0, validationWarnings: 0 }));
  return client.post(`/api/projects/${projectId}/snapshots`, undefined, { body: form });
}

async function publish(client: TestClient, projectId: string, snapshotId: string) {
  const form = new FormData();
  form.append('meta', JSON.stringify({ snapshotId }));
  form.append('zip', new Blob([new TextEncoder().encode('PK\x03\x04fake-zip')], { type: 'application/zip' }), 'gtfs.zip');
  return client.post(`/api/projects/${projectId}/publish`, undefined, { body: form });
}

async function seedProjects(userId: string, n: number, prefix: string): Promise<string[]> {
  const now = Date.now();
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = ulid();
    ids.push(id);
    await dbRun(
      `INSERT INTO feed_project (id, slug, name, description, owner_type, owner_id,
         working_state_r2_key, working_state_version, working_state_size, working_state_updated_at,
         archived_at, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 'user', ?, NULL, 0, NULL, NULL, NULL, NULL, ?, ?)`,
      id,
      `${prefix}-${i}`,
      `${prefix} ${i}`,
      userId,
      now,
      now,
    );
  }
  return ids;
}

describe('free-hosting entitlement matrix', () => {
  it('grants snapshots, publishing/hosting, alerts and branding to every plan', () => {
    for (const f of NOW_FREE) {
      expect(FEATURE_PLANS[f], f).toEqual(['free', 'agency', 'enterprise']);
    }
  });

  it('leaves only org/team management and phone support paid', () => {
    const paid = (Object.keys(FEATURE_PLANS) as FeatureKey[]).filter((f) => !planHasFeature('free', f));
    expect(paid.sort()).toEqual([...STILL_PAID].sort());
  });

  it('free quotas: 99 saved, 99 published, and at least Planner snapshot/blob limits', () => {
    expect(PLAN_QUOTAS.free.projects).toBe(99);
    expect(PLAN_QUOTAS.free.publishedFeeds).toBe(99);
    expect(PLAN_QUOTAS.free.snapshotsPerProject).toBeGreaterThanOrEqual(PLAN_QUOTAS.agency.snapshotsPerProject);
    expect(PLAN_QUOTAS.free.blobBytes).toBeGreaterThanOrEqual(PLAN_QUOTAS.agency.blobBytes);
  });
});

describe('free user: snapshots + publishing (server routes)', () => {
  let capture: EmailCapture;
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });
  afterEach(() => capture.restore());

  it('a free user can create, list and restore a named snapshot', async () => {
    const { client } = await freeClient('free-snap@example.com');
    const proj = await client.json<{ id: string }>(await client.post('/api/projects', { name: 'Free Snap' }));

    const created = await createSnapshot(client, proj.id, { from: 'free-snapshot' }, 'Before service change');
    expect(created.status).toBe(200);
    const { snapshot } = await client.json<{ snapshot: { id: string; label: string } }>(created);
    expect(snapshot.label).toBe('Before service change');

    const list = await client.json<{ snapshots: { id: string }[] }>(
      await client.get(`/api/projects/${proj.id}/snapshots`),
    );
    expect(list.snapshots.map((s) => s.id)).toContain(snapshot.id);

    const restore = await client.post(`/api/projects/${proj.id}/snapshots/${snapshot.id}/restore`);
    expect(restore.status).toBe(200);
    const ws = await client.get(`/api/projects/${proj.id}/working-state`);
    expect(await ws.json()).toEqual({ from: 'free-snapshot' });
  });

  it('a free user can publish a feed and it is served at the canonical URL', async () => {
    const { client } = await freeClient('free-pub@example.com');
    const proj = await client.json<{ id: string; slug: string }>(await client.post('/api/projects', { name: 'Free Pub' }));
    const snap = await client.json<{ snapshot: { id: string } }>(await createSnapshot(client, proj.id, { routes: [] }));

    const res = await publish(client, proj.id, snap.snapshot.id);
    expect(res.status).toBe(200);
    const body = await client.json<{ publication: { canonicalUrl: string } }>(res);
    expect(body.publication.canonicalUrl).toContain(`/${proj.slug}/gtfs.zip`);
  });

  it('a free user can create a draft link', async () => {
    const { client } = await freeClient('free-draft@example.com');
    const proj = await client.json<{ id: string }>(await client.post('/api/projects', { name: 'Free Draft' }));
    const snap = await client.json<{ snapshot: { id: string } }>(await createSnapshot(client, proj.id, { routes: [] }));
    const form = new FormData();
    form.append('meta', JSON.stringify({ snapshotId: snap.snapshot.id, ttlDays: 7 }));
    form.append('zip', new Blob([new TextEncoder().encode('draft-zip')], { type: 'application/zip' }), 'gtfs.zip');
    const res = await client.post(`/api/projects/${proj.id}/draft-links`, undefined, { body: form });
    expect(res.status).toBe(200);
    expect((await res.json()) as { url: string }).toHaveProperty('url');
  });

  it('the published-feed quota allows the 99th feed and refuses the 100th', async () => {
    const { client, userId } = await freeClient('free-pubquota@example.com');
    const proj = await client.json<{ id: string }>(await client.post('/api/projects', { name: 'Ninety Ninth' }));
    const snap = await client.json<{ snapshot: { id: string } }>(await createSnapshot(client, proj.id, { routes: [] }));

    // 98 already-published feeds (seeded rows referencing the real snapshot).
    const seeded = await seedProjects(userId, 98, 'pubq');
    const now = Date.now();
    for (const id of seeded) {
      await dbRun(
        `INSERT INTO publication (project_id, snapshot_id, published_by_user_id, published_at, canonical_slug, zip_r2_key)
         VALUES (?, ?, ?, ?, ?, ?)`,
        id,
        snap.snapshot.id,
        userId,
        now,
        `slug-${id.toLowerCase()}`,
        `zips/${id}.zip`,
      );
    }

    // The 99th publish succeeds through the real route.
    expect((await publish(client, proj.id, snap.snapshot.id)).status).toBe(200);

    // A 100th NEW publication is refused by the server-side gate (409 quota).
    // (It can't be reached through the route: the 99-saved-feed cap is hit first.)
    await expect(
      requirePublishAccess(testEnv, 'user', userId, { isNewPublication: true }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('the saved-feed cap is a hard 99: the 99th creates, the 100th is refused (409)', async () => {
    const { client, userId } = await freeClient('free-cap@example.com');
    await seedProjects(userId, 98, 'cap');

    const ok = await client.post('/api/projects', { name: 'Feed 99' });
    expect(ok.status).toBe(201);

    const over = await client.post('/api/projects', { name: 'Feed 100' });
    expect(over.status).toBe(409);
    expect(((await over.json()) as { error: string }).error).toBe('quota_exceeded');
    const rows = await dbAll<{ n: number }>(
      `SELECT COUNT(*) AS n FROM feed_project WHERE owner_id = ? AND deleted_at IS NULL`,
      userId,
    );
    expect(rows[0].n).toBe(99);
  });

  it('a free org still cannot invite members (402 org_workspace)', async () => {
    const { client } = await freeClient('free-host-inviter@example.com');
    const created = await client.post('/api/orgs', { slug: 'free-host-org', name: 'Free Host Org' });
    expect(created.status).toBe(201);
    const { organization } = await client.json<{ organization: { id: string } }>(created);
    const res = await client.post(`/api/orgs/${organization.id}/invitations`, {
      email: 'teammate@example.com',
      role: 'editor',
    });
    expect(res.status).toBe(402);
    expect(JSON.stringify(await res.json())).toContain('org_workspace');
  });
});

describe('GET /api/mapbox/isochrone (auth-gated Mapbox proxy)', () => {
  let capture: EmailCapture;
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });
  afterEach(() => {
    capture.restore();
    vi.restoreAllMocks();
  });

  const polygon = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }],
  };

  // Spy on the worker's outbound fetch (the test runs in the same isolate), and
  // let every non-Mapbox request through untouched.
  function spyMapbox() {
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith('https://api.mapbox.com/isochrone/')) {
        calls.push(url);
        return new Response(JSON.stringify(polygon), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return realFetch(input as RequestInfo, init);
    });
    return calls;
  }

  it('anonymous request gets 401 and never reaches Mapbox', async () => {
    const calls = spyMapbox();
    const anon = makeClient();
    const res = await anon.get('/api/mapbox/isochrone?lon=-111.04&lat=45.68&contours_minutes=10');
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('a signed-in FREE user gets the isochrone polygon', async () => {
    const calls = spyMapbox();
    const { client } = await freeClient('free-iso@example.com');
    const res = await client.get('/api/mapbox/isochrone?lon=-111.0421&lat=45.6793&contours_minutes=5');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(polygon);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/mapbox/walking/-111.0421,45.6793');
    expect(calls[0]).toContain('contours_minutes=5');
  });

  it('rejects malformed parameters with 422', async () => {
    spyMapbox();
    const { client } = await freeClient('free-iso-bad@example.com');
    for (const q of ['lon=abc&lat=45&contours_minutes=5', 'lon=-111&lat=95&contours_minutes=5', 'lon=-111&lat=45&contours_minutes=0', 'lon=-111&lat=45&contours_minutes=61', 'lon=-111&lat=45']) {
      const res = await client.get(`/api/mapbox/isochrone?${q}`);
      expect(res.status, q).toBe(422);
    }
  });

  it('caps billed (cache-miss) upstream calls per account (W1-11)', async () => {
    const calls = spyMapbox();
    const { client, userId } = await freeClient('free-iso-rl@example.com');
    // Fill this hour's bucket up to the cap without making ISOCHRONE_MISSES_PER_HOUR requests.
    const bucket = Math.floor(Date.now() / 1000 / 3600);
    await testEnv.KV.put(`rl:mapbox:iso:${userId}:${bucket}`, String(ISOCHRONE_MISSES_PER_HOUR - 1));

    const ok = await client.get('/api/mapbox/isochrone?lon=-110.1111&lat=44.2222&contours_minutes=7');
    expect(ok.status).toBe(200);
    const limited = await client.get('/api/mapbox/isochrone?lon=-110.3333&lat=44.4444&contours_minutes=7');
    expect(limited.status).toBe(429);
    expect(calls).toHaveLength(1);
  });
});
