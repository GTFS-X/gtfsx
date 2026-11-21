// Pure helpers for trips.wheelchair_accessible (kept out of the .tsx so they
// can be unit-tested without a DOM).
import type { Trip } from '../../types/gtfs';

export interface TripWheelchairSummary {
  accessible: number;
  notAccessible: number;
  /** 0, blank, or any value outside the spec: all read as "no information". */
  unknown: number;
}

export function summarizeTripWheelchair(trips: readonly Trip[]): TripWheelchairSummary {
  const out: TripWheelchairSummary = { accessible: 0, notAccessible: 0, unknown: 0 };
  for (const t of trips) {
    if (t.wheelchair_accessible === 1) out.accessible += 1;
    else if (t.wheelchair_accessible === 2) out.notAccessible += 1;
    else out.unknown += 1;
  }
  return out;
}

/** The trip's value as one of the spec's three, for a picker. */
export function tripWheelchairValue(trip: Trip): 0 | 1 | 2 {
  return trip.wheelchair_accessible === 1 || trip.wheelchair_accessible === 2 ? trip.wheelchair_accessible : 0;
}
