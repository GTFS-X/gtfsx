/**
 * B2 — pattern running times.
 *
 * Let a planner set the scheduled running time of a (route, direction, shape)
 * pattern and re-lay every trip on it to that run time WITHOUT moving any
 * trip's start — so headways stay intact. Intermediate stops are re-interpolated
 * (distance-aware) via the store's interpolateStopTimes.
 *
 * Manual only — no AVL. This is the editable-runtime layer the generated
 * timetable (B1) and the blocks (B3) reflect.
 */
import { useStore } from '../store';
import { gtfsTimeToSeconds, secondsToGtfsTime } from '../utils/time';
import { layoutStopTimes } from './travelTime';
import { historyTransaction } from '../store/history';
import type { RouteStop, StopTime } from '../types/gtfs';

export interface PatternRef {
  routeId: string;
  directionId: 0 | 1;
  shapeId?: string;
  /** Limit to one service day-type; omit to apply to every trip on the pattern. */
  serviceId?: string;
}

function patternRouteStops(routeId: string, directionId: 0 | 1, shapeId?: string): RouteStop[] {
  const rs = useStore.getState().routeStops.filter(
    (r) => r.route_id === routeId && r.direction_id === directionId && (shapeId ? r.shape_id === shapeId : true),
  );
  return [...rs].sort((a, b) => a.stop_sequence - b.stop_sequence);
}

function patternTrips(ref: PatternRef) {
  return useStore.getState().trips.filter(
    (t) => t.route_id === ref.routeId
      && t.direction_id === ref.directionId
      && (ref.shapeId ? t.shape_id === ref.shapeId : true)
      && (ref.serviceId ? t.service_id === ref.serviceId : true),
  );
}

/** The earliest set time (start) of a trip, in seconds, or null. */
function tripStartSec(times: StopTime[]): number | null {
  const ordered = [...times].sort((a, b) => a.stop_sequence - b.stop_sequence);
  const t = ordered.find((st) => st.arrival_time || st.departure_time);
  return t ? gtfsTimeToSeconds(t.departure_time || t.arrival_time) : null;
}

/** Current run time (first→last stop, seconds) of the pattern, read from the
 *  earliest-departing trip — the default shown in the editor. null if unknown. */
export function currentPatternRunSecs(ref: PatternRef): number | null {
  const trips = patternTrips(ref);
  const allTimes = useStore.getState().stopTimes;
  let best: { start: number; run: number } | null = null;
  for (const trip of trips) {
    const times = allTimes.filter((st) => st.trip_id === trip.trip_id && (st.arrival_time || st.departure_time));
    if (times.length < 2) continue;
    const ordered = [...times].sort((a, b) => a.stop_sequence - b.stop_sequence);
    const start = gtfsTimeToSeconds(ordered[0].departure_time || ordered[0].arrival_time);
    const end = gtfsTimeToSeconds(ordered[ordered.length - 1].arrival_time || ordered[ordered.length - 1].departure_time);
    if (end <= start) continue;
    if (!best || start < best.start) best = { start, run: end - start };
  }
  return best?.run ?? null;
}

/**
 * Apply a new total run time (seconds) to every trip on the pattern, keeping
 * each trip's start time fixed (headways preserved) and re-interpolating
 * intermediate stops. Returns the number of trips updated.
 */
export function applyPatternRunTime(ref: PatternRef, runSecs: number): number {
  if (!(runSecs > 0)) return 0;
  const trips = patternTrips(ref);
  const byTrip = stopTimesByTrip(trips.map((t) => t.trip_id));

  // Per trip: keep its OWN first timed row, re-time its OWN last row (timed
  // if it has two, else its last served row) to start + the share of the run
  // its span covers along the pattern, and leave every other row to the
  // interpolation. A row the trip doesn't have (a short-turn's missing
  // endpoint, a skipped stop) is never written, so nothing is un-skipped and a
  // short-turn's start never moves.
  const plans: { tripId: string; last: StopTime; endSec: number }[] = [];
  for (const trip of trips) {
    const rows = [...(byTrip.get(trip.trip_id) ?? [])].sort((a, b) => a.stop_sequence - b.stop_sequence);
    const timedRows = rows.filter((r) => r.arrival_time || r.departure_time);
    if (timedRows.length === 0 || rows.length < 2) continue;
    const first = timedRows[0];
    const last = timedRows.length > 1 ? timedRows[timedRows.length - 1] : rows[rows.length - 1];
    if (last.stop_sequence <= first.stop_sequence) continue;
    const start = gtfsTimeToSeconds(first.departure_time || first.arrival_time);
    // The trip's own shape pattern when the caller didn't pin one.
    const rs = patternRouteStops(ref.routeId, ref.directionId, ref.shapeId ?? trip.shape_id);
    const pos = (seq: number) => rs.findIndex((r) => r.stop_sequence === seq);
    const span = rs.length >= 2 ? rs.length - 1 : 0;
    const pf = pos(first.stop_sequence);
    const pl = pos(last.stop_sequence);
    const frac = span > 0 && pf >= 0 && pl > pf ? (pl - pf) / span : 1;
    plans.push({ tripId: trip.trip_id, last, endSec: start + Math.round(runSecs * frac) });
  }
  if (plans.length === 0) return 0;

  historyTransaction('set run time', () => {
    const ends = new Map(plans.map((p) => [`${p.tripId}\u0000${p.last.stop_sequence}`, p.endSec]));
    const s = useStore.getState();
    s.setStopTimes(s.stopTimes.map((row) => {
      const end = ends.get(`${row.trip_id}\u0000${row.stop_sequence}`);
      if (end === undefined) return row;
      const t = secondsToGtfsTime(end);
      return { ...row, arrival_time: t, departure_time: t };
    }));
    for (const p of plans) useStore.getState().interpolateStopTimes(p.tripId);
  });
  return plans.length;
}

/** stop_times for the given trips, in one pass. */
function stopTimesByTrip(tripIds: string[]): Map<string, StopTime[]> {
  const want = new Set(tripIds);
  const out = new Map<string, StopTime[]>();
  for (const st of useStore.getState().stopTimes) {
    if (!want.has(st.trip_id)) continue;
    const arr = out.get(st.trip_id);
    if (arr) arr.push(st); else out.set(st.trip_id, [st]);
  }
  return out;
}

/**
 * Lay every trip on the pattern from a road-network travel profile — the same
 * estimation the per-trip ◷ Estimate uses, applied pattern-wide. `cumSecs` is the
 * cumulative road-travel seconds per ordered stop (from estimateStopTravelByRoad)
 * and MUST align index-for-index with `orderedStops`. Each trip keeps its own
 * start time; skips are honored (only stops the trip already times are written).
 * Returns the number of trips updated. No estimation math here — pure plumbing
 * over layoutStopTimes.
 */
export function applyPatternEstimate(
  ref: PatternRef,
  orderedStops: { stopId: string; seq: number }[],
  cumSecs: number[],
  opts: { dwellSec: number; speedFactor: number },
): number {
  if (orderedStops.length < 2 || cumSecs.length !== orderedStops.length) return 0;
  const dwellSec = Math.max(0, opts.dwellSec);
  const speedFactor = Math.max(0.1, opts.speedFactor);
  const trips = patternTrips(ref);
  const byTrip = stopTimesByTrip(trips.map((t) => t.trip_id));
  const seqIndex = new Map(orderedStops.map((os, i) => [os.seq, i]));

  // Build every new time first, then commit ONCE (one undo step, and no
  // per-row findIndex scans over the whole stop_times table).
  const updates = new Map<string, { arrival_time: string; departure_time: string }>();
  let updated = 0;
  for (const trip of trips) {
    const times = byTrip.get(trip.trip_id) ?? [];
    const start = tripStartSec(times);
    if (start == null) continue;
    const timings = layoutStopTimes(cumSecs, { startSec: start, dwellSec, speedFactor });
    let changed = false;
    for (const row of times) {
      const i = seqIndex.get(row.stop_sequence);
      if (i === undefined) continue; // skip-aware: only rows the trip already has
      updates.set(`${trip.trip_id}\u0000${row.stop_sequence}`, {
        arrival_time: secondsToGtfsTime(timings[i].arrivalSec),
        departure_time: secondsToGtfsTime(timings[i].departureSec),
      });
      changed = true;
    }
    if (changed) updated++;
  }
  if (updates.size === 0) return 0;
  historyTransaction('estimate run times', () => {
    const s = useStore.getState();
    s.setStopTimes(s.stopTimes.map((row) => {
      const u = updates.get(`${row.trip_id}\u0000${row.stop_sequence}`);
      return u ? { ...row, ...u } : row;
    }));
  });
  return updated;
}
