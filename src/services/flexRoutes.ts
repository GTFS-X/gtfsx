import type { FlexZone } from '../store/flexSlice';
import type { Trip } from '../types/gtfs';

/**
 * True when `routeId` exists only to carry ONE flex zone: no fixed-route trip
 * runs on it (synthetic flex trips are stripped on import and regenerated on
 * export, so they never appear in `trips`) and exactly one zone points at it.
 *
 * Only such a route may be hidden from the Routes list, renamed with its zone,
 * or deleted along with its zone. A route that also carries fixed trips (a
 * mixed fixed + flex route) or is shared by several zones is a real route and
 * must be left alone.
 */
export function isFlexOnlyRoute(
  state: { trips: readonly Pick<Trip, 'route_id'>[]; flexZones: readonly Pick<FlexZone, 'routeId'>[] },
  routeId: string | undefined,
): boolean {
  if (!routeId) return false;
  if (state.trips.some((t) => t.route_id === routeId)) return false;
  let zones = 0;
  for (const z of state.flexZones) if (z.routeId === routeId) zones++;
  return zones === 1;
}

/** The ids of every flex-only route (see isFlexOnlyRoute), in one pass. */
export function flexOnlyRouteIds(
  state: { trips: readonly Pick<Trip, 'route_id'>[]; flexZones: readonly Pick<FlexZone, 'routeId'>[] },
): Set<string> {
  const zoneCount = new Map<string, number>();
  for (const z of state.flexZones) {
    if (z.routeId) zoneCount.set(z.routeId, (zoneCount.get(z.routeId) ?? 0) + 1);
  }
  const withTrips = new Set(state.trips.map((t) => t.route_id));
  const out = new Set<string>();
  for (const [id, n] of zoneCount) if (n === 1 && !withTrips.has(id)) out.add(id);
  return out;
}
