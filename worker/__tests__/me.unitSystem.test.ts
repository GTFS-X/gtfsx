// Account-level display-units preference (issue #76; migration 0033).
// GET /api/me returns `unitSystem` (null until chosen); PATCH /api/me accepts
// `unitSystem: 'imperial' | 'metric'` and persists it to user.unit_system.

import { beforeEach, describe, expect, it } from 'vitest';
import { makeClient } from './_client';
import { applyMigrations, dbGet, dbRun, resetDb, seedUser } from './_setup';

interface MeBody {
  user: { id: string; displayName: string; unitSystem: 'imperial' | 'metric' | null };
}

async function signedIn(email: string) {
  const user = await seedUser({ email });
  const client = makeClient();
  await client.post('/auth/login', { email: user.email, password: user.password });
  return { user, client };
}

describe('/api/me unitSystem preference', () => {
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
  });

  it('GET /api/me returns unitSystem: null for a user who never chose', async () => {
    const { client } = await signedIn('units-null@example.com');
    const body = await client.json<MeBody>(await client.get('/api/me'));
    expect(body.user.unitSystem).toBeNull();
  });

  it('PATCH persists the value; GET /api/me and the DB row reflect it', async () => {
    const { user, client } = await signedIn('units-set@example.com');

    const res = await client.patch('/api/me', { unitSystem: 'metric' });
    expect(res.status).toBe(200);
    const patched = await client.json<MeBody>(res);
    expect(patched.user.unitSystem).toBe('metric');

    const row = await dbGet<{ unit_system: string | null }>(
      `SELECT unit_system FROM user WHERE id = ?`,
      user.id,
    );
    expect(row?.unit_system).toBe('metric');

    const me = await client.json<MeBody>(await client.get('/api/me'));
    expect(me.user.unitSystem).toBe('metric');

    // And back again.
    const back = await client.json<MeBody>(await client.patch('/api/me', { unitSystem: 'imperial' }));
    expect(back.user.unitSystem).toBe('imperial');
  });

  it('follows the account to a second session (another device)', async () => {
    const { user, client } = await signedIn('units-devices@example.com');
    await client.json(await client.patch('/api/me', { unitSystem: 'metric' }));

    const other = makeClient();
    await other.post('/auth/login', { email: user.email, password: user.password });
    const me = await other.json<MeBody>(await other.get('/api/me'));
    expect(me.user.unitSystem).toBe('metric');
  });

  it('rejects values outside the enum (and null) with 422, leaving the row unchanged', async () => {
    const { user, client } = await signedIn('units-bad@example.com');
    await client.json(await client.patch('/api/me', { unitSystem: 'metric' }));

    for (const bad of ['Metric', 'si', '', 1, null, ['metric']]) {
      const res = await client.patch('/api/me', { unitSystem: bad });
      expect(res.status, `value ${JSON.stringify(bad)}`).toBe(422);
    }
    const row = await dbGet<{ unit_system: string | null }>(
      `SELECT unit_system FROM user WHERE id = ?`,
      user.id,
    );
    expect(row?.unit_system).toBe('metric');
  });

  it('rejects unknown keys (strict body)', async () => {
    const { client } = await signedIn('units-strict@example.com');
    const res = await client.patch('/api/me', { unitSystem: 'metric', plan: 'enterprise' });
    expect(res.status).toBe(422);
  });

  it('requires auth: GET and PATCH without a session are 401', async () => {
    const anon = makeClient();
    expect((await anon.get('/api/me')).status).toBe(401);
    expect((await anon.patch('/api/me', { unitSystem: 'metric' })).status).toBe(401);
  });

  it('a unitSystem-only PATCH leaves the display name alone, and displayName-only leaves units alone', async () => {
    const { user, client } = await signedIn('units-indep@example.com');
    await client.json(await client.patch('/api/me', { displayName: 'Kept Name' }));
    await client.json(await client.patch('/api/me', { unitSystem: 'metric' }));
    const afterUnits = await client.json<MeBody>(await client.get('/api/me'));
    expect(afterUnits.user.displayName).toBe('Kept Name');

    await client.json(await client.patch('/api/me', { displayName: 'New Name' }));
    const row = await dbGet<{ unit_system: string | null; display_name: string }>(
      `SELECT unit_system, display_name FROM user WHERE id = ?`,
      user.id,
    );
    expect(row).toEqual({ unit_system: 'metric', display_name: 'New Name' });
  });

  it('the column CHECK constraint refuses junk written around the API', async () => {
    const user = await seedUser({ email: 'units-check@example.com' });
    await expect(dbRun(`UPDATE user SET unit_system = 'furlongs' WHERE id = ?`, user.id)).rejects.toThrow();
  });
});
