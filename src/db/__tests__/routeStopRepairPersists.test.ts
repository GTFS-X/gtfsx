import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { RouteStop, StopTime, Trip } from '../../types/gtfs';

// loadProjectFromServer's only I/O. Mocked so the test drives the real load
// pipeline (applySnapshotToStore → route_stop migrations → markSaved) against a
// feed whose stored pattern doesn't cover its own stop_times.
const fetchWorkingState = vi.fn();
vi.mock('../../services/projectsApi', () => ({
  fetchWorkingState: (...args: unknown[]) => fetchWorkingState(...args),
  saveWorkingState: vi.fn(),
  ConflictError: class ConflictError extends Error {
    currentVersion = 0;
  },
}));

const { useStore } = await import('../../store');
const { loadProjectFromServer, buildWorkingStateSnapshot, resetStoreEntities } = await import(
  '../serverPersistence'
);

const TRIPS: Trip[] = [
  // The canonical trip the pattern was derived from — a 3-stop short-turn.
  { trip_id: 'T-short', route_id: 'R1', service_id: 'WEEK', direction_id: 0, shape_id: 'SH1' },
  // A full-length trip serving two stops the pattern has no column for.
  { trip_id: 'T-full', route_id: 'R1', service_id: 'WEEK', direction_id: 0, shape_id: 'SH1' },
];

const STOP_TIMES: StopTime[] = [
  ...[0, 1, 2].map((seq) => ({
    trip_id: 'T-short',
    stop_id: `S${seq}`,
    stop_sequence: seq,
    arrival_time: `08:0${seq}:00`,
    departure_time: `08:0${seq}:00`,
  })),
  ...[0, 1, 2, 3, 4].map((seq) => ({
    trip_id: 'T-full',
    stop_id: `S${seq}`,
    stop_sequence: seq,
    arrival_time: `09:0${seq}:00`,
    departure_time: `09:0${seq}:00`,
  })),
];

// Only 3 of the 5 sequences T-full actually serves. Sequences 3 and 4 are
// orphans: no column, so the timetable can neither show nor rewrite them.
const ROUTE_STOPS: RouteStop[] = [0, 1, 2].map((seq) => ({
  route_id: 'R1',
  stop_id: `S${seq}`,
  direction_id: 0 as const,
  stop_sequence: seq,
  shape_id: 'SH1',
  _snapped: true,
  _uid: `rs-${seq}`,
}));

function serverSnapshot() {
  return {
    routes: [{
      route_id: 'R1',
      agency_id: 'A1',
      route_short_name: '1',
      route_long_name: 'Main',
      route_type: 3,
      route_color: '2E86AB',
      route_text_color: 'FFFFFF',
    }],
    stops: [0, 1, 2, 3, 4].map((i) => ({
      stop_id: `S${i}`,
      stop_name: `Stop ${i}`,
      stop_lat: 45.68 + i / 1000,
      stop_lon: -111.04,
      location_type: 0,
      wheelchair_boarding: 0,
    })),
    trips: TRIPS,
    stopTimes: STOP_TIMES,
    routeStops: ROUTE_STOPS,
  };
}

describe('orphaned route_stops: the repair must be able to PERSIST', () => {
  beforeEach(() => {
    resetStoreEntities();
    useStore.getState().markSaved();
    fetchWorkingState.mockReset();
  });

  it('backfills the missing columns AND leaves the project saveable', async () => {
    fetchWorkingState.mockResolvedValue({ snapshot: serverSnapshot(), version: 6 });
    useStore.getState().setActiveServerProject('proj-1');

    await loadProjectFromServer('proj-1');

    const after = useStore.getState();
    const pattern = after.routeStops.filter((rs) => rs.route_id === 'R1' && rs.direction_id === 0);

    // (a) repaired in memory — every stored stop_time now has a column.
    expect(pattern.map((rs) => rs.stop_sequence).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);

    // (b) and — the half that was missing — the editor knows the store no longer
    // matches the server, so Save is offered and the repair can actually reach
    // R2. Without this the server keeps serving the broken pattern forever and
    // every session re-repairs it in memory.
    expect(after.isDirty).toBe(true);
    expect(!after.isDirty && !!after.activeServerProjectId).toBe(false); // TopBar Save predicate

    // (c) what a Save would upload carries the repair.
    const snapshot = buildWorkingStateSnapshot() as { routeStops: RouteStop[] };
    expect(snapshot.routeStops).toHaveLength(5);
  });

  it('leaves an already-correct feed clean, so opening a healthy feed never says "unsaved"', async () => {
    const snap = serverSnapshot();
    // Give the pattern every sequence its trips serve.
    snap.routeStops = [0, 1, 2, 3, 4].map((seq) => ({
      route_id: 'R1',
      stop_id: `S${seq}`,
      direction_id: 0 as const,
      stop_sequence: seq,
      shape_id: 'SH1',
      _snapped: true,
      _uid: `rs-${seq}`,
    }));
    fetchWorkingState.mockResolvedValue({ snapshot: snap, version: 6 });
    useStore.getState().setActiveServerProject('proj-1');

    await loadProjectFromServer('proj-1');

    expect(useStore.getState().routeStops).toHaveLength(5);
    expect(useStore.getState().isDirty).toBe(false);
  });
});
