import { flexOnlyRouteIds } from '../../services/flexRoutes';
import type { FareAttribute, FareProduct, Route, Trip } from '../../types/gtfs';
import type { FlexZone } from '../../store/flexSlice';

/** Routes-panel badge: every route except flex-only ones, which live in the
 *  Flex Zones panel. A mixed fixed + flex route is a real route and counts
 *  (C3-04), matching the Routes list. */
export function visibleRouteCount(state: {
  routes: readonly Pick<Route, 'route_id'>[];
  trips: readonly Pick<Trip, 'route_id'>[];
  flexZones: readonly Pick<FlexZone, 'routeId'>[];
}): number {
  const hidden = flexOnlyRouteIds(state);
  let n = 0;
  for (const r of state.routes) if (!hidden.has(r.route_id)) n++;
  return n;
}

/** Fares badge: v1 fares plus distinct Fares v2 products (C3-27; a v2-only
 *  feed used to show 0). A product with adult and senior rows counts once. */
export function fareCount(state: {
  fareAttributes: readonly Pick<FareAttribute, 'fare_id'>[];
  fareProducts?: readonly Pick<FareProduct, 'fare_product_id'>[];
}): number {
  const products = new Set((state.fareProducts ?? []).map((p) => p.fare_product_id));
  return state.fareAttributes.length + products.size;
}
