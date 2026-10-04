// Publication integrity on the feeds origin:
//  - W2-01: the public URL (/<slug>/gtfs.zip) is global, project slugs are
//    per-owner — a second owner can't publish at a slug someone already
//    publishes, transfer/restore avoid published slugs, thumbnails resolve
//    through the publication.
//  - W2-04/W2-12: rollback runs through performPublish (catalog meta refresh,
//    quota gate) and only rollback is audited as a rollback.
//  - W2-06: a published feed's slug can't be changed in place.
//  - W2-07: unpublish cancels a pending scheduled publish.
//  - W2-09: the feeds origin ignores soft-deleted projects.
//  - W2-10: the per-project audit includes publication + snapshot events.
//  - W2-11: a late catalog-meta write for an older snapshot is ignored.
//  - W2-16: restore and published-feed transfer respect quotas.
//  - W1-05: org logos are served sandboxed.
//  - W3-20: malformed percent-encoding in an embed path is a 404.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import { ulid } from 'ulidx';
import { makeClient, type TestClient } from './_client';
import {
  applyMigrations,
  dbAll,
  dbGet,
  env,
  gzip,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
  type SeededUser,
} from './_setup';
import { computeAndStoreCatalogMeta } from '../publication/performPublish';
import { publishDueSchedules } from '../cron/tasks';
import { thumbnailKey } from '../projects/r2';
import { PLAN_QUOTAS } from '../projects/quotas';

async function loggedIn(email: string): Promise<{ client: TestClient; user: SeededUser }> {
  const user = await seedUser({ email });
  const client = makeClient();
  await client.post('/auth/login', { email: user.email, password: user.password });
  return { client, user };
}

async function createProject(
  client: TestClient,
  name: string,
  owner?: { type: 'org'; id: string },
): Promise<{ id: string; slug: string }> {
  return client.json(await client.post('/api/projects', owner ? { name, owner } : { name }));
}

function stateWithStops(lat: number, lon: number): unknown {
  return {
    agencies: [],
    routes: [],
    trips: [],
    stops: [
      { stop_id: 's1', stop_lat: lat, stop_lon: lon },
      { stop_id: 's2', stop_lat: lat + 0.01, stop_lon: lon + 0.01 },
    ],
  };
}

async function createSnapshot(client: TestClient, projectId: string, state: unknown = { agencies: [] }): Promise<string> {
  const form = new FormData();
  const stateBuf = await gzip(JSON.stringify(state));
  form.append('state', new Blob([stateBuf], { type: 'application/json' }), 'state.json.gz');
  form.append('meta', JSON.stringify({ summary: {}, validationErrors: 0, validationWarnings: 0 }));
  const body = await client.json<{ snapshot: { id: string } }>(
    await client.post(`/api/projects/${projectId}/snapshots`, undefined, { body: form }),
  );
  return body.snapshot.id;
}

async function publish(client: TestClient, projectId: string, snapshotId: string, body = 'PK\x03\x04zip'): Promise<Response> {
  const form = new FormData();
  form.append('meta', JSON.stringify({ snapshotId }));
  form.append('zip', new Blob([new TextEncoder().encode(body)], { type: 'application/zip' }), 'gtfs.zip');
  return client.post(`/api/projects/${projectId}/publish`, undefined, { body: form });
}

async function publishNew(client: TestClient, name: string, state?: unknown): Promise<{ id: string; slug: string; snapshotId: string }> {
  const proj = await createProject(client, name);
  const snapshotId = await createSnapshot(client, proj.id, state);
  const res = await publish(client, proj.id, snapshotId);
  expect(res.status).toBe(200);
  await res.arrayBuffer();
  return { ...proj, snapshotId };
}

async function createOrg(client: TestClient, slug: string): Promise<string> {
  const body = await client.json<{ organization: { id: string } }>(await client.post('/api/orgs', { slug, name: slug }));
  return body.organization.id;
}

/** Seed `n` published feeds for an owner straight into D1 (fills a quota). */
async function seedPublishedFeeds(ownerType: 'user' | 'org', ownerId: string, n: number): Promise<void> {
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < n; i += 1) {
    const pid = ulid();
    const sid = ulid();
    stmts.push(
      env.DB.prepare(
        `INSERT INTO feed_project (id, slug, name, owner_type, owner_id, created_at, updated_at)
         VALUES (?, ?, 'Filler', ?, ?, ?, ?)`,
      ).bind(pid, `filler-${pid.toLowerCase()}`, ownerType, ownerId, now, now),
      env.DB.prepare(
        `INSERT INTO feed_snapshot (id, project_id, state_r2_key, zip_r2_key, zip_size, summary_json, created_at)
         VALUES (?, ?, 'x', 'x', 0, '{}', ?)`,
      ).bind(sid, pid, now),
      env.DB.prepare(
        `INSERT INTO publication (project_id, snapshot_id, published_at, canonical_slug, zip_r2_key)
         VALUES (?, ?, ?, ?, 'x')`,
      ).bind(pid, sid, now, `filler-${pid.toLowerCase()}`),
    );
  }
  await env.DB.batch(stmts);
}

async function feedEtag(slug: string): Promise<string | null> {
  const res = await SELF.fetch(`http://feeds.test/${slug}/gtfs.zip`);
  await res.arrayBuffer();
  return res.status === 200 ? res.headers.get('ETag') : null;
}

describe('publication integrity', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    await env.DB.prepare(`DELETE FROM organization_membership`).run();
    capture = setupEmailCapture();
  });
  afterEach(() => capture.restore());

  // ─── W2-01 ─────────────────────────────────────────────────────────────────

  it('a second owner cannot publish at a slug another project already publishes', async () => {
    const a = await loggedIn('slug-a@example.com');
    const b = await loggedIn('slug-b@example.com');
    const pa = await publishNew(a.client, 'Metro');
    expect(pa.slug).toBe('metro');

    const pb = await createProject(b.client, 'Metro');
    expect(pb.slug).toBe('metro');
    const sb = await createSnapshot(b.client, pb.id);
    const res = await publish(b.client, pb.id, sb, 'PK\x03\x04attacker');
    expect(res.status).toBe(409);
    const body = (await res.json()) as { reason?: string };
    expect(body.reason).toBe('slug_taken');

    // A unpublishes and republishes: the URL is still A's.
    expect((await a.client.post(`/api/projects/${pa.id}/unpublish`)).status).toBe(204);
    const again = await publish(a.client, pa.id, pa.snapshotId);
    expect(again.status).toBe(200);
    await again.arrayBuffer();
    expect(await feedEtag('metro')).toBe(`"${pa.snapshotId}"`);
    // And B's attempt left no publication behind.
    expect(await dbGet(`SELECT project_id FROM publication WHERE project_id = ?`, pb.id)).toBeNull();
  });

  it('transferring a published feed never lands on another feed\'s published URL', async () => {
    const a = await loggedIn('xfer-a@example.com');
    const c = await loggedIn('xfer-c@example.com');
    const orgId = await createOrg(a.client, 'xfer-org');

    const pub = await publishNew(a.client, 'Alpha');
    // Per-owner collision in the destination forces a suffix…
    await createProject(a.client, 'Alpha', { type: 'org', id: orgId });
    // …and alpha-2 is someone else's live feed URL.
    const other = await publishNew(c.client, 'Alpha 2');
    expect(other.slug).toBe('alpha-2');

    const res = await a.client.post(`/api/projects/${pub.id}/transfer`, { destination: { type: 'org', id: orgId } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { project: { slug: string }; slugChanged: boolean };
    expect(body.slugChanged).toBe(true);
    expect(body.project.slug).toBe('alpha-3');
    expect(await feedEtag('alpha-3')).toBe(`"${pub.snapshotId}"`);
    expect(await feedEtag('alpha-2')).toBe(`"${other.snapshotId}"`);
  });

  it('thumbnail resolves through the publication, not any same-slug project', async () => {
    const b = await loggedIn('thumb-b@example.com');
    const a = await loggedIn('thumb-a@example.com');
    // B's unpublished "metro" is the OLDER project row.
    const pb = await createProject(b.client, 'Metro');
    const pa = await publishNew(a.client, 'Metro');

    for (const [id, label] of [[pa.id, 'A'], [pb.id, 'B']] as const) {
      await env.FEEDS.put(thumbnailKey(id, 'lg'), new TextEncoder().encode(label));
      await env.DB.prepare(`UPDATE feed_project SET thumbnail_version = 3 WHERE id = ?`).bind(id).run();
    }

    const res = await SELF.fetch('http://feeds.test/metro/thumbnail.png');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('A');
  });

  // ─── W2-06 ─────────────────────────────────────────────────────────────────

  it('changing the slug of a published feed is refused; the feed keeps serving', async () => {
    const a = await loggedIn('patch-slug@example.com');
    const pub = await publishNew(a.client, 'Published One');
    const res = await a.client.patch(`/api/projects/${pub.id}`, { slug: 'moved-elsewhere' });
    expect(res.status).toBe(409);
    await res.arrayBuffer();
    expect(await feedEtag(pub.slug)).toBe(`"${pub.snapshotId}"`);
    const row = await dbGet<{ slug: string }>(`SELECT slug FROM feed_project WHERE id = ?`, pub.id);
    expect(row?.slug).toBe(pub.slug);

    // An unpublished feed can still be renamed.
    const draft = await createProject(a.client, 'Not Published');
    const ok = await a.client.patch(`/api/projects/${draft.id}`, { slug: 'renamed-ok' });
    expect(ok.status).toBe(200);
    await ok.arrayBuffer();
  });

  // ─── W2-04 / W2-12 / W2-11 ────────────────────────────────────────────────

  async function pollMeta(projectId: string, predicate: (meta: { bbox?: unknown } | null) => boolean): Promise<{ bbox?: { minLat?: number; min_lat?: number } } | null> {
    let meta: { bbox?: unknown } | null = null;
    for (let i = 0; i < 60; i += 1) {
      const row = await dbGet<{ catalog_meta_json: string | null }>(
        `SELECT catalog_meta_json FROM publication WHERE project_id = ?`,
        projectId,
      );
      meta = row?.catalog_meta_json ? JSON.parse(row.catalog_meta_json) : null;
      if (predicate(meta)) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    return meta as { bbox?: { minLat?: number } } | null;
  }

  it('rollback refreshes catalog meta and is the only publish audited as a rollback', async () => {
    const a = await loggedIn('rollback@example.com');
    const proj = await createProject(a.client, 'Rolling');
    const s1 = await createSnapshot(a.client, proj.id, stateWithStops(10, 20));
    const s2 = await createSnapshot(a.client, proj.id, stateWithStops(40, 50));

    const r1 = await publish(a.client, proj.id, s1);
    expect(r1.status).toBe(200);
    await r1.arrayBuffer();
    const metaX = JSON.stringify((await pollMeta(proj.id, (m) => !!m?.bbox))?.bbox);

    const r2 = await publish(a.client, proj.id, s2);
    expect(r2.status).toBe(200);
    await r2.arrayBuffer();
    const metaY = JSON.stringify((await pollMeta(proj.id, (m) => !!m?.bbox && JSON.stringify(m.bbox) !== metaX))?.bbox);
    expect(metaY).not.toBe(metaX);

    const rb = await a.client.post(`/api/projects/${proj.id}/publish/rollback`, { snapshotId: s1 });
    expect(rb.status).toBe(200);
    await rb.arrayBuffer();
    const after = JSON.stringify((await pollMeta(proj.id, (m) => JSON.stringify(m?.bbox) === metaX))?.bbox);
    expect(after).toBe(metaX);
    expect(await feedEtag(proj.slug)).toBe(`"${s1}"`);

    const history = await dbAll<{ action: string; snapshot_id: string }>(
      `SELECT action, snapshot_id FROM publication_history WHERE project_id = ? ORDER BY created_at, rowid`,
      proj.id,
    );
    expect(history.map((h) => h.action)).toEqual(['publish', 'publish', 'rollback']);

    const audits = await dbAll<{ metadata_json: string }>(
      `SELECT metadata_json FROM audit_event WHERE action = 'project.publish' AND subject_id = ? ORDER BY id`,
      proj.id,
    );
    expect(audits.map((r) => JSON.parse(r.metadata_json).rollback)).toEqual([false, false, true]);
  });

  it('rollback of an unpublished feed is subject to the published-feed quota', async () => {
    const a = await loggedIn('rollback-quota@example.com');
    await env.DB.prepare(`UPDATE user SET plan = 'free' WHERE id = ?`).bind(a.user.id).run();
    const proj = await createProject(a.client, 'Quota Roll');
    const s1 = await createSnapshot(a.client, proj.id);
    const r1 = await publish(a.client, proj.id, s1);
    expect(r1.status).toBe(200);
    await r1.arrayBuffer();
    expect((await a.client.post(`/api/projects/${proj.id}/unpublish`)).status).toBe(204);

    await seedPublishedFeeds('user', a.user.id, 99);
    const rb = await a.client.post(`/api/projects/${proj.id}/publish/rollback`, { snapshotId: s1 });
    expect(rb.status).toBe(409);
    expect(((await rb.json()) as { error: string }).error).toBe('quota_exceeded');
    expect(await dbGet(`SELECT project_id FROM publication WHERE project_id = ?`, proj.id)).toBeNull();
  });

  it('a late catalog-meta write for an older snapshot does not overwrite the live one', async () => {
    const a = await loggedIn('meta-race@example.com');
    const proj = await createProject(a.client, 'Meta Race');
    const s1 = await createSnapshot(a.client, proj.id, stateWithStops(10, 20));
    const s2 = await createSnapshot(a.client, proj.id, stateWithStops(40, 50));
    for (const s of [s1, s2]) {
      const r = await publish(a.client, proj.id, s);
      expect(r.status).toBe(200);
      await r.arrayBuffer();
    }
    const live = await pollMeta(proj.id, (m) => !!m?.bbox && JSON.stringify(m.bbox).includes('40'));
    const liveJson = JSON.stringify(live);

    const s1Row = await dbGet<{ state_r2_key: string }>(`SELECT state_r2_key FROM feed_snapshot WHERE id = ?`, s1);
    await computeAndStoreCatalogMeta(env, proj.id, s1, s1Row!.state_r2_key);

    const row = await dbGet<{ catalog_meta_json: string }>(
      `SELECT catalog_meta_json FROM publication WHERE project_id = ?`,
      proj.id,
    );
    expect(JSON.stringify(JSON.parse(row!.catalog_meta_json))).toBe(liveJson);
  });

  // ─── W2-07 ─────────────────────────────────────────────────────────────────

  it('unpublish cancels a pending scheduled publish', async () => {
    const a = await loggedIn('unpub-sched@example.com');
    const pub = await publishNew(a.client, 'Sched Then Unpub');
    const s2 = await createSnapshot(a.client, pub.id);
    const form = new FormData();
    form.append('meta', JSON.stringify({ snapshotId: s2, scheduledFor: Date.now() + 3_600_000 }));
    form.append('zip', new Blob([new TextEncoder().encode('PK\x03\x04later')], { type: 'application/zip' }), 'gtfs.zip');
    const sched = await a.client.post(`/api/projects/${pub.id}/publish/schedule`, undefined, { body: form });
    expect(sched.status).toBe(200);
    await sched.arrayBuffer();

    expect((await a.client.post(`/api/projects/${pub.id}/unpublish`)).status).toBe(204);
    const row = await dbGet<{ status: string }>(`SELECT status FROM scheduled_publish WHERE project_id = ?`, pub.id);
    expect(row?.status).toBe('cancelled');

    await env.DB.prepare(`UPDATE scheduled_publish SET scheduled_for = ? WHERE project_id = ?`)
      .bind(Date.now() - 1000, pub.id)
      .run();
    expect(await publishDueSchedules(env)).toEqual({ published: 0, failed: 0 });
    expect(await feedEtag(pub.slug)).toBeNull();
  });

  // ─── W2-09 ─────────────────────────────────────────────────────────────────

  it('the feeds origin stops serving a publication whose project is soft-deleted', async () => {
    const a = await loggedIn('deleted-pub@example.com');
    const pub = await publishNew(a.client, 'Gone Feed');
    expect(await feedEtag(pub.slug)).not.toBeNull();

    // What an org delete does to its projects (soft-delete, publication row left).
    await env.DB.prepare(`UPDATE feed_project SET deleted_at = ? WHERE id = ?`).bind(Date.now(), pub.id).run();

    for (const path of ['gtfs.zip', 'feed_info.json', 'alerts.pb', 'dmfr.json']) {
      const res = await SELF.fetch(`http://feeds.test/${pub.slug}/${path}`);
      expect(res.status, path).toBe(404);
      await res.arrayBuffer();
    }
  });

  // ─── W2-10 ─────────────────────────────────────────────────────────────────

  it('the project audit log includes publish and snapshot events', async () => {
    const a = await loggedIn('audit-proj@example.com');
    const pub = await publishNew(a.client, 'Audited');
    const res = await a.client.get(`/api/projects/${pub.id}/audit`);
    expect(res.status).toBe(200);
    const actions = ((await res.json()) as { events: { action: string }[] }).events.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['project.create', 'project.create_snapshot', 'project.publish']));
  });

  // ─── W2-16 ─────────────────────────────────────────────────────────────────

  it('restoring a feed from the trash respects the project quota', async () => {
    const a = await loggedIn('restore-quota@example.com');
    await env.DB.prepare(`UPDATE user SET plan = 'free' WHERE id = ?`).bind(a.user.id).run();
    const proj = await createProject(a.client, 'Trashed');
    expect((await a.client.delete(`/api/projects/${proj.id}`)).status).toBe(204);

    const now = Date.now();
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < 99; i += 1) {
      const id = ulid();
      stmts.push(
        env.DB.prepare(
          `INSERT INTO feed_project (id, slug, name, owner_type, owner_id, created_at, updated_at)
           VALUES (?, ?, 'Filler', 'user', ?, ?, ?)`,
        ).bind(id, `fill-${id.toLowerCase()}`, a.user.id, now, now),
      );
    }
    await env.DB.batch(stmts);

    const res = await a.client.post(`/api/projects/${proj.id}/restore`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('quota_exceeded');
    const row = await dbGet<{ deleted_at: number | null }>(`SELECT deleted_at FROM feed_project WHERE id = ?`, proj.id);
    expect(row?.deleted_at).not.toBeNull();
  });

  it('transferring a published feed respects the destination published-feed quota', async () => {
    // With today's quota table a destination at its published-feed cap is also
    // at its project cap (published feeds are a subset of projects, and both
    // caps are 99 on free). Lift the project cap for this test so the
    // published-feed check is what's exercised.
    const savedProjects = PLAN_QUOTAS.free.projects;
    PLAN_QUOTAS.free.projects = 100_000;
    try {
      const a = await loggedIn('xfer-quota@example.com');
      const orgId = await createOrg(a.client, 'xfer-quota-org');
      await seedPublishedFeeds('org', orgId, PLAN_QUOTAS.free.publishedFeeds);
      const pub = await publishNew(a.client, 'Busy Feed');

      const res = await a.client.post(`/api/projects/${pub.id}/transfer`, { destination: { type: 'org', id: orgId } });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; kind?: string };
      expect(body.error).toBe('quota_exceeded');
      expect(body.kind).toBe('published');
      const row = await dbGet<{ owner_type: string }>(`SELECT owner_type FROM feed_project WHERE id = ?`, pub.id);
      expect(row?.owner_type).toBe('user');
    } finally {
      PLAN_QUOTAS.free.projects = savedProjects;
    }
  });

  // ─── W1-05 / W3-20 ────────────────────────────────────────────────────────

  it('org logos are served with nosniff and a sandboxing CSP', async () => {
    const a = await loggedIn('logo-hdr@example.com');
    const orgId = await createOrg(a.client, 'logo-hdr-org');
    const key = `orgs/${orgId}/logo-test.svg`;
    await env.FEEDS.put(key, new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'));
    await env.DB.prepare(
      `UPDATE organization SET brand_logo_r2_key = ?, brand_logo_content_type = 'image/svg+xml', brand_logo_updated_at = ? WHERE id = ?`,
    ).bind(key, Date.now(), orgId).run();

    const res = await SELF.fetch(`http://feeds.test/_/orgs/${orgId}/logo`);
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy') ?? '').toContain('sandbox');
    expect(res.headers.get('Content-Security-Policy') ?? '').toContain("default-src 'none'");
  });

  it('malformed percent-encoding in an embed path is a 404, not a 500', async () => {
    for (const path of ['/any-feed/embed/stop/%ZZ', '/any-feed/embed/route/%E0%A4%A']) {
      const res = await SELF.fetch(`http://feeds.test${path}`);
      expect(res.status, path).toBe(404);
      await res.arrayBuffer();
    }
  });
});
