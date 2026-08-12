// Regression: stop_times whose stop_sequence the route's stop list doesn't
// cover are invisible to the timetable AND unreachable by every column-scoped
// write, so a re-time silently leaves them stale and the STORED trip runs
// backwards while the grid still renders a clean, monotonic row.
//
// Reproduced from Mark's `sunny-valley-transit-copy` project (route 6852,
// direction 0, shape 28769): route_stops covered stop_sequences 0–10 because
// the importer derived them from the FIRST trip of the direction, an 11-stop
// short-turn. The other 16 trips on the same shape ran sequences 0–16, so their
// last six rows had no column — 169 orphan rows across 44 trips in that one
// project. Re-timing the pattern rewrote 0–10 and left 11–16 at the old hour,
// producing trips that "arrive" two hours before they depart. Duplicating such
// a trip (Repeat last trip) then copies the skew forward verbatim.
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../store';
import { applyPatternRunTime } from '../runtimes';
import { backfillMissingRouteStops } from '../routeStopMigration';
import { gtfsTimeToSeconds } from '../../utils/time';
import type { RouteStop, Stop, StopTime, Trip } from '../../types/gtfs';

const ROUTE = 'R6852';
const SHAPE = 'S28769';

/** The full run the real trips serve: sequences 0–16 (1–4 are never served —
 *  the pattern skips them, exactly as in the source feed). */
const LONG_SEQS = [0, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
/** The short-turn the importer happened to see first: sequences 0–10. */
const SHORT_SEQS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

const hhmmss = (sec: number) =>
  `${String(Math.floor(sec / 3600)).padStart(2, '0')}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;

const stops: Stop[] = Array.from({ length: 17 }, (_, i) => ({
  stop_id: `st${i}`, stop_name: `Stop ${i}`, stop_lat: 45 + i * 0.01, stop_lon: -111, wheelchair_boarding: 0,
} as Stop));

/** route_stops as the importer builds them: one canonical trip's rows only. */
const importedRouteStops: RouteStop[] = SHORT_SEQS.map((seq) => ({
  route_id: ROUTE, stop_id: `st${seq}`, direction_id: 0 as const,
  stop_sequence: seq, _snapped: true, shape_id: SHAPE,
}));

function tripTimes(id: string, seqs: number[], startSec: number): StopTime[] {
  return seqs.map((seq, i) => ({
    trip_id: id, stop_id: `st${seq}`, stop_sequence: seq,
    arrival_time: hhmmss(startSec + i * 120), departure_time: hhmmss(startSec + i * 120),
  }));
}

const trip = (id: string): Trip => ({
  trip_id: id, route_id: ROUTE, service_id: 'wk', direction_id: 0, shape_id: SHAPE,
} as Trip);

const trips = [trip('short-1'), trip('long-1')];
const stopTimes = [
  ...tripTimes('short-1', SHORT_SEQS, 6 * 3600 + 48 * 60), // 06:48
  ...tripTimes('long-1', LONG_SEQS, 7 * 3600 + 6 * 60),    // 07:06 → 07:30
];

/** Seed the store the way a load does. `migrated` mirrors the real load paths
 *  (persistence / serverPersistence / myFeedsImport), which run the backfill;
 *  `false` is the raw saved state those paths used to apply verbatim. */
function seedFeed(migrated: boolean) {
  const s = useStore.getState();
  s.setRoutes([{ route_id: ROUTE, route_short_name: 'Purple', route_long_name: 'Purple', route_type: 3 } as never]);
  s.setStops(stops as never);
  s.setShapes([]);
  s.setTrips(trips.map((t) => ({ ...t })));
  s.setStopTimes(stopTimes.map((st) => ({ ...st })) as StopTime[]);
  s.setRouteStops((migrated
    ? backfillMissingRouteStops(importedRouteStops, trips, stopTimes)
    : importedRouteStops) as never);
}

/** The stop_sequences the timetable renders a column for: route_stops of the
 *  selected pattern. Mirrors useTimetableData's `orderedStops`. */
function renderedSeqs(): number[] {
  return useStore.getState().routeStops
    .filter((rs) => rs.route_id === ROUTE && rs.shape_id === SHAPE)
    .map((rs) => rs.stop_sequence)
    .sort((a, b) => a - b);
}

/** Rows a trip stores that the grid has no column for — invisible to the user
 *  and untouched by every column-scoped write. */
function hiddenSeqs(tripId: string): number[] {
  const shown = new Set(renderedSeqs());
  return useStore.getState().stopTimes
    .filter((st) => st.trip_id === tripId && !shown.has(st.stop_sequence))
    .map((st) => st.stop_sequence)
    .sort((a, b) => a - b);
}

function storedTimes(tripId: string): StopTime[] {
  return useStore.getState().stopTimes
    .filter((st) => st.trip_id === tripId)
    .sort((a, b) => a.stop_sequence - b.stop_sequence);
}

/** The GTFS invariant: times never go backwards along a trip. */
function isMonotonic(tripId: string): boolean {
  const secs = storedTimes(tripId)
    .filter((st) => st.arrival_time)
    .map((st) => gtfsTimeToSeconds(st.arrival_time));
  return secs.every((s, i) => i === 0 || s >= secs[i - 1]);
}

const retime = () => applyPatternRunTime({ routeId: ROUTE, directionId: 0, shapeId: SHAPE }, 30 * 60);

describe('the defect: route_stops that do not cover every stop_time', () => {
  beforeEach(() => seedFeed(false));

  it('hides the uncovered rows from the timetable entirely', () => {
    expect(renderedSeqs()).toEqual(SHORT_SEQS);
    expect(hiddenSeqs('long-1')).toEqual([11, 12, 13, 14, 15, 16]);
  });

  it('corrupts the stored trip on a pattern re-time, leaving the grid looking right', () => {
    expect(isMonotonic('long-1')).toBe(true); // healthy to begin with
    retime();

    // The write covered sequences 0–10 only; the last six rows kept the
    // ORIGINAL times, so the stored trip now arrives before it departs.
    const stored = storedTimes('long-1');
    expect(isMonotonic('long-1')).toBe(false);
    expect(stored.find((st) => st.stop_sequence === 10)!.arrival_time).toBe('07:36:00');
    expect(stored.find((st) => st.stop_sequence === 11)!.arrival_time).toBe('07:20:00');

    // ...while every cell the grid actually RENDERS is still monotonic — which
    // is why this is invisible in the editor and only shows up on export.
    const shown = new Set(renderedSeqs());
    const rendered = stored.filter((st) => shown.has(st.stop_sequence))
      .map((st) => gtfsTimeToSeconds(st.arrival_time));
    expect(rendered.every((s, i) => i === 0 || s >= rendered[i - 1])).toBe(true);
  });

  it('is propagated verbatim by duplicateTrip — Repeat copies it, never causes it', () => {
    retime();
    useStore.getState().duplicateTrip('long-1', 'long-1-copy', 60);

    // Every row shifts by exactly the same offset, so a duplicate can only ever
    // inherit a skew that already existed in its source.
    const src = storedTimes('long-1');
    const copy = storedTimes('long-1-copy');
    expect(copy.map((st) => st.stop_sequence)).toEqual(src.map((st) => st.stop_sequence));
    for (let i = 0; i < src.length; i++) {
      expect(gtfsTimeToSeconds(copy[i].arrival_time) - gtfsTimeToSeconds(src[i].arrival_time)).toBe(3600);
    }
    expect(isMonotonic('long-1-copy')).toBe(false); // inherited, not introduced
  });
});

describe('the fix: loading backfills route_stops for every stop_time', () => {
  beforeEach(() => seedFeed(true));

  it('gives every stored stop_time a timetable column', () => {
    expect(renderedSeqs()).toEqual([...new Set([...SHORT_SEQS, ...LONG_SEQS])].sort((a, b) => a - b));
    expect(hiddenSeqs('long-1')).toEqual([]);
    expect(hiddenSeqs('short-1')).toEqual([]);
  });

  it('keeps the whole trip monotonic through a pattern re-time', () => {
    retime();
    expect(isMonotonic('long-1')).toBe(true);
    expect(isMonotonic('short-1')).toBe(true);
    // The re-time now spans the trip's real endpoints: 30 min from 07:06.
    const stored = storedTimes('long-1');
    expect(stored[0].departure_time).toBe('07:06:00');
    expect(stored[stored.length - 1].arrival_time).toBe('07:36:00');
  });

  it('keeps a duplicate of a re-timed trip monotonic', () => {
    retime();
    useStore.getState().duplicateTrip('long-1', 'long-1-copy', 60);
    expect(isMonotonic('long-1-copy')).toBe(true);
  });
});

describe('backfillMissingRouteStops', () => {
  it('leaves a pattern that already covers its trips untouched (same reference)', () => {
    const covered = backfillMissingRouteStops(importedRouteStops, [trip('short-1')], [
      ...tripTimes('short-1', SHORT_SEQS, 6 * 3600),
    ]);
    expect(covered).toBe(importedRouteStops);
  });

  it('never invents a pattern for a direction that has no route_stops', () => {
    // removeRouteStop cascades into stop_times, so an empty stop list is a
    // deliberate state — refilling it would resurrect deleted stops.
    const other = [{ ...trip('long-1'), route_id: 'R-other' }];
    expect(backfillMissingRouteStops(importedRouteStops, other, [
      ...tripTimes('long-1', LONG_SEQS, 7 * 3600),
    ])).toBe(importedRouteStops);
  });

  it('tags added stops with the pattern they extend, not a new shape', () => {
    const added = backfillMissingRouteStops(importedRouteStops, trips, stopTimes)
      .filter((rs) => !SHORT_SEQS.includes(rs.stop_sequence));
    expect(added.map((rs) => rs.stop_sequence)).toEqual([11, 12, 13, 14, 15, 16]);
    expect(added.every((rs) => rs.shape_id === SHAPE)).toBe(true);
    expect(added.every((rs) => rs.direction_id === 0)).toBe(true);
    expect(added.map((rs) => rs.stop_id)).toEqual(['st11', 'st12', 'st13', 'st14', 'st15', 'st16']);
  });

  it('does not duplicate a sequence two trips share', () => {
    const twoLong = [trip('long-1'), trip('long-2')];
    const out = backfillMissingRouteStops(importedRouteStops, twoLong, [
      ...tripTimes('long-1', LONG_SEQS, 7 * 3600),
      ...tripTimes('long-2', LONG_SEQS, 8 * 3600),
    ]);
    const seqs = out.map((rs) => rs.stop_sequence);
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});
