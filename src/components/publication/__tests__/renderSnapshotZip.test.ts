// C4-06: rendering a past snapshot's ZIP (publish, rollback, draft links) used
// to swap the snapshot into the store through applySnapshotToStore, whose
// loadingFeed() wiped the undo/redo history and whose resetEditorState()
// cleared selection and analysis overlays. The swap is now transient: the live
// store is put back as the very same state object.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import type { Route } from '../../../types/gtfs';

const fetchSnapshotState = vi.fn();
vi.mock('../../../services/projectsApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/projectsApi')>()),
  fetchSnapshotState: (...a: unknown[]) => fetchSnapshotState(...a),
}));

const { useStore } = await import('../../../store');
const { canUndo, resetHistory, undo } = await import('../../../store/history');
const { buildSnapshot, resetStoreEntities } = await import('../../../db/serverPersistence');
const { renderSnapshotZip } = await import('../PublishPanel');

const route = (id: string, name: string): Route =>
  ({ route_id: id, route_short_name: name, route_long_name: name, route_type: 3 }) as Route;

beforeEach(() => {
  resetStoreEntities();
  resetHistory();
  fetchSnapshotState.mockReset();
});

describe('renderSnapshotZip keeps the live editor intact', () => {
  it('exports the snapshot, then restores history, selection, overlays and dirty flag', async () => {
    const s = useStore.getState;
    s().setRoutes([route('LIVE', 'Live route')]);
    s().markSaved();
    s().updateRoute('LIVE', { route_long_name: 'Unsaved edit' }); // one undo entry, dirty
    s().selectRoute('LIVE');
    const coverage = { marker: 'coverage' } as never;
    s().setCoverageData(coverage);
    const liveState = s();

    fetchSnapshotState.mockResolvedValueOnce({ ...buildSnapshot(), routes: [route('OLD', 'Published route')] });
    const blob = await renderSnapshotZip('proj-1', 'snap-1');

    // The ZIP is the snapshot, not the live feed.
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const routesTxt = await zip.file('routes.txt')!.async('string');
    expect(routesTxt).toContain('OLD');
    expect(routesTxt).not.toContain('LIVE');

    // The live store is exactly what it was.
    expect(s()).toBe(liveState);
    expect(s().routes[0].route_long_name).toBe('Unsaved edit');
    expect(s().selectedRouteId).toBe('LIVE');
    expect(s().coverageData).toBe(coverage);
    expect(s().isDirty).toBe(true);
    expect(canUndo()).toBe(true);
    undo();
    expect(s().routes[0].route_long_name).toBe('Live route');
  });

  it('a clean store stays clean', async () => {
    useStore.getState().setRoutes([route('LIVE', 'Live')]);
    useStore.getState().markSaved();
    fetchSnapshotState.mockResolvedValueOnce({ routes: [route('OLD', 'Old')] });
    await renderSnapshotZip('proj-1', 'snap-1');
    expect(useStore.getState().isDirty).toBe(false);
    expect(useStore.getState().routes[0].route_id).toBe('LIVE');
  });
});
