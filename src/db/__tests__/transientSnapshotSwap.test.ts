import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../../store';
import {
  applySnapshotToStore,
  buildSnapshot,
  resetStoreEntities,
} from '../serverPersistence';
import type { Route } from '../../types/gtfs';

const ROUTE: Route = {
  route_id: 'R1',
  agency_id: 'A1',
  route_short_name: '1',
  route_long_name: 'Live edit',
  route_type: 3,
  route_color: '2E86AB',
  route_text_color: 'FFFFFF',
};

/**
 * PublishPanel.renderSnapshotZip downloads a PAST snapshot's ZIP by swapping it
 * into the store, running the exporter, and swapping the live state back. Both
 * halves went through applySnapshotToStore, whose trailing markSaved() then
 * declared the user's still-unsaved work "Saved" — disabling the Save button on
 * edits that only existed in the browser.
 */
describe('transient snapshot swap (publish-panel ZIP export)', () => {
  beforeEach(() => {
    resetStoreEntities();
    useStore.getState().setActiveServerProject('proj-1');
    useStore.getState().markSaved();
  });

  it('preserves unsaved work across a swap-and-restore', () => {
    useStore.getState().setRoutes([ROUTE]);
    useStore.getState().updateRoute('R1', { route_long_name: 'Unsaved edit' });
    expect(useStore.getState().isDirty).toBe(true);

    const live = buildSnapshot();
    const old = { ...live, routes: [{ ...ROUTE, route_long_name: 'Published version' }] };

    applySnapshotToStore(old, { preserveVariants: true, keepDirty: true });
    expect(useStore.getState().routes[0].route_long_name).toBe('Published version');

    applySnapshotToStore(live, { preserveVariants: true, keepDirty: true });

    const after = useStore.getState();
    expect(after.routes[0].route_long_name).toBe('Unsaved edit');
    // The point of the test: the work is still unsaved, so say so.
    expect(after.isDirty).toBe(true);
    expect(!after.isDirty && !!after.activeServerProjectId).toBe(false); // Save stays enabled
  });

  it('a swap over an already-clean store still ends clean', () => {
    useStore.getState().setRoutes([ROUTE]);
    useStore.getState().markSaved();

    const live = buildSnapshot();
    applySnapshotToStore({ ...live, routes: [] }, { preserveVariants: true, keepDirty: true });
    applySnapshotToStore(live, { preserveVariants: true, keepDirty: true });

    expect(useStore.getState().isDirty).toBe(false);
  });

  it('an ordinary (non-transient) apply still marks the store saved', () => {
    useStore.getState().setRoutes([ROUTE]);
    expect(useStore.getState().isDirty).toBe(true);

    applySnapshotToStore(buildSnapshot());

    expect(useStore.getState().isDirty).toBe(false);
  });
});
