// Scheduled publish ↔ snapshot integrity:
//  - W2-02: deleting a snapshot with schedule rows no longer 500s after
//    deleting its blobs; a pending schedule blocks the delete (409).
//  - W2-13: a malformed schedule body is a 422; concurrent schedules never 500.
//  - W2-08: the cron claims a row before publishing, so a cancel that lands
//    after the cron's SELECT wins; a claimed row reads as pending.

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { SELF } from 'cloudflare:test';
import { makeClient, type TestClient } from './_client';
import { applyMigrations, dbAll, dbGet, env, gzip, resetDb, seedUser } from './_setup';
import { publishDueSchedules } from '../cron/tasks';

async function loggedIn(email: string): Promise<TestClient> {
  const user = await seedUser({ email });
  const client = makeClient();
  await client.post('/auth/login', { email: user.email, password: user.password });
  return client;
}

async function createProject(client: TestClient, name: string): Promise<{ id: string; slug: string }> {
  return client.json(await client.post('/api/projects', { name }));
}

async function createSnapshot(client: TestClient, projectId: string): Promise<string> {
  const form = new FormData();
  const stateBuf = await gzip(JSON.stringify({ agencies: [] }));
  form.append('state', new Blob([stateBuf], { type: 'application/json' }), 'state.json.gz');
  form.append('meta', JSON.stringify({ summary: {}, validationErrors: 0, validationWarnings: 0 }));
  const body = await client.json<{ snapshot: { id: string } }>(
    await client.post(`/api/projects/${projectId}/snapshots`, undefined, { body: form }),
  );
  return body.snapshot.id;
}

const ZIP = new TextEncoder().encode('PK\x03\x04scheduled');
const FUTURE = () => Date.now() + 60 * 60 * 1000;

function scheduleForm(snapshotId: string, scheduledFor = FUTURE()): FormData {
  const form = new FormData();
  form.append('meta', JSON.stringify({ snapshotId, scheduledFor }));
  form.append('zip', new Blob([ZIP], { type: 'application/zip' }), 'gtfs.zip');
  return form;
}

async function schedule(client: TestClient, projectId: string, snapshotId: string): Promise<Response> {
  return client.post(`/api/projects/${projectId}/publish/schedule`, undefined, { body: scheduleForm(snapshotId) });
}

async function makeDue(projectId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE scheduled_publish SET scheduled_for = ? WHERE project_id = ? AND status = 'pending'`,
  ).bind(Date.now() - 1000, projectId).run();
}

async function snapshotKeys(snapshotId: string): Promise<{ state_r2_key: string; zip_r2_key: string } | null> {
  return dbGet(`SELECT state_r2_key, zip_r2_key FROM feed_snapshot WHERE id = ?`, snapshotId);
}

describe('snapshot delete vs scheduled publish (W2-02)', () => {
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
  });

  it('cancelled schedule: delete succeeds and removes row + blobs + schedule history', async () => {
    const client = await loggedIn('snapdel1@example.com');
    const proj = await createProject(client, 'Snap Del 1');
    const sid = await createSnapshot(client, proj.id);
    expect((await schedule(client, proj.id, sid)).status).toBe(200);
    expect((await client.delete(`/api/projects/${proj.id}/publish/schedule`)).status).toBe(200);
    const keys = await snapshotKeys(sid);

    const res = await client.delete(`/api/projects/${proj.id}/snapshots/${sid}`);
    expect(res.status).toBe(204);
    expect(await snapshotKeys(sid)).toBeNull();
    expect(await env.FEEDS.head(keys!.state_r2_key)).toBeNull();
    expect(await env.FEEDS.head(keys!.zip_r2_key)).toBeNull();
    expect(await dbAll(`SELECT id FROM scheduled_publish WHERE snapshot_id = ?`, sid)).toHaveLength(0);
  });

  it('pending schedule: 409, snapshot row and blobs intact', async () => {
    const client = await loggedIn('snapdel2@example.com');
    const proj = await createProject(client, 'Snap Del 2');
    const sid = await createSnapshot(client, proj.id);
    expect((await schedule(client, proj.id, sid)).status).toBe(200);
    const keys = await snapshotKeys(sid);

    const res = await client.delete(`/api/projects/${proj.id}/snapshots/${sid}`);
    expect(res.status).toBe(409);
    await res.arrayBuffer();
    expect(await snapshotKeys(sid)).not.toBeNull();
    expect(await env.FEEDS.head(keys!.state_r2_key)).not.toBeNull();
    expect(await env.FEEDS.head(keys!.zip_r2_key)).not.toBeNull();
  });

  it('executed schedule: after unpublishing, the snapshot can be deleted', async () => {
    const client = await loggedIn('snapdel3@example.com');
    const proj = await createProject(client, 'Snap Del 3');
    const sid = await createSnapshot(client, proj.id);
    expect((await schedule(client, proj.id, sid)).status).toBe(200);
    await makeDue(proj.id);
    expect(await publishDueSchedules(env)).toEqual({ published: 1, failed: 0 });
    expect((await client.post(`/api/projects/${proj.id}/unpublish`)).status).toBe(204);

    const res = await client.delete(`/api/projects/${proj.id}/snapshots/${sid}`);
    expect(res.status).toBe(204);
    expect(await snapshotKeys(sid)).toBeNull();
  });
});

describe('schedule route robustness (W2-13)', () => {
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
  });

  it('malformed meta JSON is a 422, not a 500', async () => {
    const client = await loggedIn('schedbad@example.com');
    const proj = await createProject(client, 'Bad Meta');
    const form = new FormData();
    form.append('meta', '{');
    form.append('zip', new Blob([ZIP], { type: 'application/zip' }), 'gtfs.zip');
    const res = await client.post(`/api/projects/${proj.id}/publish/schedule`, undefined, { body: form });
    expect(res.status).toBe(422);
    await res.arrayBuffer();
  });

  it('concurrent schedules never 500 and leave exactly one pending row', async () => {
    const client = await loggedIn('schedrace@example.com');
    const proj = await createProject(client, 'Race');
    const sid = await createSnapshot(client, proj.id);
    const results = await Promise.all([1, 2, 3].map(() => schedule(client, proj.id, sid)));
    for (const r of results) {
      expect([200, 409]).toContain(r.status);
      await r.arrayBuffer();
    }
    const pending = await dbAll(`SELECT id FROM scheduled_publish WHERE project_id = ? AND status = 'pending'`, proj.id);
    expect(pending).toHaveLength(1);
  });
});

describe('scheduled-publish cron claim (W2-08)', () => {
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a cancel that lands after the cron selected the row wins', async () => {
    const client = await loggedIn('claim@example.com');
    const proj = await createProject(client, 'Claim');
    const sid = await createSnapshot(client, proj.id);
    expect((await schedule(client, proj.id, sid)).status).toBe(200);
    await makeDue(proj.id);

    // Cancel the row right after publishDueSchedules has SELECTed it.
    const db = env.DB;
    const realPrepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      const stmt = realPrepare(sql);
      if (!sql.includes("WHERE status = 'pending' AND scheduled_for <= ?")) return stmt;
      const realBind = stmt.bind.bind(stmt);
      stmt.bind = ((...args: unknown[]) => {
        const bound = realBind(...args);
        const realAll = bound.all.bind(bound);
        bound.all = (async () => {
          const result = await realAll();
          await realPrepare(
            `UPDATE scheduled_publish SET status = 'cancelled', executed_at = ? WHERE project_id = ? AND status = 'pending'`,
          ).bind(Date.now(), proj.id).run();
          return result;
        }) as typeof bound.all;
        return bound;
      }) as typeof stmt.bind;
      return stmt;
    });

    const result = await publishDueSchedules(env);
    vi.restoreAllMocks();
    expect(result).toEqual({ published: 0, failed: 0 });
    const row = await dbGet<{ status: string }>(`SELECT status FROM scheduled_publish WHERE project_id = ?`, proj.id);
    expect(row?.status).toBe('cancelled');
    expect(await dbGet(`SELECT project_id FROM publication WHERE project_id = ?`, proj.id)).toBeNull();
    const feed = await SELF.fetch(`http://feeds.test/${proj.slug}/gtfs.zip`);
    expect(feed.status).toBe(404);
    await feed.arrayBuffer();
  });

  it('a claimed (running) row reads as pending; an abandoned claim is released as failed', async () => {
    const client = await loggedIn('claim2@example.com');
    const proj = await createProject(client, 'Claim Two');
    const sid = await createSnapshot(client, proj.id);
    expect((await schedule(client, proj.id, sid)).status).toBe(200);
    await env.DB.prepare(`UPDATE scheduled_publish SET status = 'running', executed_at = ? WHERE project_id = ?`)
      .bind(Date.now(), proj.id)
      .run();

    const hist = await client.json<{ scheduled: { status: string } | null }>(
      await client.get(`/api/projects/${proj.id}/publish/history`),
    );
    expect(hist.scheduled?.status).toBe('pending');

    // Claimed two hours ago and never finished.
    await env.DB.prepare(`UPDATE scheduled_publish SET executed_at = ? WHERE project_id = ?`)
      .bind(Date.now() - 2 * 60 * 60 * 1000, proj.id)
      .run();
    await publishDueSchedules(env);
    const row = await dbGet<{ status: string }>(`SELECT status FROM scheduled_publish WHERE project_id = ?`, proj.id);
    expect(row?.status).toBe('failed');
  });
});

describe('scheduling at a slug another project publishes (W2-01)', () => {
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
  });

  it('409 slug_taken at schedule time, and no scheduled_publish row is written', async () => {
    const a = await loggedIn('sq-a@example.com');
    const b = await loggedIn('sq-b@example.com');
    const pa = await createProject(a, 'Metro');
    const sa = await createSnapshot(a, pa.id);
    const form = new FormData();
    form.append('meta', JSON.stringify({ snapshotId: sa }));
    form.append('zip', new Blob([ZIP], { type: 'application/zip' }), 'gtfs.zip');
    expect((await a.post(`/api/projects/${pa.id}/publish`, undefined, { body: form })).status).toBe(200);

    const pb = await createProject(b, 'Metro');
    expect(pb.slug).toBe(pa.slug);
    const sb = await createSnapshot(b, pb.id);
    const res = await schedule(b, pb.id, sb);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { reason?: string }).reason).toBe('slug_taken');
    expect(await dbAll(`SELECT id FROM scheduled_publish WHERE project_id = ?`, pb.id)).toEqual([]);
  });
});
