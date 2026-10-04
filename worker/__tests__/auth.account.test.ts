// /api/me account-management routes: display-name update, change password,
// change email (with duplicate collision), delete account.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulidx';
import { makeClient } from './_client';
import {
  applyMigrations,
  dbGet,
  dbRun,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';

describe('/api/me account management', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('PATCH /api/me updates display name', async () => {
    const user = await seedUser({ email: 'patch@example.com', displayName: 'Old Name' });
    const client = makeClient();
    await client.post('/auth/login', { email: user.email, password: user.password });

    const res = await client.patch('/api/me', { displayName: 'New Name' });
    const body = await client.json<{ user: { displayName: string } }>(res);
    expect(body.user.displayName).toBe('New Name');

    const row = await dbGet<{ display_name: string }>(`SELECT display_name FROM user WHERE id = ?`, user.id);
    expect(row?.display_name).toBe('New Name');
  });

  it('change-password: wrong current returns 401; correct revokes other sessions but keeps this one', async () => {
    const user = await seedUser({ email: 'chpw@example.com', password: 'original-hunter2' });

    // Two sessions: c1 performs the change, c2 should be revoked.
    const c1 = makeClient();
    await c1.post('/auth/login', { email: user.email, password: user.password });
    const c2 = makeClient();
    await c2.post('/auth/login', { email: user.email, password: user.password });

    const bad = await c1.post('/api/me/change-password', {
      currentPassword: 'wrong-wrong-wrong',
      newPassword: 'brand-new-passw0rd',
    });
    expect(bad.status).toBe(401);

    const ok = await c1.post('/api/me/change-password', {
      currentPassword: 'original-hunter2',
      newPassword: 'brand-new-passw0rd',
    });
    expect(ok.status).toBe(204);

    // c1 still works; c2 is revoked.
    expect((await c1.get('/api/me')).status).toBe(200);
    expect((await c2.get('/api/me')).status).toBe(401);
  });

  it('change-email: request → confirm → user.email updated', async () => {
    const user = await seedUser({ email: 'old@example.com' });
    const client = makeClient();
    await client.post('/auth/login', { email: user.email, password: user.password });

    const req = await client.post('/api/me/change-email', { newEmail: 'new@example.com', currentPassword: user.password });
    expect(req.status).toBe(204);

    // The verify email is sent to the NEW address.
    expect(capture.emails.some((e) => e.to === 'new@example.com')).toBe(true);
    const token = capture.tokenFor('new@example.com');
    expect(token).toBeTruthy();

    const confirm = await client.post('/api/me/change-email/confirm', { token });
    expect(confirm.status).toBe(204);

    const row = await dbGet<{ email: string }>(`SELECT email FROM user WHERE id = ?`, user.id);
    expect(row?.email).toBe('new@example.com');
  });

  it('change-email confirm notifies the previous address (W1-06)', async () => {
    const user = await seedUser({ email: 'was-here@example.com' });
    const client = makeClient();
    await client.post('/auth/login', { email: user.email, password: user.password });
    await client.post('/api/me/change-email', { newEmail: 'now-here@example.com', currentPassword: user.password });
    const token = capture.tokenFor('now-here@example.com');

    // Nothing goes to the old address until the change is confirmed.
    expect(capture.emails.some((e) => e.to === 'was-here@example.com')).toBe(false);

    const confirm = await client.post('/api/me/change-email/confirm', { token });
    expect(confirm.status).toBe(204);
    const notice = capture.emails.find((e) => e.to === 'was-here@example.com');
    expect(notice).toBeTruthy();
    expect(notice!.subject).toMatch(/email .* was changed/i);
    expect(notice!.text).toContain('now-here@example.com');
  });

  it('change-email confirm still succeeds when the notice fails to send', async () => {
    const user = await seedUser({ email: 'flaky-old@example.com' });
    const client = makeClient();
    await client.post('/auth/login', { email: user.email, password: user.password });
    await client.post('/api/me/change-email', { newEmail: 'flaky-new@example.com', currentPassword: user.password });
    const token = capture.tokenFor('flaky-new@example.com');

    capture.simulateSendFailure(500, '{"error":"boom"}');
    const confirm = await client.post('/api/me/change-email/confirm', { token });
    expect(confirm.status).toBe(204);
    const row = await dbGet<{ email: string }>(`SELECT email FROM user WHERE id = ?`, user.id);
    expect(row?.email).toBe('flaky-new@example.com');
  });

  it('change-email collision with another user returns 409', async () => {
    await seedUser({ email: 'taken@example.com' });
    const user = await seedUser({ email: 'wants-taken@example.com' });

    const client = makeClient();
    await client.post('/auth/login', { email: user.email, password: user.password });

    const res = await client.post('/api/me/change-email', { newEmail: 'taken@example.com', currentPassword: user.password });
    expect(res.status).toBe(409);
  });

  it('DELETE /api/me with correct password soft-deletes and revokes sessions', async () => {
    const user = await seedUser({ email: 'goodbye@example.com', password: 'original-hunter2' });
    const client = makeClient();
    await client.post('/auth/login', { email: user.email, password: user.password });

    // Wrong password is rejected.
    const bad = await client.delete('/api/me', { password: 'wrong-wrong-wrong' });
    expect(bad.status).toBe(401);
    expect((await client.get('/api/me')).status).toBe(200);

    const ok = await client.delete('/api/me', { password: 'original-hunter2' });
    expect(ok.status).toBe(204);

    // Session and user are gone.
    expect((await client.get('/api/me')).status).toBe(401);
    const row = await dbGet<{ status: string; deleted_at: number | null }>(
      `SELECT status, deleted_at FROM user WHERE id = ?`,
      user.id,
    );
    expect(row?.status).toBe('deleted_soft');
    expect(row?.deleted_at).not.toBeNull();
  });

  it('DELETE /api/me without password returns 422 (password confirmation required)', async () => {
    const user = await seedUser({ email: 'nopwdelete@example.com' });
    const client = makeClient();
    await client.post('/auth/login', { email: user.email, password: user.password });

    const res = await client.delete('/api/me', {});
    expect(res.status).toBe(422);
  });
});

describe('/api/me account security (W1-03, W1-06, W1-12, W1-15, W2-07)', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    await dbRun(`DELETE FROM subscription`);
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  async function signedIn(email: string) {
    const user = await seedUser({ email, password: 'original-hunter2' });
    const client = makeClient();
    await client.post('/auth/login', { email: user.email, password: user.password });
    return { user, client };
  }

  it('change-email requires the current password when one exists', async () => {
    const { client } = await signedIn('stepup@example.com');
    const missing = await client.post('/api/me/change-email', { newEmail: 'stepup-new@example.com' });
    expect(missing.status).toBe(422);
    const wrong = await client.post('/api/me/change-email', {
      newEmail: 'stepup-new@example.com',
      currentPassword: 'wrong-wrong-wrong',
    });
    expect(wrong.status).toBe(401);
    expect(capture.emails).toHaveLength(0);
  });

  it('change-email confirm revokes the other sessions and keeps this one', async () => {
    const { user, client } = await signedIn('moving@example.com');
    const other = makeClient();
    await other.post('/auth/login', { email: user.email, password: user.password });

    await client.post('/api/me/change-email', { newEmail: 'moved@example.com', currentPassword: user.password });
    const token = capture.tokenFor('moved@example.com');
    const confirm = await client.post('/api/me/change-email/confirm', { token });
    expect(confirm.status).toBe(204);

    expect((await client.get('/api/me')).status).toBe(200);
    expect((await other.get('/api/me')).status).toBe(401);
  });

  it('change-email to an address held by a soft-deleted account → 409, not 500', async () => {
    await seedUser({ email: 'gone@example.com', status: 'deleted_soft' });
    const { user, client } = await signedIn('wants-gone@example.com');
    const res = await client.post('/api/me/change-email', { newEmail: 'gone@example.com', currentPassword: user.password });
    expect(res.status).toBe(409);
  });

  it('signup with an email held by a soft-deleted account → 409 account_deleted, not 500', async () => {
    await seedUser({ email: 'deleted-signup@example.com', status: 'deleted_soft' });
    const res = await makeClient().post('/auth/signup', {
      email: 'deleted-signup@example.com',
      displayName: 'Again',
      password: 'another-hunter2',
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.reason).toBe('account_deleted');
  });

  it('change-password invalidates an outstanding password-reset link', async () => {
    const { user, client } = await signedIn('reset-then-change@example.com');
    await makeClient().post('/auth/password-reset/request', { email: user.email });
    const resetToken = capture.tokenFor(user.email);
    expect(resetToken).toBeTruthy();

    const changed = await client.post('/api/me/change-password', {
      currentPassword: user.password,
      newPassword: 'brand-new-passw0rd',
    });
    expect(changed.status).toBe(204);

    const confirm = await makeClient().post('/auth/password-reset/confirm', {
      token: resetToken,
      password: 'attacker-chosen-pw',
    });
    expect(confirm.status).toBe(422);
  });

  it('DELETE /api/me is blocked while a sole-member org has a live subscription', async () => {
    const { user, client } = await signedIn('paying-owner@example.com');
    const orgId = ulid();
    const now = Date.now();
    await dbRun(
      `INSERT INTO organization (id, slug, name, plan, plan_status, created_at) VALUES (?, ?, 'Paying Org', 'agency', 'active', ?)`,
      orgId, `paying-${orgId.toLowerCase()}`, now,
    );
    await dbRun(
      `INSERT INTO organization_membership (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)`,
      orgId, user.id, now,
    );
    const subRowId = ulid();
    await dbRun(
      `INSERT INTO subscription
         (id, owner_type, owner_id, stripe_subscription_id, stripe_customer_id, stripe_price_id,
          plan, status, current_period_start, current_period_end, created_at, updated_at)
       VALUES (?, 'org', ?, ?, 'cus_x', 'price_x', 'agency', 'active', ?, ?, ?, ?)`,
      subRowId, orgId, `sub_${subRowId}`, now, now + 1000, now, now,
    );

    const blocked = await client.delete('/api/me', { password: user.password });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { reason: string }).reason).toBe('active_subscription');
    expect((await dbGet<{ status: string }>(`SELECT status FROM user WHERE id = ?`, user.id))?.status).toBe('active');

    await dbRun(`UPDATE subscription SET status = 'canceled' WHERE id = ?`, subRowId);
    const ok = await client.delete('/api/me', { password: user.password });
    expect(ok.status).toBe(204);
  });

  it('DELETE /api/me cancels pending scheduled publishes on personal projects', async () => {
    const { user, client } = await signedIn('scheduler@example.com');
    const now = Date.now();
    const projectId = ulid();
    const snapshotId = ulid();
    await dbRun(
      `INSERT INTO feed_project (id, slug, name, owner_type, owner_id, created_at, updated_at)
       VALUES (?, ?, 'Sched', 'user', ?, ?, ?)`,
      projectId, `sched-${projectId.toLowerCase()}`, user.id, now, now,
    );
    await dbRun(
      `INSERT INTO feed_snapshot (id, project_id, state_r2_key, zip_r2_key, zip_size, summary_json, created_at)
       VALUES (?, ?, 's', 'z', 10, '{}', ?)`,
      snapshotId, projectId, now,
    );
    const scheduleId = ulid();
    await dbRun(
      `INSERT INTO scheduled_publish (id, project_id, snapshot_id, scheduled_for, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
      scheduleId, projectId, snapshotId, now + 3600_000, now,
    );

    const res = await client.delete('/api/me', { password: user.password });
    expect(res.status).toBe(204);
    const row = await dbGet<{ status: string }>(`SELECT status FROM scheduled_publish WHERE id = ?`, scheduleId);
    expect(row?.status).toBe('cancelled');
  });
});
