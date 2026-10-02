// #70: a stop_time whose stop differs from the pattern stop at the same
// stop_sequence ("off-pattern") must survive every sequence-keyed write the
// timetable makes through that column: cell edit, skip, interpolate. Only the
// explicit replace action may re-point it, and only when it names the row.
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../index';

const ROUTE_STOPS = ['A', 'B', 'C', 'D'].map((stop_id, stop_sequence) => ({
  route_id: 'R', stop_id, direction_id: 0 as const, stop_sequence, _snapped: false,
}));

beforeEach(() => {
  const s = useStore.getState();
  s.setRoutes([{ route_id: 'R', route_short_name: 'R', route_long_name: 'R', route_type: 3 }] as never);
  s.setRouteStops(ROUTE_STOPS as never);
  s.setShapes([]);
  s.setTrips([{ trip_id: 'T', route_id: 'R', service_id: 'S', direction_id: 0 }] as never);
  s.setStopTimes([]);
});

const row = (seq: number) => useStore.getState().stopTimes.filter((st) => st.trip_id === 'T' && st.stop_sequence === seq);

function seed(rows: [stop_id: string, seq: number, time: string, dist?: number][]) {
  useStore.getState().setStopTimes(rows.map(([stop_id, stop_sequence, t, dist]) => ({
    trip_id: 'T', stop_id, stop_sequence, arrival_time: t, departure_time: t,
    ...(dist === undefined ? {} : { shape_dist_traveled: dist }),
  })));
}

describe('setStopTime through a column whose row is for another stop', () => {
  it('refuses (returns false), leaves the off-pattern row untouched, adds no second row', () => {
    seed([['A', 0, '08:00:00'], ['ER', 1, '08:05:00'], ['D', 3, '08:30:00']]);
    const wrote = useStore.getState().setStopTime('T', 'B', 1, { arrival_time: '09:00:00', departure_time: '09:00:00' });
    expect(wrote).toBe(false);
    expect(row(1)).toEqual([expect.objectContaining({ stop_id: 'ER', arrival_time: '08:05:00', departure_time: '08:05:00' })]);
  });

  it('still edits the row when the stop matches, including a repeated stop in a loop', () => {
    seed([['L1', 0, '08:00:00'], ['L2', 1, '08:05:00'], ['L1', 2, '08:10:00']]);
    expect(useStore.getState().setStopTime('T', 'L1', 2, { arrival_time: '08:12:00', departure_time: '08:12:00' })).toBe(true);
    expect(row(2)[0].arrival_time).toBe('08:12:00');
    expect(row(0)[0].arrival_time).toBe('08:00:00');
  });
});

describe('skipStop with a stop_id', () => {
  it('does not delete an off-pattern row sharing the sequence', () => {
    seed([['A', 0, '08:00:00'], ['ER', 1, '08:05:00']]);
    useStore.getState().skipStop('T', 1, 'B');
    expect(row(1)).toHaveLength(1);
  });

  it('removes the row when the stop matches', () => {
    seed([['A', 0, '08:00:00'], ['ER', 1, '08:05:00']]);
    useStore.getState().skipStop('T', 1, 'ER');
    expect(row(1)).toHaveLength(0);
  });
});

describe('interpolateStopTimes around off-pattern rows', () => {
  it('does not write a route stop\'s interpolated time onto an off-pattern row', () => {
    seed([['A', 0, '08:00:00'], ['ER', 1, ''], ['C', 2, ''], ['D', 3, '08:30:00']]);
    useStore.getState().interpolateStopTimes('T');
    expect(row(1)[0]).toMatchObject({ stop_id: 'ER', arrival_time: '' });
    expect(row(2)[0].arrival_time).toBe('08:20:00'); // the matching row still interpolates
  });

  it('does not use an off-pattern row as an anchor', () => {
    // Only the ER row at D's sequence has a later time. Before #70 it became the
    // end anchor and C was interpolated from a different stop's time.
    seed([['A', 0, '08:00:00'], ['C', 2, ''], ['ER', 3, '09:00:00']]);
    useStore.getState().interpolateStopTimes('T');
    expect(row(2)[0].arrival_time).toBe('');
  });
});

describe('replaceStopTimeStop', () => {
  it('re-points the named row, keeps its times, clears shape_dist_traveled', () => {
    seed([['ER', 0, '14:15:00', 0], ['ER', 1, '14:16:00', 0]]);
    const ok = useStore.getState().replaceStopTimeStop('T', 0, 'ER', 'A');
    expect(ok).toBe(true);
    const [r0] = row(0);
    expect(r0).toMatchObject({ stop_id: 'A', arrival_time: '14:15:00', departure_time: '14:15:00' });
    expect(r0.shape_dist_traveled).toBeUndefined();
    expect(row(1)[0]).toMatchObject({ stop_id: 'ER', shape_dist_traveled: 0 }); // the other row is untouched
  });

  it('does nothing when the current stop_id does not match', () => {
    seed([['ER', 0, '14:15:00']]);
    expect(useStore.getState().replaceStopTimeStop('T', 0, 'B', 'A')).toBe(false);
    expect(row(0)[0].stop_id).toBe('ER');
  });
});
