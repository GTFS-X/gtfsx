// worker/cron/tasks.ts → reapDeletedUsers(): hard-purges users whose
// soft-delete is older than DELETE_GRACE_MS (30 days). Users still inside
// the grace window are left alone.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulidx';
import {
  applyMigrations,
  env,
  resetDb,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';
import {
  reapDeletedUsers,
  reapDeletedProjects,
  summarizeWeeklyMetrics,
  expireEnterpriseGrants,
  DELETE_GRACE_MS,
  PROJECT_DELETE_GRACE_MS,
} from '../cron/tasks';
import { purgeProject } from '../projects/purge';
import { hashEmailHex } from '../marketing/ads/userIdentifiers';
import { hashPassword } from '../util/crypto';
import { makeClient } from './_client';

async function seedSoftDeletedUser(opts: {
  email: string;
  deletedAt: number;
  withProject?: boolean;
  withR2?: boolean;
  withAuditAsActor?: boolean;
}): Promise<{ userId: string; projectId?: string }> {
  const id = ulid();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO user (id, email, display_name, status, staff, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, 'deleted_soft', 0, ?, ?, ?)`,
  )
    .bind(id, opts.email, 'Reap Me', now, now, opts.deletedAt)
    .run();

  // Add a credential so we can assert cascade deletion.
  const hash = await hashPassword('hunter2-hunter2');
  await env.DB.prepare(
    `INSERT INTO credential (id, user_id, kind, password_hash, created_at, updated_at)
     VALUES (?, ?, 'password', ?, ?, ?)`,
  )
    .bind(ulid(), id, hash, now, now)
    .run();

  let projectId: string | undefined;
  if (opts.withProject) {
    projectId = ulid();
    await env.DB.prepare(
      `INSERT INTO feed_project
         (id, slug, name, description, owner_type, owner_id,
          working_state_r2_key, working_state_version, working_state_size, working_state_updated_at,
          archived_at, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 'user', ?, ?, 0, NULL, NULL, NULL, NULL, ?, ?)`,
    )
      .bind(projectId, `reap-${projectId}`, 'Reap Project', id, `projects/${projectId}/working-state.json.gz`, now, now)
      .run();
    if (opts.withR2) {
      await env.FEEDS.put(`projects/${projectId}/working-state.json.gz`, new TextEncoder().encode('{}'), {
        httpMetadata: { contentType: 'application/json', contentEncoding: 'gzip' },
      });
    }
  }

  if (opts.withAuditAsActor) {
    await env.DB.prepare(
      `INSERT INTO audit_event (id, actor_user_id, subject_type, subject_id, action, created_at)
       VALUES (?, ?, 'user', ?, 'user.signup', ?)`,
    )
      .bind(ulid(), id, id, now)
      .run();
  }

  return { userId: id, projectId };
}

describe('reapDeletedUsers', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('hard-purges a user whose deleted_at is past the grace period', async () => {
    const deletedAt = Date.now() - DELETE_GRACE_MS - 10 * 24 * 60 * 60 * 1000; // 40 days ago
    const { userId, projectId } = await seedSoftDeletedUser({
      email: 'old-deleted@example.com',
      deletedAt,
      withProject: true,
      withR2: true,
      withAuditAsActor: true,
    });

    // Sanity before.
    const r2Before = await env.FEEDS.get(`projects/${projectId}/working-state.json.gz`);
    expect(r2Before).not.toBeNull();

    const summary = await reapDeletedUsers(env);
    expect(summary.candidates).toBeGreaterThanOrEqual(1);
    expect(summary.reaped).toBeGreaterThanOrEqual(1);

    // User, projects, credentials and actor-audit rows all gone.
    const userRow = await env.DB.prepare(`SELECT id FROM user WHERE id = ?`).bind(userId).first();
    expect(userRow).toBeNull();

    const projRow = await env.DB.prepare(`SELECT id FROM feed_project WHERE id = ?`)
      .bind(projectId)
      .first();
    expect(projRow).toBeNull();

    const credRow = await env.DB.prepare(`SELECT id FROM credential WHERE user_id = ?`)
      .bind(userId)
      .first();
    expect(credRow).toBeNull();

    const auditRow = await env.DB.prepare(
      `SELECT id FROM audit_event WHERE actor_user_id = ?`,
    )
      .bind(userId)
      .first();
    expect(auditRow).toBeNull();

    // R2 blobs cleaned up.
    const r2After = await env.FEEDS.get(`projects/${projectId}/working-state.json.gz`);
    expect(r2After).toBeNull();
  });

  it('leaves users within the 30-day grace window alone', async () => {
    const recent = Date.now() - 5 * 24 * 60 * 60 * 1000; // 5 days ago
    const { userId, projectId } = await seedSoftDeletedUser({
      email: 'recent-deleted@example.com',
      deletedAt: recent,
      withProject: true,
      withR2: true,
    });

    const summary = await reapDeletedUsers(env);
    expect(summary.reaped).toBe(0);

    // User row still present.
    const userRow = await env.DB.prepare(`SELECT id FROM user WHERE id = ?`).bind(userId).first();
    expect(userRow).not.toBeNull();

    // Project + blob untouched.
    const projRow = await env.DB.prepare(`SELECT id FROM feed_project WHERE id = ?`)
      .bind(projectId)
      .first();
    expect(projRow).not.toBeNull();

    const r2After = await env.FEEDS.get(`projects/${projectId}/working-state.json.gz`);
    expect(r2After).not.toBeNull();
  });

  it('keeps audit events where the reaped user is the SUBJECT (but not actor)', async () => {
    const deletedAt = Date.now() - DELETE_GRACE_MS - 1000;
    const { userId } = await seedSoftDeletedUser({
      email: 'subject-audit@example.com',
      deletedAt,
    });

    // Insert a subject-only audit row (some admin or other user acted on this account).
    const otherActor = ulid();
    await env.DB.prepare(
      `INSERT INTO audit_event (id, actor_user_id, subject_type, subject_id, action, created_at)
       VALUES (?, ?, 'user', ?, 'admin.disable_user', ?)`,
    )
      .bind(ulid(), otherActor, userId, Date.now())
      .run();

    await reapDeletedUsers(env);

    const preserved = await env.DB.prepare(
      `SELECT id FROM audit_event WHERE subject_type = 'user' AND subject_id = ? AND action = 'admin.disable_user'`,
    )
      .bind(userId)
      .first();
    expect(preserved).not.toBeNull();
  });
});

// ─── Conversion-email hashes (migration 0032) ───────────────────────────────
//
// `event.oci_email_sha256` is the one piece of a deleted account that lives in
// a table with no user_id, so the reaper has to key on the digest itself. These
// tests pin the three things that can go wrong:
//
//   1. the purge doesn't happen at all;
//   2. it happens too widely and takes another account's hashes with it;
//   3. it "happens" but matches nothing because the reaper normalizes the
//      address differently from the write path — the silent failure, which
//      looks identical to success from the outside. (3) is covered end-to-end
//      through BOTH real code paths: a real signup writes the hash, and the
//      real reaper computes the value it deletes by. Nothing is asserted
//      against a hardcoded digest, so the two cannot drift apart unnoticed.

describe('reapDeletedUsers: conversion email hashes', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    // resetDb() does not clear `event` — it's the cookieless analytics table
    // and carries no FK to anything it truncates.
    await env.DB.prepare(`DELETE FROM event`).run();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  /** A conversion row carrying `hash`, mirroring what insertEvent writes. */
  async function seedConversion(opts: {
    kind: string;
    hash: string | null;
    gclid?: string | null;
    attempts?: number;
  }): Promise<string> {
    const id = ulid();
    await env.DB.prepare(
      `INSERT INTO event
         (id, ts, kind, path, ref, session_id, country, label, gclid, gbraid, wbraid,
          oci_uploaded_at, oci_attempts, oci_last_error, oci_email_sha256)
       VALUES (?, ?, ?, '/signup', NULL, ?, NULL, NULL, ?, NULL, NULL, NULL, ?, NULL, ?)`,
    )
      .bind(id, Date.now(), opts.kind, `sess-${id}`, opts.gclid ?? null, opts.attempts ?? 0, opts.hash)
      .run();
    return id;
  }

  const hashOf = async (id: string): Promise<string | null> => {
    const row = await env.DB.prepare(`SELECT oci_email_sha256 AS h FROM event WHERE id = ?`)
      .bind(id)
      .first<{ h: string | null }>();
    return row?.h ?? null;
  };

  it('nulls the hashes of the reaped account and leaves another user\'s alone', async () => {
    const mine = 'reap-hash@example.com';
    const theirs = 'keep-hash@example.com';
    const { userId } = await seedSoftDeletedUser({
      email: mine,
      deletedAt: Date.now() - DELETE_GRACE_MS - 1000,
    });
    // A second soft-deleted account still inside its grace window — its hash
    // must survive this run entirely.
    await seedSoftDeletedUser({ email: theirs, deletedAt: Date.now() - 1000 });

    const mineHash = await hashEmailHex(mine);
    const theirsHash = await hashEmailHex(theirs);
    expect(mineHash).not.toBeNull();
    expect(mineHash).not.toBe(theirsHash);

    const signUp = await seedConversion({ kind: 'sign_up', hash: mineHash, gclid: 'GCLID-mine' });
    // Same address, different kind — matching on the digest reaches it too.
    const demo = await seedConversion({ kind: 'demo_request', hash: mineHash });
    const other = await seedConversion({ kind: 'sign_up', hash: theirsHash, gclid: 'GCLID-theirs' });

    const summary = await reapDeletedUsers(env);
    expect(summary.errors).toBe(0);
    expect(summary.reaped).toBe(1);
    expect(summary.conversionHashesCleared).toBe(2);

    expect(await hashOf(signUp)).toBeNull();
    expect(await hashOf(demo)).toBeNull();
    expect(await hashOf(other)).toBe(theirsHash);

    // Only the hash is cleared — the anonymous row and its click id stay, as §7
    // of the privacy policy says they do.
    const kept = await env.DB.prepare(`SELECT kind, gclid FROM event WHERE id = ?`)
      .bind(signUp)
      .first<{ kind: string; gclid: string | null }>();
    expect(kept).toEqual({ kind: 'sign_up', gclid: 'GCLID-mine' });

    // And the user really was purged, so this wasn't a no-op run.
    expect(await env.DB.prepare(`SELECT id FROM user WHERE id = ?`).bind(userId).first()).toBeNull();
  });

  // THE normalization test. A hash written by the real write path
  // (POST /auth/signup → hashEmailHex → insertEvent) must be matched by the
  // reaper's own computation. Both ends are the production code; no digest is
  // hardcoded. If the reaper ever stopped sharing hashEmailHex — or the write
  // path started normalizing differently — this is what fails, instead of the
  // purge quietly matching zero rows.
  it('matches a hash written end-to-end by the real signup write path', async () => {
    // Deliberately awkward: mixed case, surrounding whitespace, a gmail +tag
    // and dots — every normalization rule at once. The address STORED on the
    // user row is the raw one, exactly as /auth/signup writes it.
    const raw = '  Cloudy.SanFrancisco+ads@GMail.com  ';
    const client = makeClient();
    const res = await client.post('/auth/signup', {
      email: raw,
      displayName: 'Deleted Later',
      password: 'correct-horse-battery',
      gclid: 'GCLID-e2e',
    });
    expect(res.status).toBe(200);

    const written = await env.DB.prepare(
      `SELECT id, oci_email_sha256 AS h FROM event WHERE kind = 'sign_up'`,
    ).first<{ id: string; h: string | null }>();
    expect(written?.h).toBeTruthy();

    // Age the account out of its grace window, exactly as DELETE /api/me + 30
    // days would. Note the stored email is whatever signup persisted — the
    // reaper has to normalize it back to the same digest on its own.
    const user = await env.DB.prepare(`SELECT id, email FROM user WHERE display_name = 'Deleted Later'`)
      .first<{ id: string; email: string }>();
    expect(user).not.toBeNull();
    await env.DB.prepare(
      `UPDATE user SET status = 'deleted_soft', deleted_at = ? WHERE id = ?`,
    )
      .bind(Date.now() - DELETE_GRACE_MS - 1000, user!.id)
      .run();

    const summary = await reapDeletedUsers(env);
    expect(summary.errors).toBe(0);
    expect(summary.conversionHashesCleared).toBe(1);
    expect(await hashOf(written!.id)).toBeNull();
  });

  it('a purged email-only row drops out of the OCI candidate set instead of burning retries', async () => {
    // The mid-flight case: a sign_up with NO click id, already one failed
    // attempt, whose only identifier was the hash. Once that's gone the row has
    // nothing Google would accept, so it must simply stop being selected —
    // candidateSql's email-only disjunct is gated on `oci_email_sha256 IS NOT
    // NULL`. If it were still selected it would fail forever, one attempt a
    // night, until the -1 sentinel.
    const email = 'midflight@example.com';
    await seedSoftDeletedUser({ email, deletedAt: Date.now() - DELETE_GRACE_MS - 1000 });
    const hash = await hashEmailHex(email);
    const rowId = await seedConversion({ kind: 'sign_up', hash, gclid: null, attempts: 1 });

    // Arm the email-only capability so the row IS a candidate beforehand.
    const policy = { kinds: ['sign_up'] as const, since: Date.now() - 60_000 };
    const candidates = async (): Promise<number> => {
      const r = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM event
          WHERE (gclid IS NOT NULL OR gbraid IS NOT NULL OR wbraid IS NOT NULL
                 OR (oci_email_sha256 IS NOT NULL AND ts > ? AND kind IN ('sign_up')))
            AND oci_uploaded_at IS NULL
            AND kind IN ('sign_up')`,
      )
        .bind(policy.since)
        .first<{ n: number }>();
      return r?.n ?? 0;
    };
    expect(await candidates()).toBe(1);

    await reapDeletedUsers(env);

    expect(await hashOf(rowId)).toBeNull();
    expect(await candidates()).toBe(0);

    // It drops out — it is NOT marked permanently failed, and no further
    // attempt is recorded against it.
    const after = await env.DB.prepare(
      `SELECT oci_uploaded_at, oci_attempts FROM event WHERE id = ?`,
    )
      .bind(rowId)
      .first<{ oci_uploaded_at: number | null; oci_attempts: number }>();
    expect(after?.oci_uploaded_at).toBeNull();
    expect(after?.oci_attempts).toBe(1);
  });

  it('is a no-op for an account with no conversion events', async () => {
    await seedSoftDeletedUser({
      email: 'no-events@example.com',
      deletedAt: Date.now() - DELETE_GRACE_MS - 1000,
    });
    const summary = await reapDeletedUsers(env);
    expect(summary.reaped).toBe(1);
    expect(summary.conversionHashesCleared).toBe(0);
  });
});

describe('expireEnterpriseGrants (comp grants)', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  async function seedPlanUser(plan: string, planExpiresAt: number | null): Promise<string> {
    const id = ulid();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO user (id, email, display_name, status, staff, plan, plan_status, plan_expires_at, created_at, updated_at)
       VALUES (?, ?, 'x', 'active', 0, ?, 'active', ?, ?, ?)`,
    )
      .bind(id, `grant-${id.toLowerCase()}@example.com`, plan, planExpiresAt, now, now)
      .run();
    return id;
  }

  async function seedPlanOrg(plan: string, planExpiresAt: number | null): Promise<string> {
    const id = ulid();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO organization (id, slug, name, plan, plan_status, plan_expires_at, created_at)
       VALUES (?, ?, 'Grant Org', ?, 'active', ?, ?)`,
    )
      .bind(id, `org-${id.toLowerCase()}`, plan, planExpiresAt, now)
      .run();
    return id;
  }

  const past = Date.now() - 60 * 60 * 1000; // 1 hour ago
  const future = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days out

  it('downgrades lapsed agency AND enterprise grants (user + org) to free', async () => {
    const agencyUser = await seedPlanUser('agency', past);
    const enterpriseUser = await seedPlanUser('enterprise', past);
    const agencyOrg = await seedPlanOrg('agency', past);

    const summary = await expireEnterpriseGrants(env);
    expect(summary.users).toBeGreaterThanOrEqual(2);
    expect(summary.orgs).toBeGreaterThanOrEqual(1);

    for (const id of [agencyUser, enterpriseUser]) {
      const row = await env.DB.prepare(
        `SELECT plan, plan_expires_at FROM user WHERE id = ?`,
      ).bind(id).first<{ plan: string; plan_expires_at: number | null }>();
      expect(row?.plan).toBe('free');
      expect(row?.plan_expires_at).toBeNull();
    }

    const orgRow = await env.DB.prepare(
      `SELECT plan, plan_expires_at FROM organization WHERE id = ?`,
    ).bind(agencyOrg).first<{ plan: string; plan_expires_at: number | null }>();
    expect(orgRow?.plan).toBe('free');
    expect(orgRow?.plan_expires_at).toBeNull();
  });

  it('does NOT downgrade a paid-style agency row (plan_expires_at NULL)', async () => {
    const paidUser = await seedPlanUser('agency', null);
    const paidOrg = await seedPlanOrg('agency', null);

    await expireEnterpriseGrants(env);

    const userRow = await env.DB.prepare(`SELECT plan FROM user WHERE id = ?`)
      .bind(paidUser).first<{ plan: string }>();
    expect(userRow?.plan).toBe('agency');

    const orgRow = await env.DB.prepare(`SELECT plan FROM organization WHERE id = ?`)
      .bind(paidOrg).first<{ plan: string }>();
    expect(orgRow?.plan).toBe('agency');
  });

  it('does NOT downgrade a not-yet-expired grant', async () => {
    const futureUser = await seedPlanUser('agency', future);

    const summary = await expireEnterpriseGrants(env);
    expect(summary.users).toBe(0);

    const row = await env.DB.prepare(`SELECT plan, plan_expires_at FROM user WHERE id = ?`)
      .bind(futureUser).first<{ plan: string; plan_expires_at: number | null }>();
    expect(row?.plan).toBe('agency');
    expect(row?.plan_expires_at).toBe(future);
  });
});

// ─── Trash reaper + the shared purge helper ─────────────────────────────────

/** Every table that carries a project_id FK (see worker/projects/purge.ts). */
const PROJECT_CHILD_TABLES = [
  'publication',
  'publication_history',
  'scheduled_publish',
  'draft_link',
  'project_catalog_submission',
  'project_rt_feed',
  'service_alert',
  'embed_impression',
  'feed_snapshot',
] as const;

/** R2 key prefixes a project's blobs live under. */
const projectPrefixes = (id: string) => [`projects/${id}/`, `publications/${id}/`, `draft-links/${id}/`];

/**
 * A project with a row in EVERY project_id table and a blob under every R2
 * prefix — the worst case a purge has to survive. Deliberately includes the
 * published state (publication + publication_history + scheduled_publish all
 * point at feed_snapshot with NO ON DELETE action, which is what would blow up
 * a naive cascade-only purge).
 */
async function seedFullProject(opts: {
  ownerId: string;
  slug: string;
  deletedAt?: number | null;
}): Promise<string> {
  const projectId = ulid();
  const snapshotId = ulid();
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO feed_project
       (id, slug, name, owner_type, owner_id, working_state_r2_key, working_state_version,
        archived_at, deleted_at, created_at, updated_at)
     VALUES (?, ?, ?, 'user', ?, ?, 1, NULL, ?, ?, ?)`,
  )
    .bind(
      projectId,
      opts.slug,
      'Full Project',
      opts.ownerId,
      `projects/${projectId}/working-state.json.gz`,
      opts.deletedAt ?? null,
      now,
      now,
    )
    .run();

  await env.DB.prepare(
    `INSERT INTO feed_snapshot
       (id, project_id, label, created_by_user_id, state_r2_key, zip_r2_key, zip_size,
        summary_json, validation_errors, validation_warnings, created_at)
     VALUES (?, ?, 'v1', ?, ?, ?, 10, '{}', 0, 0, ?)`,
  )
    .bind(
      snapshotId,
      projectId,
      opts.ownerId,
      `projects/${projectId}/snapshots/${snapshotId}/state.json.gz`,
      `projects/${projectId}/snapshots/${snapshotId}/gtfs.zip`,
      now,
    )
    .run();

  await env.DB.prepare(
    `INSERT INTO publication (project_id, snapshot_id, published_by_user_id, published_at, canonical_slug, zip_r2_key)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(projectId, snapshotId, opts.ownerId, now, opts.slug, `publications/${projectId}/${snapshotId}/gtfs.zip`)
    .run();

  await env.DB.prepare(
    `INSERT INTO publication_history (id, project_id, snapshot_id, action, actor_user_id, created_at)
     VALUES (?, ?, ?, 'publish', ?, ?)`,
  )
    .bind(ulid(), projectId, snapshotId, opts.ownerId, now)
    .run();

  await env.DB.prepare(
    `INSERT INTO scheduled_publish (id, project_id, snapshot_id, scheduled_for, status, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
  )
    .bind(ulid(), projectId, snapshotId, now + 60_000, now)
    .run();

  await env.DB.prepare(
    `INSERT INTO draft_link (token_hash, project_id, snapshot_id, created_by_user_id, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(`hash-${projectId}`, projectId, snapshotId, opts.ownerId, now + 86_400_000, now)
    .run();

  await env.DB.prepare(
    `INSERT INTO project_catalog_submission (project_id, catalog, opted_in_at, status)
     VALUES (?, 'mobility_db', ?, 'pending')`,
  )
    .bind(projectId, now)
    .run();

  await env.DB.prepare(
    `INSERT INTO project_rt_feed (id, project_id, kind, url, created_at)
     VALUES (?, ?, 'alerts', 'https://example.com/alerts.pb', ?)`,
  )
    .bind(ulid(), projectId, now)
    .run();

  await env.DB.prepare(
    `INSERT INTO service_alert (id, project_id, header_text, created_at, updated_at)
     VALUES (?, ?, 'Detour', ?, ?)`,
  )
    .bind(ulid(), projectId, now, now)
    .run();

  await env.DB.prepare(
    `INSERT INTO embed_impression (project_id, day, kind, target, views)
     VALUES (?, '2026-07-01', 'system-map', '', 5)`,
  )
    .bind(projectId)
    .run();

  // One blob under each of the three project-scoped R2 prefixes.
  const bytes = new TextEncoder().encode('{}');
  await env.FEEDS.put(`projects/${projectId}/working-state.json.gz`, bytes);
  await env.FEEDS.put(`projects/${projectId}/snapshots/${snapshotId}/gtfs.zip`, bytes);
  await env.FEEDS.put(`publications/${projectId}/${snapshotId}/gtfs.zip`, bytes);
  await env.FEEDS.put(`draft-links/${projectId}/hash-${projectId}.zip`, bytes);

  return projectId;
}

async function countChildRows(projectId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of PROJECT_CHILD_TABLES) {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`)
      .bind(projectId)
      .first<{ n: number }>();
    counts[table] = row?.n ?? 0;
  }
  return counts;
}

async function countBlobs(projectId: string): Promise<number> {
  let total = 0;
  for (const prefix of projectPrefixes(projectId)) {
    const listed = await env.FEEDS.list({ prefix });
    total += listed.objects.length;
  }
  return total;
}

describe('purgeProject', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });
  afterEach(() => capture.restore());

  it('leaves no orphan rows in ANY project_id table, and no R2 blobs', async () => {
    const owner = await seedSoftDeletedUser({ email: 'purge-owner@example.com', deletedAt: Date.now() });
    const projectId = await seedFullProject({ ownerId: owner.userId, slug: 'purge-me' });

    // Every table populated + blobs present before.
    const before = await countChildRows(projectId);
    for (const [table, n] of Object.entries(before)) {
      expect(n, `${table} should be seeded`).toBeGreaterThan(0);
    }
    expect(await countBlobs(projectId)).toBe(4);

    await purgeProject(env, projectId);

    const after = await countChildRows(projectId);
    for (const [table, n] of Object.entries(after)) {
      expect(n, `${table} should have no orphans after purge`).toBe(0);
    }
    expect(await countBlobs(projectId)).toBe(0);
    expect(
      await env.DB.prepare(`SELECT id FROM feed_project WHERE id = ?`).bind(projectId).first(),
    ).toBeNull();
  });

  it('is idempotent — purging twice is a no-op, not an error', async () => {
    const owner = await seedSoftDeletedUser({ email: 'purge-twice@example.com', deletedAt: Date.now() });
    const projectId = await seedFullProject({ ownerId: owner.userId, slug: 'purge-twice' });

    await purgeProject(env, projectId);
    await expect(purgeProject(env, projectId)).resolves.toBeUndefined();
  });

  it('reaping a user purges their PUBLISHED project (the FK edge a cascade-only purge trips on)', async () => {
    const owner = await seedSoftDeletedUser({
      email: 'pub-owner@example.com',
      deletedAt: Date.now() - DELETE_GRACE_MS - 1000,
    });
    const projectId = await seedFullProject({ ownerId: owner.userId, slug: 'owner-published' });

    const summary = await reapDeletedUsers(env);
    expect(summary.errors).toBe(0);
    expect(summary.reaped).toBe(1);

    expect(await countBlobs(projectId)).toBe(0);
    for (const [table, n] of Object.entries(await countChildRows(projectId))) {
      expect(n, `${table} after user reap`).toBe(0);
    }
  });
});

describe('reapDeletedProjects (trash)', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });
  afterEach(() => capture.restore());

  it('purges a project past the grace window and leaves one inside it alone', async () => {
    const owner = await seedSoftDeletedUser({ email: 'trash-owner@example.com', deletedAt: Date.now() });
    // Un-delete the owner — we're reaping projects here, not accounts.
    await env.DB.prepare(`UPDATE user SET status = 'active', deleted_at = NULL WHERE id = ?`)
      .bind(owner.userId)
      .run();

    const expired = await seedFullProject({
      ownerId: owner.userId,
      slug: 'old-trash',
      deletedAt: Date.now() - PROJECT_DELETE_GRACE_MS - 1000,
    });
    const recent = await seedFullProject({
      ownerId: owner.userId,
      slug: 'fresh-trash',
      deletedAt: Date.now() - 5 * 24 * 60 * 60 * 1000, // 5 days ago
    });
    const live = await seedFullProject({ ownerId: owner.userId, slug: 'live-feed' });

    const summary = await reapDeletedProjects(env);
    expect(summary.candidates).toBe(1);
    expect(summary.purged).toBe(1);
    expect(summary.errors).toBe(0);

    // Expired one is gone, blobs and all.
    expect(await env.DB.prepare(`SELECT id FROM feed_project WHERE id = ?`).bind(expired).first()).toBeNull();
    expect(await countBlobs(expired)).toBe(0);

    // The one still inside its window is untouched — rows AND blobs.
    expect(
      await env.DB.prepare(`SELECT id FROM feed_project WHERE id = ?`).bind(recent).first(),
    ).not.toBeNull();
    expect(await countBlobs(recent)).toBe(4);
    for (const [table, n] of Object.entries(await countChildRows(recent))) {
      expect(n, `${table} on the in-window project`).toBeGreaterThan(0);
    }

    // …and so is the live (never-deleted) feed.
    expect(await env.DB.prepare(`SELECT id FROM feed_project WHERE id = ?`).bind(live).first()).not.toBeNull();
    expect(await countBlobs(live)).toBe(4);
  });

  it('does nothing when the trash is empty', async () => {
    const summary = await reapDeletedProjects(env);
    expect(summary).toEqual({ candidates: 0, purged: 0, errors: 0 });
  });
});

describe('summarizeWeeklyMetrics', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('writes a cached metrics snapshot to KV', async () => {
    // Seed a couple of users for counters.
    const now = Date.now();
    for (let i = 0; i < 3; i += 1) {
      await env.DB.prepare(
        `INSERT INTO user (id, email, display_name, status, staff, created_at, updated_at)
         VALUES (?, ?, 'x', 'active', 0, ?, ?)`,
      )
        .bind(ulid(), `metrics-${i}@example.com`, now, now)
        .run();
    }

    const metrics = await summarizeWeeklyMetrics(env);
    expect(metrics.users).toBe(3);
    expect(metrics.computedAt).toBeGreaterThan(0);

    const cached = await env.KV.get('metrics:weekly');
    expect(cached).not.toBeNull();
    const parsed = JSON.parse(cached!) as { users: number };
    expect(parsed.users).toBe(3);
  });
});
