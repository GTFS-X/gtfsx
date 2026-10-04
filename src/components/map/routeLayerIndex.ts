import type { Route, Trip } from '../../types/gtfs';

/**
 * shape_id → the first trip (feed order) that uses it. Same answer as
 * `trips.find((t) => t.shape_id === id)`, built once per trips change instead
 * of a linear scan per shape on every map re-render.
 */
export function firstTripByShape(trips: readonly Trip[]): Map<string, Trip> {
  const m = new Map<string, Trip>();
  for (const t of trips) {
    if (t.shape_id && !m.has(t.shape_id)) m.set(t.shape_id, t);
  }
  return m;
}

/** route_id → route (first wins, like `routes.find`). */
export function routesById(routes: readonly Route[]): Map<string, Route> {
  const m = new Map<string, Route>();
  for (const r of routes) if (!m.has(r.route_id)) m.set(r.route_id, r);
  return m;
}
