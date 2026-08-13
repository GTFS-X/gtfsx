// Tests for the local dev auth switch (src/dev/devAuth.ts).
//
// The load-bearing one is "stays off when import.meta.env.DEV is false" — the
// switch fabricates a signed-in, plan-bearing user, so its production
// elimination is the whole safety story. This suite covers the source-level
// half of that (the guard returns `off`); the compiled half (no trace of the
// code survives `vite build`) is enforced by scripts/check-prod-bundle.mjs,
// which runs as the last step of `npm run build:prod`.
//
// readDevAuth memoizes, so every case resets the module registry and re-imports.
import { describe, it, expect, afterEach, vi } from 'vitest';

async function load() {
  vi.resetModules();
  return import('../devAuth');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('readDevAuth — production guard', () => {
  it('is off in a production build even with the flag set', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_DEV_AUTH', 'agency');
    vi.stubEnv('VITE_DEV_SESSION_TOKEN', 'some-token');
    const { readDevAuth } = await load();
    expect(readDevAuth()).toEqual({ kind: 'off' });
  });

  it('emits no synthetic user in a production build', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_DEV_AUTH', 'enterprise+staff');
    const { readDevAuth } = await load();
    // Nothing anywhere in the returned value may carry the fake identity.
    expect(JSON.stringify(readDevAuth())).not.toContain('dev-auth@gtfsx.invalid');
    expect(JSON.stringify(readDevAuth())).not.toContain('dev-auth-local-user');
  });

  it('installDevSessionCookie is inert in a production build', async () => {
    vi.stubEnv('DEV', false);
    const { installDevSessionCookie } = await load();
    // No `document` in this environment: a version that ran would throw.
    expect(() => installDevSessionCookie('tok')).not.toThrow();
  });

  it('startDevAuthBadge returns a no-op in a production build', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_DEV_AUTH', 'agency');
    const { startDevAuthBadge } = await load();
    const subscribe = vi.fn();
    const stop = startDevAuthBadge({
      getState: () => ({ currentUser: null, authChecked: true }),
      subscribe,
    });
    expect(subscribe).not.toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
  });
});

describe('readDevAuth — opt-in', () => {
  it('is off in dev when the flag is unset', async () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('VITE_DEV_AUTH', '');
    const { readDevAuth } = await load();
    expect(readDevAuth()).toEqual({ kind: 'off' });
  });

  it('is off (and warns) on an unrecognized plan', async () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('VITE_DEV_AUTH', 'true');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { readDevAuth } = await load();
    expect(readDevAuth()).toEqual({ kind: 'off' });
    expect(warn).toHaveBeenCalledOnce();
  });

  it('is off (and warns) on an unrecognized flag', async () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('VITE_DEV_AUTH', 'agency+admin');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { readDevAuth } = await load();
    expect(readDevAuth()).toEqual({ kind: 'off' });
    expect(warn).toHaveBeenCalledOnce();
  });

  it('memoizes, so a bad value warns once however often it is read', async () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('VITE_DEV_AUTH', 'nonsense');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { readDevAuth } = await load();
    readDevAuth();
    readDevAuth();
    readDevAuth();
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('readDevAuth — client mode', () => {
  it('synthesizes an agency user', async () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('VITE_DEV_AUTH', 'agency');
    const { readDevAuth } = await load();
    const mode = readDevAuth();
    expect(mode.kind).toBe('client');
    if (mode.kind !== 'client') throw new Error('unreachable');
    expect(mode.plan).toBe('agency');
    expect(mode.staff).toBe(false);
    expect(mode.user).toMatchObject({
      id: 'dev-auth-local-user',
      email: 'dev-auth@gtfsx.invalid',
      status: 'active',
      staff: false,
      plan: 'agency',
      planStatus: 'active',
    });
  });

  it('honors the +staff flag', async () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('VITE_DEV_AUTH', 'enterprise+staff');
    const { readDevAuth } = await load();
    const mode = readDevAuth();
    if (mode.kind !== 'client') throw new Error('expected client mode');
    expect(mode.staff).toBe(true);
    expect(mode.user.staff).toBe(true);
    expect(mode.user.plan).toBe('enterprise');
  });

  it('is case- and whitespace-insensitive', async () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('VITE_DEV_AUTH', '  Agency+Staff  ');
    const { readDevAuth } = await load();
    const mode = readDevAuth();
    if (mode.kind !== 'client') throw new Error('expected client mode');
    expect(mode.plan).toBe('agency');
    expect(mode.staff).toBe(true);
  });

  it('leaves the no-card trial unconsumed on the free plan only', async () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('VITE_DEV_AUTH', 'free');
    const free = await load();
    const freeMode = free.readDevAuth();
    if (freeMode.kind !== 'client') throw new Error('expected client mode');
    expect(freeMode.user.trialUsed).toBe(false);

    vi.stubEnv('VITE_DEV_AUTH', 'agency');
    const agency = await load();
    const agencyMode = agency.readDevAuth();
    if (agencyMode.kind !== 'client') throw new Error('expected client mode');
    expect(agencyMode.user.trialUsed).toBe(true);
  });
});

describe('readDevAuth — server mode', () => {
  it('carries the seeded token and synthesizes nothing', async () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('VITE_DEV_AUTH', 'server');
    vi.stubEnv('VITE_DEV_SESSION_TOKEN', 'seeded-token-abc');
    const { readDevAuth } = await load();
    const mode = readDevAuth();
    expect(mode).toEqual({ kind: 'server', token: 'seeded-token-abc' });
  });

  it('fails closed (and warns) when the token is missing', async () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('VITE_DEV_AUTH', 'server');
    vi.stubEnv('VITE_DEV_SESSION_TOKEN', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { readDevAuth } = await load();
    expect(readDevAuth()).toEqual({ kind: 'off' });
    expect(warn).toHaveBeenCalledOnce();
  });
});
