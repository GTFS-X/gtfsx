// Forum report 2026-10-04 ("Two different stops have time edited together"):
// editing one stop's time in the timetable also changed the next stop's time.
//
// Root cause: every "add a stop to this route" path picked the new stop's
// stop_sequence as the COUNT of stops already in the pattern. That only works
// when the pattern is numbered 0..n-1 with no gaps. An imported feed keeps its
// own numbering (GTFS commonly starts at 1), and removing a stop leaves a gap,
// so count-as-sequence lands ON an existing stop's sequence. The timetable
// keys every cell by (trip, stop_sequence), so the two columns then share one
// stop_times row: type a time into one and the other shows it too.
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../index';
import { nextRouteStopSequence, repairRouteStops } from '../../services/routeStopMigration';
import type { RouteStop, StopTime, Trip } from '../../types/gtfs';

const ROUTE = 'R1';
const SHAPE = 'SH1';

beforeEach(() => {
  const s = useStore.getState();
  s.setRoutes([]);
  s.setRouteStops([]);
  s.setTrips([]);
  s.setStopTimes([]);
});

const pattern = () =>
  useStore.getState().routeStops
    .filter((rs) => rs.route_id === ROUTE && rs.shape_id === SHAPE)
    .sort((a, b) => a.stop_sequence - b.stop_sequence);

const timeAt = (tripId: string, seq: number) =>
  useStore.getState().stopTimes.find((st) => st.trip_id === tripId && st.stop_sequence === seq);

/** An imported feed: three stops numbered 1, 2, 3 (GTFS's usual 1-based
 *  numbering), and one trip timed at every stop. */
function seedImported() {
  const s = useStore.getState();
  s.setRoutes([{ route_id: ROUTE, route_short_name: '1', route_long_name: '', route_type: 3 }] as never);
  s.setRouteStops([1, 2, 3].map((seq) => ({
    route_id: ROUTE, stop_id: `S${seq}`, direction_id: 0, stop_sequence: seq, _snapped: true, shape_id: SHAPE,
  })) as never);
  s.setTrips([{ trip_id: 'T1', route_id: ROUTE, service_id: 'WK', direction_id: 0, shape_id: SHAPE }] as never);
  s.setStopTimes([
    { trip_id: 'T1', stop_id: 'S1', stop_sequence: 1, arrival_time: '08:00:00', departure_time: '08:00:00' },
    { trip_id: 'T1', stop_id: 'S2', stop_sequence: 2, arrival_time: '08:05:00', departure_time: '08:05:00' },
    { trip_id: 'T1', stop_id: 'S3', stop_sequence: 3, arrival_time: '08:10:00', departure_time: '08:10:00' },
  ] as never);
}

/** What the Stops tab / map / Create Stop panel do: append with
 *  stop_sequence = number of stops already in the pattern. */
function appendLikeTheUi(stopId: string) {
  useStore.getState().addRouteStop({
    route_id: ROUTE, stop_id: stopId, direction_id: 0,
    stop_sequence: pattern().length, _snapped: false, shape_id: SHAPE,
  } as never);
}

describe('adding a stop never reuses an existing stop_sequence', () => {
  it('appending to a 1-based imported pattern gives the new stop its own sequence, after the last stop', () => {
    seedImported();
    appendLikeTheUi('NEW');
    const rs = pattern();
    expect(rs.map((r) => r.stop_id)).toEqual(['S1', 'S2', 'S3', 'NEW']);
    expect(new Set(rs.map((r) => r.stop_sequence)).size).toBe(rs.length);
  });

  it('editing the last stop no longer changes the newly added stop (the reported symptom)', () => {
    seedImported();
    appendLikeTheUi('NEW');
    const newSeq = pattern().find((r) => r.stop_id === 'NEW')!.stop_sequence;
    // The timetable cell for S3 commits by (trip, S3's sequence).
    useStore.getState().setStopTime('T1', 'S3', 3, { arrival_time: '08:12:00', departure_time: '08:12:00' });
    expect(timeAt('T1', 3)?.arrival_time).toBe('08:12:00');
    expect(timeAt('T1', 3)?.stop_id).toBe('S3');
    // The new stop has its OWN served (blank) row, untouched by the S3 edit.
    const fresh = timeAt('T1', newSeq);
    expect(fresh?.stop_id).toBe('NEW');
    expect(fresh?.arrival_time).toBe('');
  });

  it('appending after removing a middle stop does not land on the last stop', () => {
    const s = useStore.getState();
    s.setRoutes([{ route_id: ROUTE, route_short_name: '1', route_long_name: '', route_type: 3 }] as never);
    for (const [i, id] of ['A', 'B', 'C', 'D'].entries()) {
      s.addRouteStop({ route_id: ROUTE, stop_id: id, direction_id: 0, stop_sequence: i, _snapped: false, shape_id: SHAPE } as never);
    }
    const b = pattern().find((r) => r.stop_id === 'B')!;
    useStore.getState().removeRouteStop(ROUTE, b._uid!); // leaves 0, 2, 3
    appendLikeTheUi('E'); // count = 3 → used to collide with D
    const rs = pattern();
    expect(rs.map((r) => r.stop_id)).toEqual(['A', 'C', 'D', 'E']);
    expect(new Set(rs.map((r) => r.stop_sequence)).size).toBe(rs.length);
  });

  it('appending to a sparse pattern (10, 20, 30) puts the new stop at the end, not the start', () => {
    const s = useStore.getState();
    s.setRouteStops([10, 20, 30].map((seq) => ({
      route_id: ROUTE, stop_id: `S${seq}`, direction_id: 0, stop_sequence: seq, _snapped: true, shape_id: SHAPE,
    })) as never);
    // Count (3) is free here, so the store guard can't catch it — the add paths
    // (Stops tab, map click, Create Stop panel) now pass nextRouteStopSequence.
    expect(nextRouteStopSequence(pattern())).toBe(31);
    s.addRouteStop({
      route_id: ROUTE, stop_id: 'NEW', direction_id: 0,
      stop_sequence: nextRouteStopSequence(pattern()), _snapped: false, shape_id: SHAPE,
    } as never);
    expect(pattern().map((r) => r.stop_id)).toEqual(['S10', 'S20', 'S30', 'NEW']);
  });

  it('an explicit, free sequence is kept as given (reverse-shape copy builds n-1..0)', () => {
    const s = useStore.getState();
    for (const [i, id] of ['X', 'Y', 'Z'].entries()) {
      s.addRouteStop({ route_id: ROUTE, stop_id: id, direction_id: 0, stop_sequence: 2 - i, _snapped: false, shape_id: SHAPE } as never);
    }
    expect(pattern().map((r) => [r.stop_id, r.stop_sequence])).toEqual([['Z', 0], ['Y', 1], ['X', 2]]);
  });
});

describe('load-time repair of patterns already saved with a shared sequence', () => {
  // The exact broken state the old code saved: NEW was appended at seq 3 on top
  // of S3, and the seed skipped T1 because it already had a row at seq 3.
  const routeStops: RouteStop[] = [
    { route_id: ROUTE, stop_id: 'S1', direction_id: 0, stop_sequence: 1, _snapped: true, shape_id: SHAPE, _uid: 'u1' },
    { route_id: ROUTE, stop_id: 'S2', direction_id: 0, stop_sequence: 2, _snapped: true, shape_id: SHAPE, _uid: 'u2' },
    { route_id: ROUTE, stop_id: 'S3', direction_id: 0, stop_sequence: 3, _snapped: true, shape_id: SHAPE, _uid: 'u3' },
    { route_id: ROUTE, stop_id: 'NEW', direction_id: 0, stop_sequence: 3, _snapped: false, shape_id: SHAPE, _uid: 'u4' },
  ];
  const trips: Trip[] = [{ trip_id: 'T1', route_id: ROUTE, service_id: 'WK', direction_id: 0, shape_id: SHAPE } as Trip];
  const stopTimes: StopTime[] = [
    { trip_id: 'T1', stop_id: 'S1', stop_sequence: 1, arrival_time: '08:00:00', departure_time: '08:00:00' },
    { trip_id: 'T1', stop_id: 'S2', stop_sequence: 2, arrival_time: '08:05:00', departure_time: '08:05:00' },
    { trip_id: 'T1', stop_id: 'S3', stop_sequence: 3, arrival_time: '08:10:00', departure_time: '08:10:00' },
  ];

  it('moves the later duplicate to its own sequence at the end; S3 keeps its row, nothing is invented', () => {
    const fixed = repairRouteStops(routeStops, trips, stopTimes);
    expect(fixed.repaired).toBe(true);
    const seqs = fixed.routeStops.map((r) => r.stop_sequence);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(fixed.routeStops.find((r) => r.stop_id === 'NEW')!.stop_sequence).toBe(4);
    // The row at seq 3 names S3, so it stays with S3. NEW gets no invented row
    // (it shows as skipped — one click to serve), so the export is unchanged.
    expect(fixed.stopTimes).toBe(stopTimes);
    expect(fixed.stopTimes.find((st) => st.stop_sequence === 3)).toMatchObject({ stop_id: 'S3', arrival_time: '08:10:00' });
    expect(fixed.stopTimes.some((st) => st.stop_sequence === 4)).toBe(false);
  });

  it('a row at the shared sequence that names the MOVED stop follows it', () => {
    const times = stopTimes.map((st) => (st.stop_sequence === 3 ? { ...st, stop_id: 'NEW' } : st));
    const fixed = repairRouteStops(routeStops, trips, times);
    expect(fixed.stopTimes).not.toBe(times);
    expect(fixed.stopTimes.find((st) => st.stop_id === 'NEW')).toMatchObject({ stop_sequence: 4, arrival_time: '08:10:00' });
    expect(fixed.stopTimes.some((st) => st.stop_sequence === 3)).toBe(false);
  });

  it('after the repair loads, editing S3 no longer changes NEW', () => {
    const fixed = repairRouteStops(routeStops, trips, stopTimes);
    const s = useStore.getState();
    s.setRouteStops(fixed.routeStops);
    s.setTrips(trips);
    s.setStopTimes(fixed.stopTimes);
    s.setStopTime('T1', 'S3', 3, { arrival_time: '08:12:00', departure_time: '08:12:00' });
    expect(timeAt('T1', 3)?.arrival_time).toBe('08:12:00');
    expect(timeAt('T1', 4)).toBeUndefined();
  });

  it('leaves a healthy pattern (including a loop that repeats a stop_id) untouched', () => {
    const loop: RouteStop[] = [
      { route_id: ROUTE, stop_id: 'L1', direction_id: 0, stop_sequence: 1, _snapped: true, shape_id: SHAPE, _uid: 'a' },
      { route_id: ROUTE, stop_id: 'L2', direction_id: 0, stop_sequence: 2, _snapped: true, shape_id: SHAPE, _uid: 'b' },
      { route_id: ROUTE, stop_id: 'L1', direction_id: 0, stop_sequence: 3, _snapped: true, shape_id: SHAPE, _uid: 'c' },
    ];
    const fixed = repairRouteStops(loop, [], []);
    expect(fixed.repaired).toBe(false);
    expect(fixed.routeStops).toBe(loop);
  });

  it('the same sequence in two DIFFERENT patterns is not a collision', () => {
    const two: RouteStop[] = [
      { route_id: ROUTE, stop_id: 'A', direction_id: 0, stop_sequence: 1, _snapped: true, shape_id: 'SH1', _uid: 'a' },
      { route_id: ROUTE, stop_id: 'B', direction_id: 1, stop_sequence: 1, _snapped: true, shape_id: 'SH2', _uid: 'b' },
    ];
    expect(repairRouteStops(two, [], []).repaired).toBe(false);
  });
});
