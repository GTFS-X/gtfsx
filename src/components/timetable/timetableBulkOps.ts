// Store-level bulk timetable operations, pulled out of TimetableGrid so they can
// be tested without rendering the grid. Each writes through the store's own
// actions; the grid wraps the call in its snapshot-Undo + historyTransaction.
import { useStore } from '../../store';
import { mintTripId } from '../../services/tripNaming';
import { findBlockOverlaps, type BlockOverlap } from '../../services/blockBuilder';
import { gtfsTimeToSeconds, secondsToGtfsTime } from '../../utils/time';
import type { Frequency, StopTime, Trip } from '../../types/gtfs';

/** Copy trips onto another service (the empty-state "Copy from <service>").
 *  Frequency templates keep their windows (C2-10). Returns the new trip ids. */
export function copyTripsToService(
  sourceTrips: readonly Trip[],
  targetServiceId: string,
  prefix: string,
  existingIds: Set<string>,
): string[] {
  const s = useStore.getState();
  const made: string[] = [];
  for (const trip of sourceTrips) {
    const newId = mintTripId(prefix, existingIds);
    existingIds.add(newId);
    s.duplicateTrip(trip.trip_id, newId, 0, { cloneFrequencies: true });
    s.updateTrip(newId, { service_id: targetServiceId });
    made.push(newId);
  }
  return made;
}

/** Repeat one trip `copies` times at `headwayMin` spacing (the Repeat-last
 *  drawer). A frequency template's copies keep its (shifted) windows. */
export function repeatTrip(
  tripId: string,
  headwayMin: number,
  copies: number,
  prefix: string,
  existingIds: Set<string>,
): string[] {
  const s = useStore.getState();
  const made: string[] = [];
  for (let i = 0; i < copies; i++) {
    const newId = mintTripId(prefix, existingIds);
    existingIds.add(newId);
    s.duplicateTrip(tripId, newId, headwayMin * (i + 1), { cloneFrequencies: true });
    made.push(newId);
  }
  return made;
}

/** The continuous pickup/drop-off override for one stop column, as a single
 *  mapped stop_times array: each listed trip's first visit to `stopId` gets
 *  the value. One linear pass (C2-19). `patched` = how many rows changed. */
export function withContinuousOverride(
  stopTimes: readonly StopTime[],
  tripIds: ReadonlySet<string>,
  stopId: string,
  value: 0 | 1 | 2 | 3 | undefined,
): { next: StopTime[]; patched: number } {
  const done = new Set<string>();
  const next = stopTimes.map((st) => {
    if (st.stop_id !== stopId || !tripIds.has(st.trip_id) || done.has(st.trip_id)) return st;
    done.add(st.trip_id);
    return { ...st, continuous_pickup: value, continuous_drop_off: value };
  });
  return { next, patched: done.size };
}

/* ---------- Shift trips (multi-select, whole-trip time shift) ---------- */

/** Largest shift the drawer accepts, in minutes, either way. A day: anything
 *  bigger is almost certainly a typo. */
export const SHIFT_MAX_MIN = 24 * 60;

export type ShiftPlan =
  | {
    ok: true;
    stopTimes: StopTime[];
    frequencies: Frequency[];
    /** Selected trips that exist in the feed (each is shifted). */
    tripCount: number;
    /** stop_times rows rewritten (rows with a time; blank ones stay blank). */
    stopTimeCount: number;
    /** frequencies.txt windows moved with their template trip. */
    windowCount: number;
  }
  | { ok: false; error: string; offendingTripIds: string[] };

const shiftTime = (t: string, deltaSecs: number): string =>
  (t ? secondsToGtfsTime(gtfsTimeToSeconds(t) + deltaSecs) : t);

/** Shift every arrival/departure of `tripIds` by `deltaMin` minutes, plus the
 *  start/end of any frequencies.txt window whose template is one of them (the
 *  same rule Duplicate / Repeat use for frequency templates: the windows move
 *  with the trip, or its build-out departures would not move at all).
 *
 *  Pure: returns whole new arrays; untouched rows keep their identity. Blank
 *  (interpolated) times stay blank. Times past 24:00:00 are ordinary GTFS
 *  times and shift like any other (23:55 + 10 min = 24:05:00). A shift that
 *  would take any time below 00:00:00 is REJECTED, never clamped: clamping
 *  would squash the trip's run time and silently change its schedule. */
export function planShiftTrips(
  stopTimes: readonly StopTime[],
  frequencies: readonly Frequency[],
  tripIds: ReadonlySet<string>,
  deltaMin: number,
  knownTripIds?: ReadonlySet<string>,
): ShiftPlan {
  if (tripIds.size === 0) return { ok: false, error: 'Select at least one trip to shift.', offendingTripIds: [] };
  if (!Number.isFinite(deltaMin) || !Number.isInteger(deltaMin)) {
    return { ok: false, error: 'Enter a whole number of minutes.', offendingTripIds: [] };
  }
  if (deltaMin === 0) return { ok: false, error: 'Enter a shift other than 0 minutes.', offendingTripIds: [] };
  if (Math.abs(deltaMin) > SHIFT_MAX_MIN) {
    return { ok: false, error: `Shift by at most ${SHIFT_MAX_MIN} minutes (24 hours) either way.`, offendingTripIds: [] };
  }
  const deltaSecs = deltaMin * 60;

  // Only an earlier shift can go negative: check each selected trip's earliest
  // time across its stop_times AND its frequency windows.
  if (deltaSecs < 0) {
    const earliest = new Map<string, number>();
    const note = (id: string, t: string) => {
      if (!t) return;
      const v = gtfsTimeToSeconds(t);
      const cur = earliest.get(id);
      if (cur === undefined || v < cur) earliest.set(id, v);
    };
    for (const st of stopTimes) {
      if (!tripIds.has(st.trip_id)) continue;
      note(st.trip_id, st.arrival_time);
      note(st.trip_id, st.departure_time);
    }
    for (const f of frequencies) {
      if (tripIds.has(f.trip_id)) note(f.trip_id, f.start_time);
    }
    const offending = [...earliest].filter(([, v]) => v + deltaSecs < 0).map(([id]) => id);
    if (offending.length > 0) {
      const n = offending.length;
      return {
        ok: false,
        offendingTripIds: offending,
        error: `${n} trip${n === 1 ? '' : 's'} would start before 00:00 (${offending.slice(0, 3).join(', ')}${n > 3 ? '…' : ''}). Shift by less, or deselect ${n === 1 ? 'it' : 'them'}.`,
      };
    }
  }

  let stopTimeCount = 0;
  const nextStopTimes = stopTimes.map((st) => {
    if (!tripIds.has(st.trip_id) || (!st.arrival_time && !st.departure_time)) return st;
    stopTimeCount += 1;
    return { ...st, arrival_time: shiftTime(st.arrival_time, deltaSecs), departure_time: shiftTime(st.departure_time, deltaSecs) };
  });
  let windowCount = 0;
  const nextFrequencies = frequencies.map((f) => {
    if (!tripIds.has(f.trip_id)) return f;
    windowCount += 1;
    return { ...f, start_time: shiftTime(f.start_time, deltaSecs), end_time: shiftTime(f.end_time, deltaSecs) };
  });
  const tripCount = knownTripIds ? [...tripIds].filter((id) => knownTripIds.has(id)).length : tripIds.size;
  return { ok: true, stopTimes: nextStopTimes, frequencies: nextFrequencies, tripCount, stopTimeCount, windowCount };
}

/** Block overlaps that exist AFTER a shift but not before it. The shift never
 *  reassigns a block_id, so it can leave one vehicle running two trips at
 *  once; this names those cases. Same overlap rule as the Blocks Gantt and the
 *  pre-publish validator (`findBlockOverlaps`); frequency templates are
 *  excluded there too (they can't sit on a block). */
export function newBlockOverlaps(
  trips: readonly Trip[],
  frequencies: readonly Frequency[],
  before: readonly StopTime[],
  after: readonly StopTime[],
): BlockOverlap[] {
  const freqIds = new Set(frequencies.map((f) => f.trip_id));
  const fixed = trips.filter((t) => t.block_id && !freqIds.has(t.trip_id));
  if (fixed.length === 0) return [];
  const key = (o: BlockOverlap) => [o.blockId, o.serviceId, ...[o.tripA, o.tripB].sort()].join('\u0000');
  const had = new Set(findBlockOverlaps(fixed, [...before]).map(key));
  return findBlockOverlaps(fixed, [...after]).filter((o) => !had.has(key(o)));
}

/** Apply a shift through the store: ONE stop_times write (+ one frequencies
 *  write when a template is selected). The grid wraps this in withUndo
 *  (snapshot Undo toast + a single historyTransaction), so Ctrl+Z and the
 *  toast's Undo both revert the whole shift. */
export function shiftTrips(tripIds: ReadonlySet<string>, deltaMin: number): ShiftPlan {
  const s = useStore.getState();
  const plan = planShiftTrips(s.stopTimes, s.frequencies, tripIds, deltaMin, new Set(s.trips.map((t) => t.trip_id)));
  if (!plan.ok) return plan;
  s.setStopTimes(plan.stopTimes);
  if (plan.windowCount > 0) s.setFrequencies(plan.frequencies);
  return plan;
}
