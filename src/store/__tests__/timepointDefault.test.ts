// New stop_times rows take their timetable column's timepoint when the trip
// uses timepoints, so a newly added stop column never exports blank cells in a
// populated timepoint column (MobilityData missing_timepoint_value).
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../index';
import type { RouteStop, StopTime, Trip } from '../../types/gtfs';
import { newRowTimepoint, groupStopTimesByTrip } from '../timepointDefault';

const trip = (id: string): Trip => ({ trip_id: id, route_id: 'R', service_id: 'wk', direction_id: 0, shape_id: 'S' });
const st = (t: string, stop: string, seq: number, timepoint?: 0 | 1): StopTime => ({
  trip_id: t, stop_id: stop, stop_sequence: seq, arrival_time: '08:00:00', departure_time: '08:00:00',
  ...(timepoint !== undefined ? { timepoint } : {}),
});
const rs = (stop: string, seq: number): RouteStop => ({ route_id: 'R', stop_id: stop, stop_sequence: seq, direction_id: 0, shape_id: 'S' } as RouteStop);
const row = (t: string, seq: number) => useStore.getState().stopTimes.find((r) => r.trip_id === t && r.stop_sequence === seq);

beforeEach(() => {
  const s = useStore.getState();
  s.setTrips([trip('t1'), trip('t2')]);
  s.setRouteStops([rs('a', 1), rs('b', 2), rs('c', 3)]);
  s.setStopTimes([
    st('t1', 'a', 1, 1), st('t1', 'b', 2, 0), st('t1', 'c', 3, 1),
    st('t2', 'a', 1, 1), st('t2', 'b', 2, 0), st('t2', 'c', 3, 1),
  ]);
});

describe('new timetable column timepoint', () => {
  it('a new column starts with Key timepoint off (0) on every trip, at the end or in the middle', () => {
    // Appended past the end (the editor's add-then-drag flow): still off, so
    // it doesn't stay a timepoint once dragged into the middle.
    useStore.getState().addRouteStop(rs('x', 5));
    expect(row('t1', 5)?.timepoint).toBe(0);
    expect(row('t2', 5)?.timepoint).toBe(0);

    useStore.getState().setRouteStops([rs('a', 1), rs('b', 2), rs('c', 10)]);
    useStore.getState().setStopTimes([
      st('t1', 'a', 1, 1), st('t1', 'b', 2, 0), st('t1', 'c', 10, 1),
      st('t2', 'a', 1, 1), st('t2', 'b', 2, 0), st('t2', 'c', 10, 1),
    ]);
    useStore.getState().addRouteStop(rs('y', 6));
    expect(row('t1', 6)?.timepoint).toBe(0);
    expect(row('t2', 6)?.timepoint).toBe(0);
  });

  it('existing rows are not rewritten', () => {
    const before = useStore.getState().stopTimes.map((r) => ({ ...r }));
    useStore.getState().addRouteStop(rs('x', 5));
    const after = useStore.getState().stopTimes.filter((r) => r.stop_sequence !== 5);
    expect(after).toEqual(before);
  });

  it('a trip that never uses timepoints gets no value (no new column)', () => {
    const s = useStore.getState();
    s.setStopTimes([st('t1', 'a', 1), st('t1', 'c', 3), st('t2', 'a', 1), st('t2', 'c', 3)]);
    s.setRouteStops([rs('a', 1), rs('c', 3)]);
    s.addRouteStop(rs('b', 2));
    expect(row('t1', 2)).toBeDefined();
    expect('timepoint' in row('t1', 2)!).toBe(false);
  });

  it('a time typed into a skipped cell takes the column\'s explicit setting', () => {
    const s = useStore.getState();
    // t2 skips b; t1 marks b as a key timepoint.
    s.setStopTimes([
      st('t1', 'a', 1, 1), st('t1', 'b', 2, 1), st('t1', 'c', 3, 1),
      st('t2', 'a', 1, 1), st('t2', 'c', 3, 1),
    ]);
    s.setStopTime('t2', 'b', 2, { arrival_time: '08:05:00', departure_time: '08:05:00' });
    expect(row('t2', 2)?.timepoint).toBe(1);
  });

  it('an explicit timepoint in the update wins', () => {
    const s = useStore.getState();
    s.setStopTimes([st('t1', 'a', 1, 1), st('t1', 'c', 3, 1)]);
    s.setStopTime('t1', 'b', 2, { timepoint: 1 });
    expect(row('t1', 2)?.timepoint).toBe(1);
  });

  it('toggling the column still flips every row', () => {
    useStore.getState().addRouteStop(rs('x', 5));
    for (const t of ['t1', 't2']) useStore.getState().setStopTime(t, 'x', 5, { timepoint: 1 });
    expect(row('t1', 5)?.timepoint).toBe(1);
    for (const t of ['t1', 't2']) useStore.getState().setStopTime(t, 'x', 5, { timepoint: 0 });
    expect(row('t2', 5)?.timepoint).toBe(0);
  });

  it('newRowTimepoint ignores trips on another pattern', () => {
    const trips = [trip('t1'), { ...trip('o'), shape_id: 'OTHER' }];
    const rows = groupStopTimesByTrip([st('t1', 'a', 1, 1), st('t1', 'c', 3, 1), st('o', 'b', 2, 1)]);
    expect(newRowTimepoint(trips[0], 2, trips, rows)).toBe(0);
  });
});
