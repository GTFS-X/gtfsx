// Route → Shapes "Recompute distances", and the validation notice for trips
// whose stop distances are only partly filled (Butte's Green route: stops
// were swapped and 22 stop_times rows went blank).
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../../store';
import { resetHistory, undo } from '../../../store/history';
import type { Shape, Stop, StopTime, Trip } from '../../../types/gtfs';
import { describeRouteDistanceRecompute, recomputeRouteDistances } from '../recomputeRouteDistances';
import { findPartialStopDistances } from '../../../services/shapeDistRecompute';
import { runValidation } from '../../../services/validation';

// A straight east-west line, ~1.6 km, in metres.
function line(id: string, lat: number): Shape {
  const points = Array.from({ length: 21 }, (_, i) => ({
    shape_pt_lat: lat,
    shape_pt_lon: -112.55 + i * 0.001,
    shape_pt_sequence: i + 1,
    shape_dist_traveled: i * 78.6,
  }));
  return { shape_id: id, points };
}

const stop = (id: string, lat: number, lon: number): Stop => ({
  stop_id: id, stop_name: id, stop_lat: lat, stop_lon: lon, location_type: 0, wheelchair_boarding: 0,
});

const st = (trip: string, stopId: string, seq: number, dist?: number): StopTime => ({
  trip_id: trip, stop_id: stopId, stop_sequence: seq,
  arrival_time: `08:0${seq}:00`, departure_time: `08:0${seq}:00`,
  ...(dist !== undefined ? { shape_dist_traveled: dist } : {}),
});

const trip = (id: string, shape: string): Trip => ({
  trip_id: id, route_id: 'G', service_id: 'wk', direction_id: 0, shape_id: shape,
});

beforeEach(() => {
  const s = useStore.getState();
  s.setShapes([line('S1', 46.0), line('S2', 46.01)]);
  s.setStops([
    stop('a', 46.0, -112.549), stop('b', 46.0, -112.542), stop('c', 46.0, -112.533),
    stop('d', 46.01, -112.549), stop('e', 46.01, -112.535),
  ]);
  s.setTrips([trip('t1', 'S1'), trip('t2', 'S2')]);
  // t1: middle stop blank (the Butte case). t2: one stale value, one blank.
  s.setStopTimes([
    st('t1', 'a', 1, 78), st('t1', 'b', 2), st('t1', 'c', 3, 1328),
    st('t2', 'd', 1, 9999), st('t2', 'e', 2),
  ]);
  resetHistory();
});

const dist = (trip: string, seq: number) =>
  useStore.getState().stopTimes.find((r) => r.trip_id === trip && r.stop_sequence === seq)!.shape_dist_traveled;

describe('recomputeRouteDistances', () => {
  it('fills the blank rows and leaves shape geometry alone', () => {
    const before = useStore.getState().shapes.map((s) => s.points.map((p) => [p.shape_pt_lat, p.shape_pt_lon, p.shape_pt_sequence]));
    const r = recomputeRouteDistances(['S1', 'S2']);

    expect(r.shapes).toBe(2);
    expect(r.tripsRecomputed).toBe(2);
    for (const [t, seq] of [['t1', 1], ['t1', 2], ['t1', 3], ['t2', 1], ['t2', 2]] as const) {
      expect(Number.isFinite(dist(t, seq))).toBe(true);
    }
    // b sits between a and c along the line.
    expect(dist('t1', 2)!).toBeGreaterThan(dist('t1', 1)!);
    expect(dist('t1', 2)!).toBeLessThan(dist('t1', 3)!);

    const after = useStore.getState().shapes.map((s) => s.points.map((p) => [p.shape_pt_lat, p.shape_pt_lon, p.shape_pt_sequence]));
    expect(after).toEqual(before);
    expect(describeRouteDistanceRecompute(r)).toMatch(/^Updated \d+ stop distances on 2 trips/);
  });

  it('is one undo step across all of the route\'s shapes', () => {
    recomputeRouteDistances(['S1', 'S2']);
    undo();
    expect(dist('t1', 2)).toBeUndefined();
    expect(dist('t2', 1)).toBe(9999);
    expect(dist('t2', 2)).toBeUndefined();
  });

  it('says so when nothing needs to change', () => {
    recomputeRouteDistances(['S1', 'S2']);
    const again = recomputeRouteDistances(['S1', 'S2']);
    expect(again.stopTimesChanged).toBe(0);
    expect(describeRouteDistanceRecompute(again)).toBe('Distances already match the shapes. Nothing changed.');
  });
});

describe('partly-filled stop distances', () => {
  it('finds trips with some rows filled and some blank, by shape', () => {
    const found = findPartialStopDistances(useStore.getState().trips, useStore.getState().stopTimes);
    expect(found).toEqual([
      { shape_id: 'S1', tripIds: ['t1'], blankRows: 1 },
      { shape_id: 'S2', tripIds: ['t2'], blankRows: 1 },
    ]);
  });

  it('ignores trips with all rows filled or all blank', () => {
    const found = findPartialStopDistances(
      [trip('x', 'S1'), trip('y', 'S1')],
      [st('x', 'a', 1, 1), st('x', 'b', 2, 2), st('y', 'a', 1), st('y', 'b', 2)],
    );
    expect(found).toEqual([]);
  });

  it('raises a validation warning carrying the recompute fix, which clears it', () => {
    const partial = () => runValidation(useStore.getState())
      .filter((m) => /has shape_dist_traveled on some stops but not on/.test(m.message));
    const msgs = partial();
    expect(msgs).toHaveLength(2);
    expect(msgs.every((m) => m.fix?.id === 'recompute-shape-distances' && m.entity_type === 'shape')).toBe(true);

    recomputeRouteDistances(['S1', 'S2']);
    expect(partial()).toHaveLength(0);
  });

  it('a trip with no shape gets the warning without a fix', () => {
    const s = useStore.getState();
    s.setTrips([{ ...trip('t1', 'S1'), shape_id: undefined }]);
    s.setStopTimes([st('t1', 'a', 1, 0), st('t1', 'b', 2)]);
    const msgs = runValidation(useStore.getState()).filter((m) => /without a shape/.test(m.message));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].fix).toBeUndefined();
  });
});
