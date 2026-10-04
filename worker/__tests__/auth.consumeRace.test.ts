// Single-use tokens are claimed with a guarded UPDATE BEFORE any side effect
// (W1-07, W1-08). Each test lets a competing request win the claim between the
// handler's validity check and its own claim (see _race.ts), then asserts the
// loser changes nothing. The sequential tests elsewhere cannot catch a
// check-then-act race: resolveAuthToken already rejects a consumed token.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { makeClient, type TestClient } from './_client';
import { fetchWithEnv, racingEnv } from './_race';
import {
  applyMigrations,
  dbGet,
  env,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';

const AUTH_TOKEN_CLAIM = /UPDATE auth_token SET consumed_at/;

describe('single-use auth tokens lose cleanly to a competing claim', () => {
  let capture: EmailCapture;
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });
  afterEach(() => capture.restore());

  it('/auth/verify: the loser mints no session and does not activate the account', async () => {
    const email = 'race-verify@example.com';
    const signup = await makeClient().post('/auth/signup', { email, password: 'hunter2-hunter2', displayName: 'Racer' });
    expect(signup.status).toBe(200);
    const token = capture.tokenFor(email);
    expect(token).toBeTruthy();

    const race = racingEnv(AUTH_TOKEN_CLAIM);
    const res = await fetchWithEnv(makeClient(), race.env, 'GET', `/auth/verify?token=${token}`);
    expect(race.fired()).toBe(true);
    expect(res.headers.get('Set-Cookie') ?? '').not.toContain('gb_session=');
    expect(res.headers.get('Location') ?? '').toContain('already_verified');
    const user = await dbGet<{ id: string; status: string }>(`SELECT id, status FROM user WHERE email = ?`, email);
    expect(user?.status).toBe('pending_verification');
    expect((await dbGet<{ n: number }>(`SELECT COUNT(*) AS n FROM session WHERE user_id = ?`, user!.id))?.n).toBe(0);
  });

  it('/auth/password-reset/confirm: the loser is rejected and the password is unchanged', async () => {
    const user = await seedUser({ email: 'race-reset@example.com', password: 'original-hunter2' });
    await makeClient().post('/auth/password-reset/request', { email: user.email });
    const token = capture.tokenFor(user.email);
    expect(token).toBeTruthy();
    const before = await dbGet<{ password_hash: string }>(
      `SELECT password_hash FROM credential WHERE user_id = ? AND kind = 'password'`, user.id,
    );

    const race = racingEnv(AUTH_TOKEN_CLAIM);
    const res = await fetchWithEnv(makeClient(), race.env, 'POST', '/auth/password-reset/confirm', {
      token, password: 'attacker-passw0rd',
    });
    expect(race.fired()).toBe(true);
    expect(res.status).toBe(422);
    const after = await dbGet<{ password_hash: string }>(
      `SELECT password_hash FROM credential WHERE user_id = ? AND kind = 'password'`, user.id,
    );
    expect(after?.password_hash).toBe(before?.password_hash);
    expect((await makeClient().post('/auth/login', { email: user.email, password: 'original-hunter2' })).status).toBe(200);
  });

  it('/auth/magic-link/consume: the loser mints no session', async () => {
    const user = await seedUser({ email: 'race-magic@example.com' });
    await makeClient().post('/auth/magic-link/request', { email: user.email });
    const token = capture.tokenFor(user.email);
    expect(token).toBeTruthy();

    const race = racingEnv(AUTH_TOKEN_CLAIM);
    const res = await fetchWithEnv(makeClient(), race.env, 'GET', `/auth/magic-link/consume?token=${token}`);
    expect(race.fired()).toBe(true);
    expect(res.headers.get('Set-Cookie') ?? '').not.toContain('gb_session=');
    expect((await dbGet<{ n: number }>(`SELECT COUNT(*) AS n FROM session WHERE user_id = ?`, user.id))?.n).toBe(0);
  });

  it('/api/me/change-email/confirm: the loser is rejected and the email is unchanged', async () => {
    const user = await seedUser({ email: 'race-old@example.com' });
    const client = makeClient();
    await client.post('/auth/login', { email: user.email, password: user.password });
    expect((await client.post('/api/me/change-email', { newEmail: 'race-new@example.com', currentPassword: user.password })).status).toBe(204);
    const token = capture.tokenFor('race-new@example.com');
    expect(token).toBeTruthy();

    const race = racingEnv(AUTH_TOKEN_CLAIM);
    const res = await fetchWithEnv(client, race.env, 'POST', '/api/me/change-email/confirm', { token });
    expect(race.fired()).toBe(true);
    expect(res.status).toBe(422);
    expect((await dbGet<{ email: string }>(`SELECT email FROM user WHERE id = ?`, user.id))?.email).toBe('race-old@example.com');
  });

  it('/api/orgs/invitations/accept: the loser is rejected and joins no org', async () => {
    const ownerUser = await seedUser({ email: 'race-owner@example.com' });
    const owner: TestClient = makeClient();
    await owner.post('/auth/login', { email: ownerUser.email, password: ownerUser.password });
    const orgRes = await owner.json<{ organization: { id: string } }>(
      await owner.post('/api/orgs', { slug: 'raceorg', name: 'Race Org' }),
    );
    const orgId = orgRes.organization.id;
    await env.DB.prepare('UPDATE organization SET plan = ? WHERE id = ?').bind('agency', orgId).run();
    expect((await owner.post(`/api/orgs/${orgId}/invitations`, { email: 'race-invitee@example.com', role: 'editor' })).status).toBe(204);
    const token = capture.tokenFor('race-invitee@example.com');
    expect(token).toBeTruthy();

    const invitee = await seedUser({ email: 'race-invitee@example.com' });
    const ic = makeClient();
    await ic.post('/auth/login', { email: invitee.email, password: invitee.password });

    const race = racingEnv(AUTH_TOKEN_CLAIM);
    const res = await fetchWithEnv(ic, race.env, 'POST', '/api/orgs/invitations/accept', { token });
    expect(race.fired()).toBe(true);
    expect(res.status).toBe(422);
    expect(
      await dbGet(`SELECT user_id FROM organization_membership WHERE org_id = ? AND user_id = ?`, orgId, invitee.id),
    ).toBeNull();
  });
});
