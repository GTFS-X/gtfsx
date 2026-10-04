// Server save/load guards (bug review batch B4):
//   S1-01 — an edit made while a save's PUT is in flight must not be marked
//           saved (the server never received it).
//   C4-07 — "Keep mine" must report a second conflict / a failed version
//           fetch instead of resolving as if the overwrite landed.
//   C3-19 — a stale loadProjectFromServer (the user navigated to another
//           feed meanwhile) must not touch the store.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Route } from '../../types/gtfs';

const fetchWorkingState = vi.fn();
const saveWorkingState = vi.fn();
vi.mock('../../services/projectsApi', () => {
  class ConflictError extends Error {
    currentVersion: number;
    constructor(message: string, v: number) { super(message); this.currentVersion = v; }
  }
  return {
    fetchWorkingState: (...a: unknown[]) => fetchWorkingState(...a),
    saveWorkingState: (...a: unknown[]) => saveWorkingState(...a),
    ConflictError,
  };
});

const { useStore } = await import('../../store');
const projectsApi = await import('../../services/projectsApi');
const {
  saveProjectNow, forceSaveWithLatest, loadProjectFromServer, resetStoreEntities,
  getCurrentWorkingStateVersion, setCurrentWorkingStateVersion,
} = await import('../serverPersistence');

const PID = 'proj-1';
const route = (id: string, name = id): Route =>
  ({ route_id: id, route_short_name: name, route_long_name: name, route_type: 3 }) as Route;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  fetchWorkingState.mockReset();
  saveWorkingState.mockReset();
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  resetStoreEntities();
  setCurrentWorkingStateVersion(PID, 3);
  useStore.getState().setRoutes([route('R1')]);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('S1-01: saveProjectNow and edits made during the PUT', () => {
  it('an edit during the PUT keeps the store dirty; the version still advances', async () => {
    const put = deferred<{ workingStateVersion: number }>();
    saveWorkingState.mockReturnValueOnce(put.promise);
    expect(useStore.getState().isDirty).toBe(true);

    const saving = saveProjectNow(PID);
    useStore.getState().updateRoute('R1', { route_long_name: 'edited mid-save' });
    put.resolve({ workingStateVersion: 4 });

    await expect(saving).resolves.toBe('saved');
    expect(getCurrentWorkingStateVersion(PID)).toBe(4);
    expect(useStore.getState().isDirty).toBe(true);
    // What was sent is the pre-edit state.
    const sent = saveWorkingState.mock.calls[0][1] as { routes: Route[] };
    expect(sent.routes[0].route_long_name).toBe('R1');
  });

  it('with no edit during the PUT the store is marked saved', async () => {
    saveWorkingState.mockResolvedValueOnce({ workingStateVersion: 4 });
    await expect(saveProjectNow(PID)).resolves.toBe('saved');
    expect(useStore.getState().isDirty).toBe(false);
  });
});

describe('C4-07: forceSaveWithLatest reports what really happened', () => {
  it('throws when the latest-version GET fails, without saving', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    await expect(forceSaveWithLatest(PID)).rejects.toThrow(/500/);
    expect(saveWorkingState).not.toHaveBeenCalled();
    expect(useStore.getState().isDirty).toBe(true);
  });

  it('resolves "conflict" when the overwrite conflicts again', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ workingStateVersion: 7 })));
    saveWorkingState.mockRejectedValueOnce(new projectsApi.ConflictError('conflict', 8));
    await expect(forceSaveWithLatest(PID)).resolves.toBe('conflict');
    expect(saveWorkingState.mock.calls[0][2]).toBe(7); // retried with the fresh If-Match
    expect(useStore.getState().isDirty).toBe(true);
  });

  it('resolves "saved" when the overwrite lands', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ workingStateVersion: 7 })));
    saveWorkingState.mockResolvedValueOnce({ workingStateVersion: 8 });
    await expect(forceSaveWithLatest(PID)).resolves.toBe('saved');
    expect(useStore.getState().isDirty).toBe(false);
  });
});

describe('C3-19: loadProjectFromServer isCurrent guard', () => {
  it('a slow load for A that resolves after B loaded leaves B in the store', async () => {
    const a = deferred<unknown>();
    const b = deferred<unknown>();
    fetchWorkingState.mockImplementation((id: string) => (id === 'A' ? a.promise : b.promise));
    let current = 'A';

    const loadA = loadProjectFromServer('A', { isCurrent: () => current === 'A' });
    current = 'B';
    const loadB = loadProjectFromServer('B', { isCurrent: () => current === 'B' });

    b.resolve({ snapshot: { routes: [route('RB')] }, version: 5 });
    await expect(loadB).resolves.toBe(true);
    a.resolve({ snapshot: { routes: [route('RA')] }, version: 9 });
    await expect(loadA).resolves.toBe(false);

    expect(useStore.getState().routes.map((r) => r.route_id)).toEqual(['RB']);
    expect(getCurrentWorkingStateVersion('A')).toBe(0); // stale version never cached
    expect(useStore.getState().workingStateVersion).toBe(5);
  });

  it('without isCurrent it behaves as before', async () => {
    fetchWorkingState.mockResolvedValueOnce({ snapshot: { routes: [route('RX')] }, version: 2 });
    await expect(loadProjectFromServer('X')).resolves.toBe(true);
    expect(useStore.getState().routes.map((r) => r.route_id)).toEqual(['RX']);
  });
});
