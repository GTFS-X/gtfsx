// /api/admin impersonation: start + end, cookie handling, audit entries.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { makeClient, type TestClient } from './_client';
import { impersonationKey } from '../admin/impersonation';
import {
  applyMigrations,
  dbAll,
  dbGet,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';

describe('admin impersonation', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('start → GET /api/me returns the target user; impersonator cookie is set; audit lands on both timelines', async () => {
    const staff = await seedUser({ email: 'staff-i@example.com', staff: true });
    const target = await seedUser({ email: 'target-i@example.com' });
    const client = makeClient();
    await client.post('/auth/login', { email: staff.email, password: staff.password });

    // Sanity: currently the staff user.
    const me0 = await client.get('/api/me');
    const m0 = (await me0.json()) as { user: { id: string; impersonating: boolean } };
    expect(m0.user.id).toBe(staff.id);
    expect(m0.user.impersonating).toBe(false);

    const impRes = await client.post(`/api/admin/users/${target.id}/impersonate`);
    expect(impRes.status).toBe(200);

    // Set-Cookie should contain BOTH a new session cookie and the impersonator cookie.
    const setCookies = impRes.headers.getSetCookie?.() ?? [];
    const joined = setCookies.join('\n');
    expect(joined).toMatch(/gb_session=/);
    expect(joined).toMatch(/gb_impersonator=/);

    // Inject the impersonator cookie manually onto the client (the client
    // helper only tracks the first Set-Cookie; for impersonation tests we
    // reconstruct both cookies for subsequent requests).
    const sessionMatch = joined.match(/gb_session=([^;\s]+)/);
    const impMatch = joined.match(/gb_impersonator=([^;\s]+)/);
    expect(sessionMatch).toBeTruthy();
    expect(impMatch).toBeTruthy();
    client.setCookie(`gb_session=${sessionMatch![1]}; gb_impersonator=${impMatch![1]}`);

    // /api/me now returns the target.
    const me1 = await client.get('/api/me');
    const m1 = (await me1.json()) as { user: { id: string; email: string; impersonating: boolean } };
    expect(m1.user.id).toBe(target.id);
    expect(m1.user.email).toBe(target.email);
    // E2E A5: the banner is driven by this server-side flag, not the hint.
    expect(m1.user.impersonating).toBe(true);

    // Audit landed on both timelines.
    const auditStaff = await dbAll<{ action: string; actor_user_id: string | null }>(
      `SELECT action, actor_user_id FROM audit_event
         WHERE action = 'admin.impersonate.start' AND subject_type = 'user' AND subject_id = ?`,
      staff.id,
    );
    const auditTarget = await dbAll<{ action: string; actor_user_id: string | null }>(
      `SELECT action, actor_user_id FROM audit_event
         WHERE action = 'admin.impersonate.start' AND subject_type = 'user' AND subject_id = ?`,
      target.id,
    );
    expect(auditStaff.length).toBe(1);
    expect(auditStaff[0].actor_user_id).toBe(staff.id);
    expect(auditTarget.length).toBe(1);
    expect(auditTarget[0].actor_user_id).toBe(staff.id);
  });

  it('end-impersonation restores the staff session + clears impersonator cookie; audit on both timelines', async () => {
    const staff = await seedUser({ email: 'staff-e@example.com', staff: true });
    const target = await seedUser({ email: 'target-e@example.com' });
    const client = makeClient();
    await client.post('/auth/login', { email: staff.email, password: staff.password });
    const impRes = await client.post(`/api/admin/users/${target.id}/impersonate`);
    expect(impRes.status).toBe(200);

    const setCookies = impRes.headers.getSetCookie?.() ?? [];
    const joined = setCookies.join('\n');
    const sessionMatch = joined.match(/gb_session=([^;\s]+)/);
    const impMatch = joined.match(/gb_impersonator=([^;\s]+)/);
    client.setCookie(`gb_session=${sessionMatch![1]}; gb_impersonator=${impMatch![1]}`);

    // Confirm impersonation is active.
    const me1 = await client.get('/api/me');
    const m1 = (await me1.json()) as { user: { id: string } };
    expect(m1.user.id).toBe(target.id);

    // End impersonation.
    const endRes = await client.post('/api/admin/end-impersonation');
    expect(endRes.status).toBe(204);

    // Pull out new session and confirm impersonator cookie is cleared.
    const endCookies = endRes.headers.getSetCookie?.() ?? [];
    const endJoined = endCookies.join('\n');
    expect(endJoined).toMatch(/gb_session=[^;\s]+/);
    expect(endJoined).toMatch(/gb_impersonator=;/); // cleared

    const newSession = endJoined.match(/gb_session=([^;\s]+)/)![1];
    // The client must NOT send the cleared impersonator cookie.
    client.setCookie(`gb_session=${newSession}`);

    const me2 = await client.get('/api/me');
    const m2 = (await me2.json()) as { user: { id: string; staff: boolean; impersonating: boolean } };
    expect(m2.user.id).toBe(staff.id);
    expect(m2.user.staff).toBe(true);
    expect(m2.user.impersonating).toBe(false);

    const auditStaff = await dbAll<{ action: string }>(
      `SELECT action FROM audit_event
         WHERE action = 'admin.impersonate.end' AND subject_type = 'user' AND subject_id = ?`,
      staff.id,
    );
    const auditTarget = await dbAll<{ action: string }>(
      `SELECT action FROM audit_event
         WHERE action = 'admin.impersonate.end' AND subject_type = 'user' AND subject_id = ?`,
      target.id,
    );
    expect(auditStaff.length).toBe(1);
    expect(auditTarget.length).toBe(1);
  });

  it('end-impersonation without a gb_impersonator cookie → 422', async () => {
    const staff = await seedUser({ email: 'staff-no-cookie@example.com', staff: true });
    const client = makeClient();
    await client.post('/auth/login', { email: staff.email, password: staff.password });

    const res = await client.post('/api/admin/end-impersonation');
    expect(res.status).toBe(422);
  });

  it('cannot impersonate yourself', async () => {
    const staff = await seedUser({ email: 'selfimp@example.com', staff: true });
    const client = makeClient();
    await client.post('/auth/login', { email: staff.email, password: staff.password });

    const res = await client.post(`/api/admin/users/${staff.id}/impersonate`);
    expect(res.status).toBe(409);
  });

  it('cannot impersonate a non-active user', async () => {
    const staff = await seedUser({ email: 'staff-inactive@example.com', staff: true });
    const target = await seedUser({ email: 'inactive@example.com', status: 'disabled' });
    const client = makeClient();
    await client.post('/auth/login', { email: staff.email, password: staff.password });

    const res = await client.post(`/api/admin/users/${target.id}/impersonate`);
    expect(res.status).toBe(409);
  });

  // ─── Regression: the staff identity is bound server-side ────────────────
  // end-impersonation must restore ONLY the staff user recorded when the
  // impersonated session was created; a client-held gb_impersonator value is
  // never trusted as an identity.

  async function loginAs(email: string, password: string): Promise<TestClient> {
    const c = makeClient();
    const res = await c.post('/auth/login', { email, password });
    expect(res.status).toBe(200);
    return c;
  }

  function cookieValue(res: Response, name: string): string | null {
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const m = sc.match(new RegExp(`^${name}=([^;]*)`));
      if (m) return m[1];
    }
    return null;
  }

  it('a non-staff session presenting gb_impersonator=<staffId> gets 4xx and no session', async () => {
    const staff = await seedUser({ email: 'staff-forge@example.com', staff: true });
    const plain = await seedUser({ email: 'plain-forge@example.com' });
    const c = await loginAs(plain.email, plain.password);
    const own = c.cookie!;

    const res = await c.post('/api/admin/end-impersonation', undefined, {
      headers: { Cookie: `${own}; gb_impersonator=${staff.id}` },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(cookieValue(res, 'gb_session')).toBeFalsy();

    // No new session was minted for the staff user, and the caller is
    // still themselves with no admin access.
    const staffSessions = await dbGet<{ n: number }>(
      `SELECT COUNT(*) AS n FROM session WHERE user_id = ?`,
      staff.id,
    );
    expect(staffSessions?.n).toBe(0);
    const me = (await (await c.get('/api/me')).json()) as { user: { id: string; impersonating: boolean } };
    expect(me.user.id).toBe(plain.id);
    expect(me.user.impersonating).toBe(false);
    expect((await c.get('/api/admin/users')).status).toBe(404);
  });

  it('end-impersonation restores the bound staff user, not the cookie value', async () => {
    const staffA = await seedUser({ email: 'staff-a@example.com', staff: true });
    const staffB = await seedUser({ email: 'staff-b@example.com', staff: true });
    const target = await seedUser({ email: 'target-ab@example.com' });
    const c = await loginAs(staffA.email, staffA.password);
    const imp = await c.post(`/api/admin/users/${target.id}/impersonate`);
    expect(imp.status).toBe(200);
    const tok = cookieValue(imp, 'gb_session')!;

    // Tamper the hint cookie to name a different staff user.
    c.setCookie(`gb_session=${tok}; gb_impersonator=${staffB.id}`);
    const end = await c.post('/api/admin/end-impersonation');
    expect(end.status).toBe(204);
    const restored = makeClient();
    restored.setCookie(`gb_session=${cookieValue(end, 'gb_session')}`);
    const me = (await (await restored.get('/api/me')).json()) as { user: { id: string } };
    expect(me.user.id).toBe(staffA.id);

    // The binding is single-use: replaying against the (now revoked)
    // impersonated session does nothing.
    expect(await env.KV.get(impersonationKey((await dbGet<{ id: string }>(
      `SELECT id FROM session WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
      target.id,
    ))!.id))).toBeNull();
  });

  it('logout during impersonation clears the binding and the gb_impersonator cookie', async () => {
    const staff = await seedUser({ email: 'staff-lo@example.com', staff: true });
    const target = await seedUser({ email: 'target-lo@example.com' });
    const c = await loginAs(staff.email, staff.password);
    const imp = await c.post(`/api/admin/users/${target.id}/impersonate`);
    expect(imp.status).toBe(200);
    const sess = await dbGet<{ id: string }>(
      `SELECT id FROM session WHERE user_id = ? AND revoked_at IS NULL`,
      target.id,
    );
    expect(await env.KV.get(impersonationKey(sess!.id))).not.toBeNull();

    c.setCookie(`gb_session=${cookieValue(imp, 'gb_session')}; gb_impersonator=${staff.id}`);
    const out = await c.post('/auth/logout');
    expect(out.status).toBe(204);
    expect(cookieValue(out, 'gb_impersonator')).toBe('');
    expect(await env.KV.get(impersonationKey(sess!.id))).toBeNull();
  });

  it('logout-all during impersonation clears the binding and the gb_impersonator cookie', async () => {
    const staff = await seedUser({ email: 'staff-la@example.com', staff: true });
    const target = await seedUser({ email: 'target-la@example.com' });
    const c = await loginAs(staff.email, staff.password);
    const imp = await c.post(`/api/admin/users/${target.id}/impersonate`);
    expect(imp.status).toBe(200);
    const sess = await dbGet<{ id: string }>(
      `SELECT id FROM session WHERE user_id = ? AND revoked_at IS NULL`,
      target.id,
    );
    expect(await env.KV.get(impersonationKey(sess!.id))).not.toBeNull();

    c.setCookie(`gb_session=${cookieValue(imp, 'gb_session')}; gb_impersonator=${staff.id}`);
    const out = await c.post('/auth/logout-all');
    expect(out.status).toBe(204);
    expect(cookieValue(out, 'gb_impersonator')).toBe('');
    expect(await env.KV.get(impersonationKey(sess!.id))).toBeNull();
  });
});
