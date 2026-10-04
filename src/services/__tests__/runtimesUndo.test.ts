// S2-04: pattern-wide run time / estimate is ONE undo step. S2-05: run time
// never writes a stop_sequence a trip lacks and never moves a short-turn start.
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../store';
import { historyDepths, resetHistory, undo } from '../../store/history';
import { applyPatternEstimate, applyPatternRunTime } from '../runtimes';
import type { RouteStop, StopTime, Trip } from '../../types/gtfs';

const N_STOPS = 30;
const N_TRIPS = 20;
const toT = (s: number) =>
  `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

beforeEach(() => {
  const s = useStore.getState();
  const rs: RouteStop[] = Array.from({ length: N_STOPS }, (_, i) => (
    { route_id: 'R', stop_id: `s${i + 1}`, direction_id: 0, stop_sequence: i + 1, _snapped: false }));
  s.setRoutes([{ route_id: 'R', agency_id: 'A', route_short_name: 'R', route_long_name: '', route_type: 3, route_color: '000000', route_text_color: 'FFFFFF' }]);
  s.setRouteStops(rs);
  s.setShapes([]);
  s.setStops(rs.map((r, i) => ({ stop_id: r.stop_id, stop_name: r.stop_id, stop_lat: 45 + i * 0.001, stop_lon: -111, location_type: 0, wheelchair_boarding: 0 })));
  const trips: Trip[] = [];
  const times: StopTime[] = [];
  for (let t = 0; t < N_TRIPS; t++) {
    trips.push({ trip_id: `t${t}`, route_id: 'R', service_id: 'WK', direction_id: 0 });
    for (let i = 0; i < N_STOPS; i++) {
      const sec = 6 * 3600 + t * 1800 + i * 60;
      times.push({ trip_id: `t${t}`, stop_id: `s${i + 1}`, stop_sequence: i + 1, arrival_time: toT(sec), departure_time: toT(sec) });
    }
  }
  s.setTrips(trips);
  s.setStopTimes(times);
  resetHistory();
});

describe('pattern-wide re-timing is one undo step (S2-04)', () => {
  it('applyPatternEstimate: undo depth +1, one undo restores every row', () => {
    const before = useStore.getState().stopTimes;
    const n = applyPatternEstimate(
      { routeId: 'R', directionId: 0 },
      Array.from({ length: N_STOPS }, (_, i) => ({ stopId: `s${i + 1}`, seq: i + 1 })),
      Array.from({ length: N_STOPS }, (_, i) => i * 90),
      { dwellSec: 0, speedFactor: 1 },
    );
    expect(n).toBe(N_TRIPS);
    expect(historyDepths().undo).toBe(1);
    expect(useStore.getState().stopTimes).not.toEqual(before);
    expect(undo()).toBe('estimate run times');
    expect(useStore.getState().stopTimes).toEqual(before);
  });

  it('applyPatternRunTime: undo depth +1', () => {
    applyPatternRunTime({ routeId: 'R', directionId: 0 }, 60 * 60);
    expect(historyDepths().undo).toBe(1);
  });
});

describe('run time on a short-turn trip (S2-05)', () => {
  it('writes no missing sequence and keeps the first timed time', () => {
    const s = useStore.getState();
    // t0 serves only seq 3..10.
    s.setStopTimes(s.stopTimes.filter((x) => x.trip_id !== 't0' || (x.stop_sequence >= 3 && x.stop_sequence <= 10)));
    const rowsBefore = useStore.getState().stopTimes.filter((x) => x.trip_id === 't0');
    const firstBefore = rowsBefore.find((x) => x.stop_sequence === 3)!.departure_time;
    applyPatternRunTime({ routeId: 'R', directionId: 0 }, 29 * 120);
    const rows = useStore.getState().stopTimes.filter((x) => x.trip_id === 't0');
    expect(rows).toHaveLength(rowsBefore.length);
    expect(rows.some((x) => x.stop_sequence === 1 || x.stop_sequence === 30)).toBe(false);
    expect(rows.find((x) => x.stop_sequence === 3)!.departure_time).toBe(firstBefore);
    // 7 of 29 pattern segments at 2 min each = 14 min.
    const last = rows.find((x) => x.stop_sequence === 10)!;
    expect(last.arrival_time).toBe(toT(6 * 3600 + 2 * 60 + 14 * 60));
  });
});
