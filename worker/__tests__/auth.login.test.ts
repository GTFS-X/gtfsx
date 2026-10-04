// Login: credentials path, failure modes, timing-equalization, status gates.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { ApiError, makeClient } from './_client';
import {
  applyMigrations,
  dbRun,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';

describe('auth /login', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('signup + verify → logout → login with password returns the user and a valid session', async () => {
    const user = await seedUser({ email: 'login@example.com', password: 'correct-horse-battery' });

    const client = makeClient();
    const loginRes = await client.post('/auth/login', {
      email: user.email,
      password: user.password,
    });
    const login = await client.json<{ user: { email: string; status: string } }>(loginRes);
    expect(login.user.email).toBe(user.email);
    expect(login.user.status).toBe('active');
    expect(client.cookie).toMatch(/^gb_session=/);

    // /api/me succeeds on the session cookie.
    const me = await client.json<{ user: { id: string } }>(await client.get('/api/me'));
    expect(me.user.id).toBe(user.id);

    // Logout then login again (fresh client mimics a re-login from another browser).
    const logoutRes = await client.post('/auth/logout');
    expect(logoutRes.status).toBe(204);

    const c2 = makeClient();
    const loginRes2 = await c2.post('/auth/login', { email: user.email, password: user.password });
    expect(loginRes2.status).toBe(200);
    expect(c2.cookie).toMatch(/^gb_session=/);
  });

  it('wrong password returns 401 invalid_credentials', async () => {
    const user = await seedUser({ email: 'wrongpw@example.com', password: 'correct-horse-battery' });
    const client = makeClient();
    const res = await client.post('/auth/login', {
      email: user.email,
      password: 'nope-nope-nope',
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_credentials');
  });

  it('unknown email returns the SAME 401 invalid_credentials (no enumeration)', async () => {
    const client = makeClient();
    const res = await client.post('/auth/login', {
      email: 'nobody@example.com',
      password: 'whatever-at-all',
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_credentials');
  });

  it('timing of wrong-password vs unknown-email is comparable (enumeration mitigation)', async () => {
    await seedUser({ email: 'time1@example.com', password: 'correct-horse-battery' });

    const c1 = makeClient();
    const s1 = Date.now();
    await c1.post('/auth/login', { email: 'time1@example.com', password: 'bad-bad-bad' });
    const tWrong = Date.now() - s1;

    const c2 = makeClient();
    const s2 = Date.now();
    await c2.post('/auth/login', { email: 'nobody-here@example.com', password: 'bad-bad-bad' });
    const tUnknown = Date.now() - s2;

    // Both must go through verifyPassword against either the real hash or the
    // cached dummy hash. Because dummyHash is lazily generated ONCE, the first
    // call in a worker isolate computes a fresh PBKDF2 hash. At 100k
    // iterations (workerd's ceiling) a single verify is ~15-30ms in
    // miniflare, so the floor here is generous but not load-bearing — the
    // ratio check below is what actually proves no timing side-channel.
    expect(tWrong).toBeGreaterThan(10);
    expect(tUnknown).toBeGreaterThan(10);
    const ratio = Math.max(tWrong, tUnknown) / Math.max(1, Math.min(tWrong, tUnknown));
    // NOTE: on the first "unknown" call dummyHash() is computed, so there's
    // an inherent first-call penalty; a 3x cap is generous but still proves
    // the two are in the same ballpark rather than a bare string-compare fast-path.
    expect(ratio).toBeLessThan(3);
  });

  it('pending_verification login is blocked with email_unverified + echoed email', async () => {
    const user = await seedUser({
      email: 'pending@example.com',
      password: 'correct-horse-battery',
      status: 'pending_verification',
    });

    const client = makeClient();
    const res = await client.post('/auth/login', { email: user.email, password: user.password });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; email?: string };
    expect(body.error).toBe('email_unverified');
    expect(body.email).toBe(user.email);
    expect(client.cookie).toBeNull();
  });

  it('disabled user login returns 403 forbidden', async () => {
    const user = await seedUser({
      email: 'disabled@example.com',
      password: 'correct-horse-battery',
      status: 'disabled',
    });

    const client = makeClient();
    const res = await client.post('/auth/login', { email: user.email, password: user.password });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('forbidden');
  });

  // E2E A8: a soft-deleted account gets the same "scheduled for deletion"
  // copy as Google, but only after the correct password.
  it('soft-deleted user: correct password → 403 account_deleted; wrong password → 401', async () => {
    const user = await seedUser({ email: 'gone-pw@example.com', password: 'correct-horse-battery' });
    await dbRun(`UPDATE user SET status = 'deleted_soft', deleted_at = ? WHERE id = ?`, Date.now(), user.id);

    const wrong = await makeClient().post('/auth/login', { email: user.email, password: 'not-the-password' });
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as { reason?: string }).reason).toBeUndefined();

    const client = makeClient();
    const res = await client.post('/auth/login', { email: user.email, password: user.password });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; reason: string; message: string };
    expect(body.reason).toBe('account_deleted');
    expect(body.message).toMatch(/scheduled for deletion.*hello@gtfsx\.com within 30 days/);
    expect(client.cookie).toBeNull();
  });

  it('propagates ApiError to json() for non-2xx responses (client sanity check)', async () => {
    const client = makeClient();
    const res = await client.post('/auth/login', { email: 'x@x.com', password: 'whatever' });
    await expect(client.json(res)).rejects.toBeInstanceOf(ApiError);
  });
});
