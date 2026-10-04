// Route detail panel helpers (bug review batch B6): C1-04/C1-26 fit once per
// (route, tab) over every route shape, C1-02 stop-placement shape survives
// "Create new stop", C1-20 indexed trip rows, C1-19 colour drafts, C3-04
// flex-only hiding, C1-06 shared-shape copy, C1-07 route-scoped duplicate.
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../../store';
import { buildStopTimesIndex } from '../../../hooks/useStopTimesIndex';
import {
  buildRouteTripRows,
  isShapeSharedWithOtherRoute,
  managedRouteList,
  parseRouteColorDraft,
  planRouteFit,
  releaseStopPlacementShape,
  routeFitBounds,
  routeStopsToCopy,
} from '../routePanelHelpers';
import type { Calendar, Route, RouteStop, Shape, Stop, StopTime, Trip } from '../../../types/gtfs';
import type { FlexZone } from '../../../store/flexSlice';

const route = (id: string): Route =>
  ({ route_id: id, route_short_name: id, route_long_name: id, route_type: 3 }) as Route;
const trip = (id: string, extra: Partial<Trip> = {}): Trip =>
  ({ trip_id: id, route_id: 'R', service_id: 'WK', direction_id: 0, ...extra }) as Trip;
const st = (trip_id: string, seq: number, t: string): StopTime =>
  ({ trip_id, stop_id: `S${seq}`, stop_sequence: seq, arrival_time: t, departure_time: t }) as StopTime;
const rs = (stop_id: string, seq: number, extra: Partial<RouteStop> = {}): RouteStop =>
  ({ route_id: 'R', stop_id, direction_id: 0, stop_sequence: seq, ...extra }) as RouteStop;
const shape = (id: string, pts: [number, number][], extra: Partial<Shape> = {}): Shape => ({
  shape_id: id,
  points: pts.map(([lon, lat], i) => ({ shape_pt_lat: lat, shape_pt_lon: lon, shape_pt_sequence: i, shape_dist_traveled: 0 })),
  ...extra,
}) as Shape;
const stop = (id: string, lon: number, lat: number): Stop =>
  ({ stop_id: id, stop_name: id, stop_lat: lat, stop_lon: lon, location_type: 0 }) as Stop;
const zone = (id: string, routeId: string): FlexZone => ({ id, routeId }) as unknown as FlexZone;

describe('planRouteFit (C1-04, C1-26)', () => {
  const data = {
    shapes: [shape('A', [[-111, 45], [-110, 46]])],
    trips: [trip('T1', { shape_id: 'A' })],
    stops: [stop('S1', -111, 45), stop('S2', -110.5, 45.5)],
    routeStops: [rs('S1', 0), rs('S2', 1)],
  };

  it('fits once per (route, tab), not again on data edits', () => {
    const first = planRouteFit(null, 'R', 'shapes', data);
    expect(first.bounds).toEqual([[-111, 45], [-110, 46]]);
    expect(first.key).toBe('R|shapes');
    // A vertex drag rewrites the shape: same key, no re-fit.
    const edited = { ...data, shapes: [shape('A', [[-112, 44], [-110, 46]])] };
    const second = planRouteFit(first.key, 'R', 'shapes', edited);
    expect(second.bounds).toBeNull();
    expect(second.key).toBe('R|shapes');
  });

  it('fits again when the tab changes', () => {
    const plan = planRouteFit('R|shapes', 'R', 'stops', data);
    expect(plan.bounds).toEqual([[-111, 45], [-110.5, 45.5]]);
    expect(plan.key).toBe('R|stops');
  });

  it('a route with no geometry yet still fits once data arrives', () => {
    const empty = { shapes: [], trips: [], stops: [], routeStops: [] };
    const none = planRouteFit(null, 'R', 'shapes', empty);
    expect(none.bounds).toBeNull();
    expect(none.key).toBeNull();
    const later = planRouteFit(none.key, 'R', 'shapes', data);
    expect(later.bounds).not.toBeNull();
  });

  it('a suppressed fit consumes the key without fitting', () => {
    const plan = planRouteFit(null, 'R', 'stops', data, true);
    expect(plan.bounds).toBeNull();
    expect(plan.key).toBe('R|stops');
  });

  it('includes trip-less drawn shapes and shapes known only from route_stops', () => {
    const drawn = {
      shapes: [shape('D', [[-100, 40], [-99, 41]], { _route_id: 'R' }), shape('P', [[-98, 39], [-97, 39.5]])],
      trips: [],
      stops: [],
      routeStops: [rs('S1', 0, { shape_id: 'P' })],
    };
    expect(routeFitBounds('R', 'shapes', drawn)).toEqual([[-100, 39], [-97, 41]]);
  });
});

describe('releaseStopPlacementShape (C1-02)', () => {
  beforeEach(() => {
    useStore.getState().setCreatingStop(false);
    useStore.getState().setStopPlacementShapeId(null);
  });

  it('keeps the shape while Create new stop replaces the Stops tab', () => {
    useStore.getState().setStopPlacementShapeId('B');
    useStore.getState().setCreatingStop(true);
    releaseStopPlacementShape();
    expect(useStore.getState().stopPlacementShapeId).toBe('B');
  });

  it('clears it on an ordinary unmount', () => {
    useStore.getState().setStopPlacementShapeId('B');
    releaseStopPlacementShape();
    expect(useStore.getState().stopPlacementShapeId).toBeNull();
  });
});

describe('buildRouteTripRows (C1-20)', () => {
  it('derives start/end from the per-trip index and sorts unpadded times numerically', () => {
    const trips = [trip('LATE'), trip('EARLY'), trip('OTHER', { route_id: 'X' }), trip('BLANK')];
    const stopTimes = [
      st('LATE', 2, '10:30:00'), st('LATE', 1, '10:00:00'),
      st('EARLY', 1, '9:00:00'), st('EARLY', 2, '9:20:00'),
      st('OTHER', 1, '05:00:00'),
    ];
    const cals = [{ service_id: 'WK' } as Calendar];
    const rows = buildRouteTripRows('R', trips, buildStopTimesIndex(stopTimes).byTrip, cals);
    expect(rows.map((r) => r.trip.trip_id)).toEqual(['EARLY', 'LATE', 'BLANK']);
    expect(rows[0]).toMatchObject({ start: '9:00:00', end: '9:20:00' });
    expect(rows[1]).toMatchObject({ start: '10:00:00', end: '10:30:00' });
    expect(rows[0].cal?.service_id).toBe('WK');
    expect(rows[2].start).toBeUndefined();
  });

  it('handles a 50k-row feed quickly', () => {
    const trips: Trip[] = [];
    const stopTimes: StopTime[] = [];
    for (let i = 0; i < 2000; i++) {
      trips.push(trip(`T${i}`));
      for (let k = 0; k < 25; k++) stopTimes.push(st(`T${i}`, k, `${String(5 + (i % 18)).padStart(2, '0')}:${String(k).padStart(2, '0')}:00`));
    }
    const byTrip = buildStopTimesIndex(stopTimes).byTrip;
    const t0 = performance.now();
    const rows = buildRouteTripRows('R', trips, byTrip, []);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(rows).toHaveLength(2000);
  });
});

describe('parseRouteColorDraft (C1-19)', () => {
  it('accepts only a complete hex, with or without #', () => {
    expect(parseRouteColorDraft('#')).toBeNull();
    expect(parseRouteColorDraft('#12A')).toBeNull();
    expect(parseRouteColorDraft('#12ab3')).toBeNull();
    expect(parseRouteColorDraft('#12ab34')).toBe('12AB34');
    expect(parseRouteColorDraft('12AB34')).toBe('12AB34');
    expect(parseRouteColorDraft('#12AB34Z')).toBeNull();
  });
});

describe('managedRouteList (C3-04)', () => {
  it('hides only flex-only routes', () => {
    const routes = [route('FIX'), route('FLEXONLY'), route('MIXED'), route('SHARED')];
    const trips = [trip('t1', { route_id: 'FIX' }), trip('t2', { route_id: 'MIXED' })];
    const flexZones = [zone('z1', 'FLEXONLY'), zone('z2', 'MIXED'), zone('z3', 'SHARED'), zone('z4', 'SHARED')];
    expect(managedRouteList(routes, { trips, flexZones }).map((r) => r.route_id))
      .toEqual(['FIX', 'MIXED', 'SHARED']);
  });
});

describe('isShapeSharedWithOtherRoute (C1-06)', () => {
  const shapes = [shape('S', [[0, 0], [1, 1]]), shape('D', [[0, 0], [1, 1]], { _route_id: 'B' })];
  it('sees another route via trips, route_stops or _route_id', () => {
    expect(isShapeSharedWithOtherRoute('S', 'A', { trips: [trip('t', { route_id: 'A', shape_id: 'S' })], routeStops: [], shapes })).toBe(false);
    expect(isShapeSharedWithOtherRoute('S', 'A', { trips: [trip('t', { route_id: 'B', shape_id: 'S' })], routeStops: [], shapes })).toBe(true);
    expect(isShapeSharedWithOtherRoute('S', 'A', { trips: [], routeStops: [rs('X', 0, { route_id: 'B', shape_id: 'S' })], shapes })).toBe(true);
    expect(isShapeSharedWithOtherRoute('D', 'A', { trips: [], routeStops: [], shapes })).toBe(true);
    expect(isShapeSharedWithOtherRoute('D', 'B', { trips: [], routeStops: [], shapes })).toBe(false);
  });
});

describe('routeStopsToCopy (C1-07)', () => {
  it("copies only this route's pattern on the shape, in order", () => {
    const list = [
      rs('B', 1, { route_id: 'A', shape_id: 'S' }),
      rs('X', 0, { route_id: 'OTHER', shape_id: 'S' }),
      rs('A', 0, { route_id: 'A', shape_id: 'S' }),
      rs('C', 0, { route_id: 'A', shape_id: 'T' }),
    ];
    expect(routeStopsToCopy(list, 'A', 'S').map((r) => r.stop_id)).toEqual(['A', 'B']);
  });
});
