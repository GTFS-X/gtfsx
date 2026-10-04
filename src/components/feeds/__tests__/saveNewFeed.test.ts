// C4-03 (variants not dropped), C4-05 (retry makes one project), S1-01 (saved guard).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Route } from '../../../types/gtfs';

const createProject = vi.fn();
const saveWorkingState = vi.fn();
vi.mock('../../../services/projectsApi', () => ({
  createProject: (...a: unknown[]) => createProject(...a),
  saveWorkingState: (...a: unknown[]) => saveWorkingState(...a),
  ConflictError: class extends Error {},
}));

const { useStore } = await import('../../../store');
const { resetEditorState } = await import('../../../db/serverPersistence');
const { createVariantFromCurrent } = await import('../../../services/variants');
const { saveCurrentFeedAsNew } = await import('../saveNewFeed');

const route = (id: string) =>
  ({ route_id: id, route_short_name: id, route_long_name: id, route_type: 3 }) as Route;
const project = { id: 'p1', slug: 'p1', name: 'Feed', ownerType: 'user', ownerId: 'u', workingStateVersion: 0 };

beforeEach(() => {
  createProject.mockReset();
  saveWorkingState.mockReset();
  createProject.mockResolvedValue(project);
  saveWorkingState.mockResolvedValue({ workingStateVersion: 1 });
  resetEditorState();
  useStore.getState().setRoutes([route('BASE')]);
});

describe('saveCurrentFeedAsNew', () => {
  it('saves the baseline plus a __variants envelope, not the active experiment', async () => {
    createVariantFromCurrent('Alt B');
    useStore.getState().setRoutes([route('ALT')]);
    expect(useStore.getState().routes[0].route_id).toBe('ALT');

    await saveCurrentFeedAsNew({ name: 'Feed', owner: { type: 'user' }, created: { current: null } });

    const snapshot = saveWorkingState.mock.calls[0][1] as Record<string, unknown>;
    expect((snapshot.routes as Route[]).map((r) => r.route_id)).toEqual(['BASE']);
    expect(snapshot.__variants).toBeTruthy();
  });

  it('retry after a failed save reuses the created project', async () => {
    saveWorkingState.mockRejectedValueOnce(new Error('network'));
    const created = { current: null };
    await expect(
      saveCurrentFeedAsNew({ name: 'Feed', owner: { type: 'user' }, created }),
    ).rejects.toThrow('network');
    await saveCurrentFeedAsNew({ name: 'Feed', owner: { type: 'user' }, created });

    expect(createProject).toHaveBeenCalledTimes(1);
    expect(saveWorkingState).toHaveBeenCalledTimes(2);
    expect(saveWorkingState.mock.calls[0][0]).toBe('p1');
    expect(saveWorkingState.mock.calls[1][0]).toBe('p1');
  });

  it('does not mark the store saved when an edit lands during the PUT', async () => {
    let release!: () => void;
    saveWorkingState.mockImplementationOnce(
      () => new Promise((res) => { release = () => res({ workingStateVersion: 1 }); }),
    );
    const p = saveCurrentFeedAsNew({ name: 'Feed', owner: { type: 'user' }, created: { current: null } });
    await vi.waitFor(() => expect(saveWorkingState).toHaveBeenCalled());
    useStore.getState().setRoutes([route('EDITED')]);
    release();
    await p;
    expect(useStore.getState().isDirty).toBe(true);
  });
});
