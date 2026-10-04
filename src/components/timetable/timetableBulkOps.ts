// Store-level bulk timetable operations, pulled out of TimetableGrid so they can
// be tested without rendering the grid. Each writes through the store's own
// actions; the grid wraps the call in its snapshot-Undo + historyTransaction.
import { useStore } from '../../store';
import { mintTripId } from '../../services/tripNaming';
import type { StopTime, Trip } from '../../types/gtfs';

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
