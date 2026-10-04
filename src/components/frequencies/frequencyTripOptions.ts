import type { Route, Trip } from '../../types/gtfs';

export interface TripOptions {
  /** trip_id → "Route · headsign" label. */
  labelById: Map<string, string>;
  /** Picker options, sorted by label. */
  options: { value: string; label: string }[];
}

/**
 * Trip labels and picker options for the frequencies editor, built in one
 * linear pass over Map lookups. The previous per-render `trips.find` +
 * `routes.find` per option was O(T² + T·R) and froze large feeds (C2-18).
 */
export function buildTripOptions(trips: readonly Trip[], routes: readonly Route[]): TripOptions {
  const routeById = new Map(routes.map((r) => [r.route_id, r]));
  const labelById = new Map<string, string>();
  for (const t of trips) {
    if (labelById.has(t.trip_id)) continue;
    const r = routeById.get(t.route_id);
    const rn = r?.route_short_name || r?.route_long_name || t.route_id;
    labelById.set(t.trip_id, `${rn} · ${t.trip_headsign || t.trip_id}`);
  }
  const options = [...labelById]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return { labelById, options };
}
