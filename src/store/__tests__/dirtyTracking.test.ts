import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '..';
import { loadingFeed, undo, redo, resetHistory } from '../history';
import { resetStoreEntities } from '../../db/serverPersistence';
import type { Route, Stop, Trip } from '../../types/gtfs';

const ROUTE: Route = {
  route_id: 'R1',
  agency_id: 'A1',
  route_short_name: '1',
  route_long_name: 'Old Name',
  route_type: 3,
  route_color: '2E86AB',
  route_text_color: 'FFFFFF',
};

const STOP: Stop = {
  stop_id: 'S1',
  stop_name: 'First',
  stop_lat: 45.68,
  stop_lon: -111.04,
  location_type: 0,
  wheelchair_boarding: 0,
};

const TRIP: Trip = {
  trip_id: 'T1',
  route_id: 'R1',
  service_id: 'WEEK',
  direction_id: 0,
};

/**
 * Dirty tracking must be a property of the DATA, not of which React components
 * happen to be mounted.
 *
 * It used to live in the store subscription that `db/persistence.setupAutoSave()`
 * installs, which the editor routes acquire and release by ref count. Any moment
 * with no live subscriber — a route transition, an effect re-run whose async
 * re-subscribe hadn't landed, the read-only /demo mount that never subscribes at
 * all — silently swallowed edits: the store changed, `isDirty` stayed false, and
 * TopBar's Save button (`disabled={saving || (!isDirty && !!activeServerProjectId)}`)
 * stayed DISABLED on hours of unsaved work.
 *
 * Every test here therefore runs with NO autosave subscription installed. Before
 * the fix they fail; the store's own write path now owns the flag.
 */
describe('dirty tracking is owned by the store, not by a mounted subscription', () => {
  beforeEach(() => {
    resetStoreEntities();
    resetHistory();
    useStore.getState().setActiveServerProject(null);
    useStore.getState().markSaved();
  });

  it('flips isDirty on a route field edit with no autosave subscription mounted', () => {
    useStore.getState().setRoutes([ROUTE]);
    useStore.getState().markSaved();
    expect(useStore.getState().isDirty).toBe(false);

    // Exactly what RouteEditor's "Long Name" field commits on every keystroke.
    useStore.getState().updateRoute('R1', { route_long_name: 'New Name' });

    expect(useStore.getState().routes[0].route_long_name).toBe('New Name');
    expect(useStore.getState().isDirty).toBe(true);
  });

  it('flips isDirty on a server-backed project, which is where Save is gated on it', () => {
    useStore.getState().setRoutes([ROUTE]);
    useStore.getState().setActiveServerProject('proj-1');
    useStore.getState().markSaved();

    useStore.getState().updateRoute('R1', { route_short_name: '2' });

    const s = useStore.getState();
    // The TopBar Save-button predicate, evaluated directly.
    expect(!s.isDirty && !!s.activeServerProjectId).toBe(false);
  });

  it('covers every persisted entity slice, not just routes', () => {
    const cases: Array<[string, () => void]> = [
      ['stops', () => useStore.getState().setStops([STOP])],
      ['trips', () => useStore.getState().setTrips([TRIP])],
      ['agencies', () => useStore.getState().setAgencies([
        { agency_id: 'A1', agency_name: 'A', agency_url: 'https://x.test', agency_timezone: 'America/Denver' },
      ])],
      ['stopTimes', () => useStore.getState().setStopTimes([
        { trip_id: 'T1', stop_id: 'S1', stop_sequence: 0, arrival_time: '08:00:00', departure_time: '08:00:00' },
      ])],
      ['transfers', () => useStore.getState().setTransfers([
        { from_stop_id: 'S1', to_stop_id: 'S1', transfer_type: 0 },
      ])],
      ['licenseSpdx', () => useStore.getState().setLicenseSpdx('CC-BY-4.0')],
    ];
    for (const [label, mutate] of cases) {
      useStore.getState().markSaved();
      mutate();
      expect(useStore.getState().isDirty, `${label} should mark the project dirty`).toBe(true);
    }
  });

  it('does NOT mark dirty for pure UI / session state', () => {
    useStore.getState().markSaved();
    useStore.getState().selectRoute('R1');
    useStore.getState().setMapMode('select');
    useStore.getState().setRightRailOpen(true);
    expect(useStore.getState().isDirty).toBe(false);
  });

  it('leaves a bulk feed load clean (loadingFeed + markSaved still wins)', () => {
    // The load paths mutate every entity slice and then declare the store
    // clean. Moving dirty-tracking into the write path must not turn opening a
    // feed into "unsaved changes".
    loadingFeed(() => {
      const s = useStore.getState();
      s.setRoutes([ROUTE]);
      s.setStops([STOP]);
      s.setTrips([TRIP]);
      s.markSaved();
    });
    expect(useStore.getState().isDirty).toBe(false);
  });

  it('marks dirty on undo and redo (they are unsaved changes too)', () => {
    useStore.getState().setRoutes([ROUTE]);
    useStore.getState().markSaved();
    resetHistory();

    useStore.getState().updateRoute('R1', { route_long_name: 'Edited' });
    useStore.getState().markSaved();

    // undo/redo apply a full replacement state through a non-recipe setState —
    // a different middleware branch from an ordinary edit.
    undo();
    expect(useStore.getState().routes[0].route_long_name).toBe('Old Name');
    expect(useStore.getState().isDirty).toBe(true);

    useStore.getState().markSaved();
    redo();
    expect(useStore.getState().routes[0].route_long_name).toBe('Edited');
    expect(useStore.getState().isDirty).toBe(true);
  });

  it('markSaved clears the flag and a no-op edit does not re-set it', () => {
    useStore.getState().setRoutes([ROUTE]);
    useStore.getState().markSaved();
    // Immer short-circuits a write of the identical value, so `routes` keeps its
    // reference and nothing is dirtied.
    useStore.getState().updateRoute('R1', { route_long_name: 'Old Name' });
    expect(useStore.getState().isDirty).toBe(false);
  });
});
