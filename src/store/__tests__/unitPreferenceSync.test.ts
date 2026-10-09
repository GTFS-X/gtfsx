// Issue #76 follow-up: the display-units preference follows a signed-in
// account (GET/PATCH /api/me `unitSystem`), while signed-out behaviour stays
// localStorage-only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/authApi', async (orig) => {
  const actual = await orig<typeof import('../../services/authApi')>();
  return { ...actual, me: vi.fn(), updateUnitSystem: vi.fn() };
});

import { me, updateUnitSystem, type AuthedUser } from '../../services/authApi';
import { decideUnitSync } from '../../services/unitPreferenceSync';
import { resetUnitSyncStateForTests } from '../preferencesSlice';
import { resetStore, store } from '../../test-utils/store';
import { UNIT_SYSTEM_STORAGE_KEY } from '../../utils/units';

const meMock = vi.mocked(me);
const patchMock = vi.mocked(updateUnitSystem);

const baseUser: AuthedUser = {
  id: 'u1',
  email: 'u1@example.com',
  displayName: 'U One',
  status: 'active',
  staff: false,
};

let data: Map<string, string>;
const stored = () => data.get(UNIT_SYSTEM_STORAGE_KEY) ?? null;

beforeEach(() => {
  data = new Map();
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, String(v));
    },
    removeItem: (k: string) => {
      data.delete(k);
    },
    clear: () => data.clear(),
  });
  meMock.mockReset();
  patchMock.mockReset();
  patchMock.mockResolvedValue({ user: baseUser });
  resetUnitSyncStateForTests();
  resetStore({ unitSystem: 'imperial', currentUser: null });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('decideUnitSync', () => {
  const d = (server: 'imperial' | 'metric' | null | undefined, s: 'imperial' | 'metric' | null, current: 'imperial' | 'metric', changedLocally = false) =>
    decideUnitSync({ server, stored: s, current, changedLocally });

  it('does nothing when the account value is unknown', () => {
    expect(d(undefined, 'metric', 'metric')).toEqual({ apply: null, push: null });
  });
  it('server value wins and is cached locally', () => {
    expect(d('metric', null, 'imperial')).toEqual({ apply: 'metric', push: null });
    expect(d('metric', 'imperial', 'imperial')).toEqual({ apply: 'metric', push: null });
    expect(d('metric', null, 'metric')).toEqual({ apply: 'metric', push: null }); // cache it
    expect(d('metric', 'metric', 'metric')).toEqual({ apply: null, push: null });
  });
  it('server NULL + an explicit local choice pushes it once', () => {
    expect(d(null, 'metric', 'metric')).toEqual({ apply: null, push: 'metric' });
    expect(d(null, 'imperial', 'imperial')).toEqual({ apply: null, push: 'imperial' });
  });
  it('server NULL + nothing stored leaves the default alone', () => {
    expect(d(null, null, 'imperial')).toEqual({ apply: null, push: null });
  });
  it('a toggle made in this tab before the account loaded wins', () => {
    expect(d('imperial', 'metric', 'metric', true)).toEqual({ apply: null, push: 'metric' });
    expect(d('metric', 'metric', 'metric', true)).toEqual({ apply: null, push: null });
  });
});

describe('preferences slice ↔ account', () => {
  it('signed out: toggling only touches localStorage', () => {
    store().setUnitSystem('metric');
    expect(store().unitSystem).toBe('metric');
    expect(stored()).toBe('metric');
    expect(patchMock).not.toHaveBeenCalled();
  });

  it('signed in: toggling persists to the account', async () => {
    resetStore({ unitSystem: 'imperial', currentUser: { ...baseUser, unitSystem: null } });
    store().setUnitSystem('metric');
    expect(store().unitSystem).toBe('metric');
    expect(patchMock).toHaveBeenCalledWith('metric');
  });

  it('signed in: a failed save keeps the local value and does not throw', async () => {
    patchMock.mockRejectedValue(new Error('network down'));
    resetStore({ unitSystem: 'imperial', currentUser: { ...baseUser, unitSystem: null } });
    expect(() => store().setUnitSystem('metric')).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(store().unitSystem).toBe('metric');
    expect(stored()).toBe('metric');
  });

  it('session load: the account value is applied and cached locally', async () => {
    data.set(UNIT_SYSTEM_STORAGE_KEY, 'imperial');
    meMock.mockResolvedValue({ user: { ...baseUser, unitSystem: 'metric' }, usage: null });
    await store().hydrateAuth();
    await vi.waitFor(() => expect(store().unitSystem).toBe('metric'));
    expect(stored()).toBe('metric');
    expect(patchMock).not.toHaveBeenCalled();
  });

  it('session load: account NULL + local choice pushes the local choice once', async () => {
    data.set(UNIT_SYSTEM_STORAGE_KEY, 'metric');
    resetStore({ unitSystem: 'metric', currentUser: null });
    meMock.mockResolvedValue({ user: { ...baseUser, unitSystem: null }, usage: null });
    await store().hydrateAuth();
    await vi.waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    expect(patchMock).toHaveBeenCalledWith('metric');
    expect(store().unitSystem).toBe('metric');
  });

  it('session load: account NULL + nothing stored does nothing', async () => {
    meMock.mockResolvedValue({ user: { ...baseUser, unitSystem: null }, usage: null });
    await store().hydrateAuth();
    await store().syncUnitSystemFromAccount({ ...baseUser, unitSystem: null });
    expect(patchMock).not.toHaveBeenCalled();
    expect(store().unitSystem).toBe('imperial');
    expect(stored()).toBeNull();
  });

  it('login (response without unitSystem) fetches /api/me, then applies it', async () => {
    meMock.mockResolvedValue({ user: { ...baseUser, unitSystem: 'metric' }, usage: null });
    store().setCurrentUser(baseUser); // login responses omit unitSystem
    await vi.waitFor(() => expect(store().unitSystem).toBe('metric'));
    expect(meMock).toHaveBeenCalled();
  });

  it('a /api/me failure during sync is swallowed and leaves the local value', async () => {
    data.set(UNIT_SYSTEM_STORAGE_KEY, 'metric');
    resetStore({ unitSystem: 'metric', currentUser: baseUser });
    meMock.mockRejectedValue(new Error('boom'));
    await expect(store().syncUnitSystemFromAccount(baseUser)).resolves.toBeUndefined();
    expect(store().unitSystem).toBe('metric');
  });

  it('staff impersonation neither reads nor writes the target account preference', async () => {
    const imp = { ...baseUser, unitSystem: 'metric' as const, impersonating: true };
    resetStore({ unitSystem: 'imperial', currentUser: imp });
    await store().syncUnitSystemFromAccount(imp);
    expect(store().unitSystem).toBe('imperial');
    store().setUnitSystem('metric');
    expect(patchMock).not.toHaveBeenCalled();
  });
});
