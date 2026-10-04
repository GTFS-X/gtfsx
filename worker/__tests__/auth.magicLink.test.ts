// Magic-link login: request (no-enumerate), consume, expired token,
// pending-verification users become active on consume.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { makeClient, locationPath, locationQuery } from './_client';
import {
  applyMigrations,
  dbGet,
  dbRun,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';

describe('auth /magic-link', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('request → email captured → consume establishes a session', async () => {
    const user = await seedUser({ email: 'magic@example.com' });
    const client = makeClient();

    const req = await client.post('/auth/magic-link/request', { email: user.email });
    expect(req.status).toBe(204);
    expect(capture.emails).toHaveLength(1);
    const token = capture.tokenFor(user.email);
    expect(token).toBeTruthy();

    const link = capture.linkFor(user.email);
    expect(link).toBeTruthy();
    const consume = await client.get(new URL(link!).pathname + new URL(link!).search);
    expect(consume.status).toBe(302);
    expect(locationPath(consume)).toBe('/');
    expect(locationQuery(consume, 'welcome')).toBe('1');
    expect(client.cookie).toMatch(/^gb_session=/);

    const meRes = await client.get('/api/me');
    const me = await client.json<{ user: { id: string } }>(meRes);
    expect(me.user.id).toBe(user.id);
  });

  it('request for unknown email returns 204 (no enumeration) and sends no email', async () => {
    const client = makeClient();
    const res = await client.post('/auth/magic-link/request', { email: 'unknown@example.com' });
    expect(res.status).toBe(204);
    expect(capture.emails).toHaveLength(0);
  });

  // E2E A8: soft-deleted accounts get the deletion copy, not "invalid link".
  it('request for a soft-deleted account sends a deletion notice (no link) and still returns 204', async () => {
    const user = await seedUser({ email: 'gone-magic@example.com' });
    await dbRun(`UPDATE user SET status = 'deleted_soft', deleted_at = ? WHERE id = ?`, Date.now(), user.id);
    const res = await makeClient().post('/auth/magic-link/request', { email: user.email });
    expect(res.status).toBe(204);
    expect(capture.emails).toHaveLength(1);
    expect(capture.emails[0].subject).toBe('Your GTFS·X account is scheduled for deletion');
    expect(capture.emails[0].text).toMatch(/permanently removed 30 days after deletion/);
    expect(capture.linkFor(user.email) ?? '').not.toContain('/auth/magic-link/consume');
    const tokens = await dbGet<{ n: number }>(`SELECT COUNT(*) AS n FROM auth_token WHERE kind = 'magic_link'`);
    expect(tokens?.n).toBe(0);
  });

  it('consuming a link issued before the account was deleted redirects to account_deleted', async () => {
    const user = await seedUser({ email: 'gone-later@example.com' });
    const client = makeClient();
    await client.post('/auth/magic-link/request', { email: user.email });
    const token = capture.tokenFor(user.email);
    expect(token).toBeTruthy();
    await dbRun(`UPDATE user SET status = 'deleted_soft', deleted_at = ? WHERE id = ?`, Date.now(), user.id);

    const consume = await client.get(`/auth/magic-link/consume?token=${token}`);
    expect(consume.status).toBe(302);
    expect(locationPath(consume)).toBe('/login');
    expect(locationQuery(consume, 'error')).toBe('account_deleted');
    expect(client.cookie).toBeNull();
  });

  it('consume with an expired token redirects to /login?error=magic_link_invalid', async () => {
    const user = await seedUser({ email: 'expire-magic@example.com' });
    const client = makeClient();
    await client.post('/auth/magic-link/request', { email: user.email });
    const token = capture.tokenFor(user.email);
    expect(token).toBeTruthy();
    await dbRun(`UPDATE auth_token SET expires_at = ? WHERE kind = 'magic_link'`, 1);

    const consume = await client.get(`/auth/magic-link/consume?token=${token}`);
    expect(consume.status).toBe(302);
    expect(locationPath(consume)).toBe('/login');
    expect(locationQuery(consume, 'error')).toBe('magic_link_invalid');
  });

  it('consume with a consumed token redirects to /login?error=magic_link_invalid', async () => {
    const user = await seedUser({ email: 'consumed-magic@example.com' });
    const client = makeClient();
    await client.post('/auth/magic-link/request', { email: user.email });
    const token = capture.tokenFor(user.email);
    expect(token).toBeTruthy();

    const first = await client.get(`/auth/magic-link/consume?token=${token}`);
    expect(locationQuery(first, 'welcome')).toBe('1');

    const fresh = makeClient();
    const second = await fresh.get(`/auth/magic-link/consume?token=${token}`);
    expect(locationPath(second)).toBe('/login');
    expect(locationQuery(second, 'error')).toBe('magic_link_invalid');
  });

  it('consuming a magic link for a pending_verification user flips them to active', async () => {
    const user = await seedUser({ email: 'pending-magic@example.com', status: 'pending_verification' });
    const client = makeClient();
    await client.post('/auth/magic-link/request', { email: user.email });
    const token = capture.tokenFor(user.email);
    expect(token).toBeTruthy();

    const before = await dbGet<{ status: string }>(`SELECT status FROM user WHERE id = ?`, user.id);
    expect(before?.status).toBe('pending_verification');

    const consume = await client.get(`/auth/magic-link/consume?token=${token}`);
    expect(consume.status).toBe(302);
    expect(locationQuery(consume, 'welcome')).toBe('1');

    const after = await dbGet<{ status: string }>(`SELECT status FROM user WHERE id = ?`, user.id);
    expect(after?.status).toBe('active');
  });

  it('concurrent consumes of one link mint exactly one session (W1-08)', async () => {
    // The race is timing-dependent, so repeat it a few times with fresh links.
    for (let round = 0; round < 3; round++) {
      const user = await seedUser({ email: `race-magic-${round}@example.com` });
      await makeClient().post('/auth/magic-link/request', { email: user.email });
      const token = capture.tokenFor(user.email);
      expect(token).toBeTruthy();

      const results = await Promise.all(
        [0, 1, 2].map(() => makeClient().get(`/auth/magic-link/consume?token=${token}`)),
      );
      const signedIn = results.filter((r) => (r.headers.get('Set-Cookie') ?? '').startsWith('gb_session=')).length;
      expect(signedIn).toBe(1);
      const sessions = await dbGet<{ n: number }>(`SELECT COUNT(*) AS n FROM session WHERE user_id = ?`, user.id);
      expect(sessions?.n).toBe(1);
    }
  });
});
