/**
 * Pure helpers behind the Blocks Gantt's bulk actions (Quick Block / Unblock).
 *
 * Both build the whole next `trips` array in one pass so the caller can commit
 * it with a single `setTrips` (one undo step) instead of one `updateTrip` per
 * trip, which flooded the undo stack.
 */
import type { Frequency, StopTime, Trip } from '../../types/gtfs';
import { findBlockOverlaps } from '../../services/blockBuilder';
import { useStore } from '../../store';
import { historyTransaction } from '../../store/history';

/**
 * Apply a Quick Block assignment (trip_id → block_id) to the trips in scope.
 * A scope trip the builder left out (no timed stop_times, so no span) loses
 * any stale block_id instead of keeping one from an earlier run. Trips outside
 * the scope are untouched. Returns null when nothing changes.
 */
export function applyBlockAssignment(
  trips: readonly Trip[],
  scopeTripIds: ReadonlySet<string>,
  assignment: ReadonlyMap<string, string>,
): Trip[] | null {
  let changed = false;
  const next = trips.map((t) => {
    if (!scopeTripIds.has(t.trip_id)) return t;
    const b = assignment.get(t.trip_id);
    if ((b ?? undefined) === (t.block_id || undefined)) return t;
    changed = true;
    return { ...t, block_id: b };
  });
  return changed ? next : null;
}

/**
 * Commit a block assignment over `scopeTripIds` (an empty assignment clears
 * them) as ONE undo step labelled `label`. Returns false when nothing changed.
 */
export function commitBlockAssignment(
  label: string,
  scopeTripIds: ReadonlySet<string>,
  assignment: ReadonlyMap<string, string>,
): boolean {
  const next = applyBlockAssignment(useStore.getState().trips, scopeTripIds, assignment);
  if (!next) return false;
  historyTransaction(label, () => useStore.getState().setTrips(next));
  return true;
}

/**
 * Trip ids the Blocks list flags as overlapping. Uses the same span and sweep
 * definition as the Gantt (`findBlockOverlaps`) on the fixed trips only:
 * a frequency template stands in for many departures and is never blocked,
 * so it must not be flagged either (C2-22).
 */
export function blockOverlapTripIds(
  trips: Trip[],
  stopTimes: StopTime[],
  frequencies: readonly Frequency[],
): Set<string> {
  const freqTripIds = new Set(frequencies.map((f) => f.trip_id));
  const fixed = freqTripIds.size ? trips.filter((t) => !freqTripIds.has(t.trip_id)) : trips;
  const flagged = new Set<string>();
  for (const o of findBlockOverlaps(fixed, stopTimes)) {
    flagged.add(o.tripA);
    flagged.add(o.tripB);
  }
  return flagged;
}
