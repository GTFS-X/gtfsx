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
  DELETED_USER_SENTINEL_ID,
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

// ─── W2-03 / W2-15 / W1-03: everything that references a reaped user ───────

// Foreign keys to user(id) WITHOUT a cascading/nulling ON DELETE action. Each
// one blocks `DELETE FROM user` until reapOne clears it, so each must be
// handled there. Adding a table with a new NO ACTION reference to `user` makes
// the schema test below fail until reapOne handles it and it is listed here.
const NO_ACTION_USER_FKS_HANDLED_BY_REAPER = [
  'checkout_session.initiated_by_user',
  'forum_image.user_id',
  'forum_post.author_user_id',
  'forum_post_upvote.user_id',
  'forum_subscription.user_id',
  'forum_thread.author_user_id',
];

describe('reapDeletedUsers: every user-referencing table', () => {
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    await env.DB.prepare(`DELETE FROM checkout_session`).run();
    await env.DB.prepare(`DELETE FROM subscription`).run();
    await env.DB.prepare(`DELETE FROM assistant_messages`).run();
  });

  afterEach(async () => {
    await env.DB.prepare(`DELETE FROM subscription`).run();
  });

  it('every NO ACTION foreign key to user is one reapOne handles', async () => {
    const tables = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`,
    ).all<{ name: string }>();
    const found: string[] = [];
    for (const { name } of tables.results ?? []) {
      // Virtual (FTS) tables have no foreign keys; skip anything pragma rejects.
      let fks: { table: string; from: string; on_delete: string }[];
      try {
        fks = (await env.DB.prepare(`SELECT "table", "from", on_delete FROM pragma_foreign_key_list(?)`)
          .bind(name)
          .all<{ table: string; from: string; on_delete: string }>()).results ?? [];
      } catch {
        continue;
      }
      for (const fk of fks) {
        if (fk.table !== 'user') continue;
        if (fk.on_delete === 'CASCADE' || fk.on_delete === 'SET NULL') continue;
        found.push(`${name}.${fk.from}`);
      }
    }
    expect(found.sort()).toEqual([...NO_ACTION_USER_FKS_HANDLED_BY_REAPER].sort());
  });

  it('reaps a user with a row in every user-referencing table; forum content survives as "Deleted user"', async () => {
    const now = Date.now();
    const deletedAt = now - DELETE_GRACE_MS - 24 * 60 * 60 * 1000;
    const { userId } = await seedSoftDeletedUser({ email: 'everything@example.com', deletedAt });

    // Someone else, whose thread the reaped user replied to and upvoted.
    const otherId = ulid();
    await env.DB.prepare(
      `INSERT INTO user (id, email, display_name, status, staff, created_at, updated_at)
       VALUES (?, 'other@example.com', 'Other', 'active', 0, ?, ?)`,
    ).bind(otherId, now, now).run();

    const orgId = ulid();
    const threadId = ulid();
    const opId = ulid();
    const ownThreadId = ulid();
    const ownPostId = ulid();
    const replyId = ulid();
    await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO forum_category (id, title, created_at) VALUES ('reaper-cat', 'Reaper', ?)`).bind(now),
      // The other user's thread + OP, upvoted by the reaped user.
      env.DB.prepare(
        `INSERT INTO forum_thread (id, category_id, slug, title, author_user_id, created_at, last_post_at, post_count)
         VALUES (?, 'reaper-cat', 'other-thread', 'Other thread', ?, ?, ?, 2)`,
      ).bind(threadId, otherId, now, now),
      env.DB.prepare(
        `INSERT INTO forum_post (id, thread_id, author_user_id, body_md, upvote_count, created_at)
         VALUES (?, ?, ?, 'Question', 1, ?)`,
      ).bind(opId, threadId, otherId, now),
      env.DB.prepare(`INSERT INTO forum_post_upvote (post_id, user_id, created_at) VALUES (?, ?, ?)`).bind(opId, userId, now),
      // The reaped user's reply in that thread, and their own thread.
      env.DB.prepare(
        `INSERT INTO forum_post (id, thread_id, author_user_id, body_md, created_at) VALUES (?, ?, ?, 'Reply', ?)`,
      ).bind(replyId, threadId, userId, now),
      env.DB.prepare(
        `INSERT INTO forum_thread (id, category_id, slug, title, author_user_id, created_at, last_post_at)
         VALUES (?, 'reaper-cat', 'own-thread', 'Own thread', ?, ?, ?)`,
      ).bind(ownThreadId, userId, now, now),
      env.DB.prepare(
        `INSERT INTO forum_post (id, thread_id, author_user_id, body_md, created_at) VALUES (?, ?, ?, 'Own OP', ?)`,
      ).bind(ownPostId, ownThreadId, userId, now),
      env.DB.prepare(
        `INSERT INTO forum_subscription (user_id, thread_id, source, created_at) VALUES (?, ?, 'reply', ?)`,
      ).bind(userId, threadId, now),
      env.DB.prepare(
        `INSERT INTO forum_image (id, user_id, r2_key, content_type, bytes, created_at)
         VALUES (?, ?, ?, 'image/png', 10, ?)`,
      ).bind(ulid(), userId, `images/${userId}/x.png`, now),
      env.DB.prepare(`INSERT INTO forum_user_state (user_id, created_at, updated_at) VALUES (?, ?, ?)`).bind(userId, now, now),
      // Billing: an org checkout they opened (org has another member, so it survives).
      env.DB.prepare(`INSERT INTO organization (id, slug, name, created_at) VALUES (?, 'reaper-org', 'Reaper Org', ?)`).bind(orgId, now),
      env.DB.prepare(
        `INSERT INTO organization_membership (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)`,
      ).bind(orgId, otherId, now),
      env.DB.prepare(
        `INSERT INTO organization_membership (org_id, user_id, role, created_at) VALUES (?, ?, 'admin', ?)`,
      ).bind(orgId, userId, now),
      env.DB.prepare(
        `INSERT INTO checkout_session (id, owner_type, owner_id, target_plan, target_interval, initiated_by_user, created_at)
         VALUES ('cs_reaper', 'org', ?, 'agency', 'month', ?, ?)`,
      ).bind(orgId, userId, now),
      env.DB.prepare(`INSERT INTO pro_intent (id, user_id, ts, action) VALUES (?, ?, ?, 'feed_cap')`).bind(ulid(), userId, now),
      env.DB.prepare(
        `INSERT INTO assistant_messages (id, user_id, question, answer_class, created_at)
         VALUES (?, ?, 'my secret question', 'supported', ?)`,
      ).bind(ulid(), userId, now),
    ]);

    const summary = await reapDeletedUsers(env);
    expect(summary.errors).toBe(0);
    expect(summary.reaped).toBe(1);

    expect(await env.DB.prepare(`SELECT id FROM user WHERE id = ?`).bind(userId).first()).toBeNull();
    const userColumns: [string, string][] = [
      ...NO_ACTION_USER_FKS_HANDLED_BY_REAPER.map((s) => s.split('.') as [string, string]),
      ['assistant_messages', 'user_id'],
      ['organization_membership', 'user_id'],
      ['forum_user_state', 'user_id'],
      ['pro_intent', 'user_id'],
      ['credential', 'user_id'],
    ];
    for (const [table, col] of userColumns) {
      const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).bind(userId).first<{ n: number }>();
      expect(n?.n, `${table}.${col}`).toBe(0);
    }

    // Threads and posts are still there, attributed to the placeholder.
    const sentinel = await env.DB.prepare(`SELECT display_name, status FROM user WHERE id = ?`)
      .bind(DELETED_USER_SENTINEL_ID)
      .first<{ display_name: string; status: string }>();
    expect(sentinel).toEqual({ display_name: 'Deleted user', status: 'disabled' });
    const own = await env.DB.prepare(`SELECT author_user_id FROM forum_thread WHERE id = ?`).bind(ownThreadId).first<{ author_user_id: string }>();
    expect(own?.author_user_id).toBe(DELETED_USER_SENTINEL_ID);
    const reply = await env.DB.prepare(`SELECT author_user_id FROM forum_post WHERE id = ?`).bind(replyId).first<{ author_user_id: string }>();
    expect(reply?.author_user_id).toBe(DELETED_USER_SENTINEL_ID);
    // Their upvote is gone from the other user's post, and the count followed.
    const op = await env.DB.prepare(`SELECT upvote_count, author_user_id FROM forum_post WHERE id = ?`).bind(opId).first<{ upvote_count: number; author_user_id: string }>();
    expect(op).toEqual({ upvote_count: 0, author_user_id: otherId });
    // The org (another member remains) is untouched.
    expect(await env.DB.prepare(`SELECT id FROM organization WHERE id = ?`).bind(orgId).first()).not.toBeNull();
  });

  it('skips a user who is the last member of an org with a live subscription', async () => {
    const now = Date.now();
    const deletedAt = now - DELETE_GRACE_MS - 24 * 60 * 60 * 1000;
    const { userId } = await seedSoftDeletedUser({ email: 'paying-org@example.com', deletedAt });
    const orgId = ulid();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO organization (id, slug, name, created_at) VALUES (?, 'paying-org', 'Paying', ?)`).bind(orgId, now),
      env.DB.prepare(
        `INSERT INTO organization_membership (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)`,
      ).bind(orgId, userId, now),
      env.DB.prepare(
        `INSERT INTO subscription (id, owner_type, owner_id, stripe_subscription_id, stripe_customer_id, stripe_price_id,
                                   plan, status, current_period_start, current_period_end, created_at, updated_at)
         VALUES (?, 'org', ?, 'sub_reaper', 'cus_reaper', 'price_x', 'agency', 'active', ?, ?, ?, ?)`,
      ).bind(ulid(), orgId, now, now + 1e9, now, now),
    ]);

    const summary = await reapDeletedUsers(env);
    expect(summary.skipped).toBe(1);
    expect(summary.reaped).toBe(0);
    expect(await env.DB.prepare(`SELECT id FROM user WHERE id = ?`).bind(userId).first()).not.toBeNull();
    expect(await env.DB.prepare(`SELECT id FROM organization WHERE id = ?`).bind(orgId).first()).not.toBeNull();

    // Once the subscription is canceled, the next run purges both.
    await env.DB.prepare(`UPDATE subscription SET status = 'canceled' WHERE owner_id = ?`).bind(orgId).run();
    const second = await reapDeletedUsers(env);
    expect(second.reaped).toBe(1);
    expect(await env.DB.prepare(`SELECT id FROM organization WHERE id = ?`).bind(orgId).first()).toBeNull();
  });

  // Same rule as DELETE /api/me (billing/liveSubscription.ts): the sole OWNER
  // of a paying org blocks too, even when other (non-owner) members remain,
  // and so does a live subscription on the user itself.
  it('skips the sole owner of a paying org that has other members, and a user with a live personal subscription', async () => {
    const now = Date.now();
    const deletedAt = now - DELETE_GRACE_MS - 24 * 60 * 60 * 1000;
    const { userId: ownerId } = await seedSoftDeletedUser({ email: 'sole-owner@example.com', deletedAt });
    const { userId: personalId } = await seedSoftDeletedUser({ email: 'personal-sub@example.com', deletedAt });
    const memberId = ulid();
    const orgId = ulid();
    const sub = (ownerType: 'org' | 'user', owner: string, stripeId: string) =>
      env.DB.prepare(
        `INSERT INTO subscription (id, owner_type, owner_id, stripe_subscription_id, stripe_customer_id, stripe_price_id,
                                   plan, status, current_period_start, current_period_end, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'price_x', 'agency', 'past_due', ?, ?, ?, ?)`,
      ).bind(ulid(), ownerType, owner, stripeId, `cus_${stripeId}`, now, now + 1e9, now, now);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user (id, email, display_name, status, created_at, updated_at) VALUES (?, 'member@example.com', 'M', 'active', ?, ?)`,
      ).bind(memberId, now, now),
      env.DB.prepare(`INSERT INTO organization (id, slug, name, created_at) VALUES (?, 'sole-owner-org', 'SoleOwner', ?)`).bind(orgId, now),
      env.DB.prepare(
        `INSERT INTO organization_membership (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)`,
      ).bind(orgId, ownerId, now),
      env.DB.prepare(
        `INSERT INTO organization_membership (org_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)`,
      ).bind(orgId, memberId, now),
      sub('org', orgId, 'sub_sole_owner'),
      sub('user', personalId, 'sub_personal'),
    ]);

    const summary = await reapDeletedUsers(env);
    expect(summary.skipped).toBe(2);
    expect(summary.reaped).toBe(0);
    for (const id of [ownerId, personalId]) {
      expect(await env.DB.prepare(`SELECT id FROM user WHERE id = ?`).bind(id).first()).not.toBeNull();
    }

    await env.DB.prepare(`UPDATE subscription SET status = 'canceled'`).run();
    const second = await reapDeletedUsers(env);
    expect(second.reaped).toBe(2);
    // The org keeps its remaining member.
    expect(await env.DB.prepare(`SELECT id FROM organization WHERE id = ?`).bind(orgId).first()).not.toBeNull();
  });
});
