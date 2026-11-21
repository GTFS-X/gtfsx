// The timepoint value a NEW stop_times row should carry.
//
// A row the editor creates (a stop added to a pattern that already has trips,
// or a time typed into a skipped cell) used to get no timepoint. When the
// trip's other rows carry timepoint values, that blank exports as an empty
// cell in a populated column, which the MobilityData validator reports as
// missing_timepoint_value. So a new row takes the value its timetable column
// shows (the "Key timepoint" toggle): 1 when other trips have the column on,
// 0 when they have it off, and 0 for a brand-new column.
//
// When the trip's other rows carry no timepoint at all, the new row stays
// blank too, so a feed that never used the column isn't given one. Existing
// rows are never touched.
import type { StopTime, Trip } from '../types/gtfs';

type TripKey = Pick<Trip, 'trip_id' | 'route_id' | 'shape_id' | 'direction_id'>;

/** Trips on the same timetable pattern: same route and shape (or, with no
 *  shape, the same direction). Mirrors how the timetable groups trips. */
function samePattern(a: TripKey, b: TripKey): boolean {
  if (a.route_id !== b.route_id) return false;
  return a.shape_id ? a.shape_id === b.shape_id : (!b.shape_id && a.direction_id === b.direction_id);
}

export function groupStopTimesByTrip(stopTimes: readonly StopTime[]): Map<string, StopTime[]> {
  const m = new Map<string, StopTime[]>();
  for (const st of stopTimes) {
    let rows = m.get(st.trip_id);
    if (!rows) { rows = []; m.set(st.trip_id, rows); }
    rows.push(st);
  }
  return m;
}

/**
 * Timepoint for a new row at `stopSequence` on `trip`, or undefined to leave
 * it blank. `rowsByTrip` is the feed's stop_times grouped by trip (see
 * groupStopTimesByTrip), read BEFORE the new row is added.
 */
export function newRowTimepoint(
  trip: TripKey,
  stopSequence: number,
  trips: readonly TripKey[],
  rowsByTrip: ReadonlyMap<string, readonly StopTime[]>,
): 0 | 1 | undefined {
  const own = (rowsByTrip.get(trip.trip_id) ?? []).filter((st) => st.stop_sequence !== stopSequence);
  if (!own.some((st) => st.timepoint === 0 || st.timepoint === 1)) return undefined;

  // The column's explicit setting, from the other trips on the pattern.
  let sawZero = false;
  for (const t of trips) {
    if (t.trip_id === trip.trip_id || !samePattern(trip, t)) continue;
    for (const st of rowsByTrip.get(t.trip_id) ?? []) {
      if (st.stop_sequence !== stopSequence) continue;
      if (st.timepoint === 1) return 1;
      if (st.timepoint === 0) sawZero = true;
    }
  }
  if (sawZero) return 0;

  // A brand-new column starts with Key timepoint off, even when it lands at
  // the end: the editor appends a new stop and the user drags it into place,
  // so an "it's last, so it's a timepoint" guess would follow it into the
  // middle of the route. Writing 0 makes the column show as off, and the
  // user turns it on from the column menu if it is a published time.
  return 0;
}
