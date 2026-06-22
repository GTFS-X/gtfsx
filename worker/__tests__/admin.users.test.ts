// /api/admin/users — list/filter/paginate, detail, patch, resend verification,
// soft-delete.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulidx';
import { makeClient, type TestClient } from './_client';
import {
  applyMigrations,
  dbAll,
  dbGet,
  dbRun,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';

async function staffClient(email = 'admin@example.com'): Promise<{ client: TestClient; userId: string }> {
  const user = await seedUser({ email, staff: true });
  const client = makeClient();
  const res = await client.post('/auth/login', { email: user.email, password: user.password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return { client, userId: user.id };
}

interface UserListResp {
  users: Array<{
    id: string;
    email: string;
    status: string;
    staff: boolean;
    createdAt: number;
    lastSessionAt: number | null;
    projectCount: number;
  }>;
  nextCursor: string | null;
}

describe('/api/admin/users list + filter + pagination', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('lists users newest first with lastSessionAt and projectCount', async () => {
    const { client } = await staffClient();
    const u1 = await seedUser({ email: 'user1@example.com' });
    await seedUser({ email: 'user2@example.com' });

    const res = await client.get('/api/admin/users');
    expect(res.status).toBe(200);
    const body = (await res.json()) as UserListResp;
    expect(body.users.length).toBe(3); // staff + 2 users
    // Newest first — the last-seeded user comes first.
    expect(body.users[0].email).toBe('user2@example.com');

    // Ensure shape is complete.
    const staffEntry = body.users.find((u) => u.staff);
    expect(staffEntry).toBeTruthy();
    expect(typeof staffEntry!.createdAt).toBe('number');
    expect(staffEntry!.projectCount).toBe(0);
    // The staff user logged in, so they should have a lastSessionAt.
    expect(staffEntry!.lastSessionAt).not.toBeNull();

    // u1 never logged in: lastSessionAt is null.
    const u1Entry = body.users.find((u) => u.id === u1.id);
    expect(u1Entry!.lastSessionAt).toBeNull();
  });

  it('filters by email substring (case-insensitive)', async () => {
    const { client } = await staffClient();
    await seedUser({ email: 'alice@Acme.co' });
    await seedUser({ email: 'bob@example.com' });

    const res = await client.get('/api/admin/users?q=ACME');
    const body = (await res.json()) as UserListResp;
    expect(body.users.length).toBe(1);
    expect(body.users[0].email.toLowerCase()).toContain('acme');
  });

  it('filters by status', async () => {
    const { client } = await staffClient();
    await seedUser({ email: 'pending@example.com', status: 'pending_verification' });
    await seedUser({ email: 'disabled@example.com', status: 'disabled' });
    await seedUser({ email: 'active@example.com', status: 'active' });

    const p = await client.get('/api/admin/users?status=pending_verification');
    const pBody = (await p.json()) as UserListResp;
    expect(pBody.users.length).toBe(1);
    expect(pBody.users[0].status).toBe('pending_verification');

    const d = await client.get('/api/admin/users?status=disabled');
    const dBody = (await d.json()) as UserListResp;
    expect(dBody.users.length).toBe(1);
    expect(dBody.users[0].status).toBe('disabled');
  });

  it('paginates via page / pageSize, returns nextCursor when more available', async () => {
    const { client } = await staffClient();
    for (let i = 0; i < 5; i++) await seedUser({ email: `p-${i}@example.com` });

    const page1 = await client.get('/api/admin/users?pageSize=2&page=1');
    const body1 = (await page1.json()) as UserListResp;
    expect(body1.users.length).toBe(2);
    expect(body1.nextCursor).not.toBeNull();

    const page3 = await client.get('/api/admin/users?pageSize=2&page=3');
    const body3 = (await page3.json()) as UserListResp;
    // 6 total (1 staff + 5 users) → page 3 has 2 entries, nextCursor null.
    expect(body3.users.length).toBe(2);
    expect(body3.nextCursor).toBeNull();
  });
});

describe('/api/admin/users/:id detail', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('returns user detail + memberships + audit', async () => {
    const { client, userId: staffId } = await staffClient();
    const target = await seedUser({ email: 'target@example.com' });

    // Trigger an admin action that writes an audit entry against target.
    await client.post(`/api/admin/users/${target.id}/delete`);

    const res = await client.get(`/api/admin/users/${target.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: { id: string; status: string };
      memberships: unknown[];
      auditEvents: Array<{ action: string; actorUserId: string | null }>;
    };
    expect(body.user.id).toBe(target.id);
    expect(body.user.status).toBe('deleted_soft');
    expect(body.memberships).toEqual([]);
    const admin = body.auditEvents.find((e) => e.action === 'admin.user.delete');
    expect(admin).toBeTruthy();
    expect(admin!.actorUserId).toBe(staffId);
  });

  it('404 for unknown id', async () => {
    const { client } = await staffClient();
    const res = await client.get('/api/admin/users/doesnotexist');
    expect(res.status).toBe(404);
  });
});

describe('/api/admin/users/:id PATCH', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('flips status active ↔ disabled and revokes sessions on disable', async () => {
    const { client } = await staffClient();
    const target = await seedUser({ email: 'flip@example.com' });

    // Give the target a live session by logging them in from their own client.
    const tClient = makeClient();
    await tClient.post('/auth/login', { email: target.email, password: target.password });
    expect((await tClient.get('/api/me')).status).toBe(200);

    const disable = await client.patch(`/api/admin/users/${target.id}`, { status: 'disabled' });
    expect(disable.status).toBe(200);
    const body = (await disable.json()) as { user: { status: string } };
    expect(body.user.status).toBe('disabled');

    // Target's session is revoked.
    const sessions = await dbAll<{ revoked_at: number | null }>(
      `SELECT revoked_at FROM session WHERE user_id = ?`, target.id,
    );
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((s) => s.revoked_at !== null)).toBe(true);

    // Re-enable.
    const enable = await client.patch(`/api/admin/users/${target.id}`, { status: 'active' });
    expect(enable.status).toBe(200);
    const body2 = (await enable.json()) as { user: { status: string } };
    expect(body2.user.status).toBe('active');

    // Audit event written.
    const audit = await dbAll<{ action: string }>(
      `SELECT action FROM audit_event WHERE subject_type='user' AND subject_id=? AND action LIKE 'admin.%'`,
      target.id,
    );
    expect(audit.some((a) => a.action === 'admin.user.patch')).toBe(true);
  });

  it('can toggle staff flag', async () => {
    const { client } = await staffClient();
    const target = await seedUser({ email: 'promote@example.com' });

    const res = await client.patch(`/api/admin/users/${target.id}`, { staff: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { staff: boolean } };
    expect(body.user.staff).toBe(true);

    const row = await dbGet<{ staff: number }>(`SELECT staff FROM user WHERE id = ?`, target.id);
    expect(row?.staff).toBe(1);
  });

  it('rejects an attempt to set status on a deleted_soft user', async () => {
    const { client } = await staffClient();
    const target = await seedUser({ email: 'gone@example.com', status: 'deleted_soft' });
    const res = await client.patch(`/api/admin/users/${target.id}`, { status: 'active' });
    expect(res.status).toBe(409);
  });
});

describe('/api/admin/users/:id/resend-verification', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('happy path: sends a fresh verify email, 204', async () => {
    const { client } = await staffClient();
    const target = await seedUser({
      email: 'resend@example.com',
      status: 'pending_verification',
    });

    const res = await client.post(`/api/admin/users/${target.id}/resend-verification`);
    expect(res.status).toBe(204);
    expect(capture.emails.some((e) => e.to === 'resend@example.com')).toBe(true);
    expect(capture.tokenFor('resend@example.com')).toBeTruthy();

    const audit = await dbAll<{ action: string }>(
      `SELECT action FROM audit_event WHERE action = 'admin.user.resend_verification' AND subject_id = ?`,
      target.id,
    );
    expect(audit.length).toBe(1);
  });

  it('409 when user is already active', async () => {
    const { client } = await staffClient();
    const target = await seedUser({ email: 'already-active@example.com', status: 'active' });

    const res = await client.post(`/api/admin/users/${target.id}/resend-verification`);
    expect(res.status).toBe(409);
  });
});

describe('/api/admin/users/:id/delete', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('soft-deletes and revokes sessions', async () => {
    const { client } = await staffClient();
    const target = await seedUser({ email: 'sd@example.com' });

    // Log the target in first.
    const tClient = makeClient();
    await tClient.post('/auth/login', { email: target.email, password: target.password });
    expect((await tClient.get('/api/me')).status).toBe(200);

    const res = await client.post(`/api/admin/users/${target.id}/delete`);
    expect(res.status).toBe(204);

    const row = await dbGet<{ status: string; deleted_at: number | null }>(
      `SELECT status, deleted_at FROM user WHERE id = ?`, target.id,
    );
    expect(row?.status).toBe('deleted_soft');
    expect(row?.deleted_at).not.toBeNull();

    const sessions = await dbAll<{ revoked_at: number | null }>(
      `SELECT revoked_at FROM session WHERE user_id = ?`, target.id,
    );
    expect(sessions.every((s) => s.revoked_at !== null)).toBe(true);

    // Target's GET /api/me is now 401 (session revoked) or 403 (deleted). Either works.
    const me = await tClient.get('/api/me');
    expect([401, 403]).toContain(me.status);
  });
});

// Comp grants — staff sets an Agency/Enterprise plan with no Stripe. Route
// names keep the legacy `enterprise-grant`/`enterprise-revoke` form but accept
// any grantable plan; `plan` defaults to enterprise when omitted.
describe('/api/admin comp plan grants', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  async function seedOrg(): Promise<string> {
    const id = ulid();
    await dbRun(
      `INSERT INTO organization (id, slug, name, created_at) VALUES (?, ?, 'Grant Org', ?)`,
      id,
      `grant-org-${id.toLowerCase()}`,
      Date.now(),
    );
    return id;
  }

  it('grants an agency plan + expiry to a user and audit-logs the plan', async () => {
    const { client } = await staffClient();
    const target = await seedUser({ email: 'grant-agency@example.com', plan: 'free' });
    const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;

    const res = await client.post(`/api/admin/users/${target.id}/enterprise-grant`, {
      plan: 'agency',
      expiresAt,
      note: 'pilot',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plan: string; expiresAt: number };
    expect(body.plan).toBe('agency');
    expect(body.expiresAt).toBe(expiresAt);

    const row = await dbGet<{ plan: string; plan_status: string; plan_expires_at: number | null }>(
      `SELECT plan, plan_status, plan_expires_at FROM user WHERE id = ?`,
      target.id,
    );
    expect(row?.plan).toBe('agency');
    expect(row?.plan_status).toBe('active');
    expect(row?.plan_expires_at).toBe(expiresAt);

    const audit = await dbAll<{ metadata_json: string | null }>(
      `SELECT metadata_json FROM audit_event WHERE action='admin.enterprise_grant' AND subject_id=?`,
      target.id,
    );
    expect(audit.length).toBe(1);
    expect(JSON.parse(audit[0].metadata_json ?? '{}').plan).toBe('agency');
  });

  it('grants an agency plan + expiry to an org', async () => {
    const { client } = await staffClient();
    const orgId = await seedOrg();
    const expiresAt = Date.now() + 14 * 24 * 60 * 60 * 1000;

    const res = await client.post(`/api/admin/orgs/${orgId}/enterprise-grant`, {
      plan: 'agency',
      expiresAt,
    });
    expect(res.status).toBe(200);

    const row = await dbGet<{ plan: string; plan_expires_at: number | null }>(
      `SELECT plan, plan_expires_at FROM organization WHERE id = ?`,
      orgId,
    );
    expect(row?.plan).toBe('agency');
    expect(row?.plan_expires_at).toBe(expiresAt);
  });

  it('defaults to enterprise when plan is omitted (backward-compat)', async () => {
    const { client } = await staffClient();
    const target = await seedUser({ email: 'grant-default@example.com', plan: 'free' });

    const res = await client.post(`/api/admin/users/${target.id}/enterprise-grant`, {});
    expect(res.status).toBe(200);

    const row = await dbGet<{ plan: string; plan_expires_at: number | null }>(
      `SELECT plan, plan_expires_at FROM user WHERE id = ?`,
      target.id,
    );
    expect(row?.plan).toBe('enterprise');
    expect(row?.plan_expires_at).toBeNull(); // no expiry passed
  });

  it('exposes the grant + expiry on the user detail endpoint', async () => {
    const { client } = await staffClient();
    const target = await seedUser({ email: 'grant-detail@example.com', plan: 'free' });
    const expiresAt = Date.now() + 60 * 24 * 60 * 60 * 1000;
    await client.post(`/api/admin/users/${target.id}/enterprise-grant`, { plan: 'agency', expiresAt });

    const res = await client.get(`/api/admin/users/${target.id}`);
    const body = (await res.json()) as {
      user: { plan: string; planStatus: string; planExpiresAt: number | null };
    };
    expect(body.user.plan).toBe('agency');
    expect(body.user.planStatus).toBe('active');
    expect(body.user.planExpiresAt).toBe(expiresAt);
  });

  it('revokes an agency grant back to free', async () => {
    const { client } = await staffClient();
    const target = await seedUser({ email: 'revoke-agency@example.com', plan: 'free' });
    await client.post(`/api/admin/users/${target.id}/enterprise-grant`, {
      plan: 'agency',
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    });

    const res = await client.post(`/api/admin/users/${target.id}/enterprise-revoke`);
    expect(res.status).toBe(200);

    const row = await dbGet<{ plan: string; plan_expires_at: number | null }>(
      `SELECT plan, plan_expires_at FROM user WHERE id = ?`,
      target.id,
    );
    expect(row?.plan).toBe('free');
    expect(row?.plan_expires_at).toBeNull();
  });

  it('rejects revoke when the user is already on free (nothing to revoke)', async () => {
    const { client } = await staffClient();
    const target = await seedUser({ email: 'revoke-free@example.com', plan: 'free' });

    const res = await client.post(`/api/admin/users/${target.id}/enterprise-revoke`);
    expect(res.status).toBe(422);
  });
});
