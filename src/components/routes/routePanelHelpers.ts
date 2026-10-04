// Pure helpers behind the route detail tabs, kept out of the .tsx files so
// they can be unit-tested without a DOM.
import { useStore } from '../../store';
import { deriveRouteShapeIds } from '../../services/routeShapes';
import { flexOnlyRouteIds } from '../../services/flexRoutes';
import { gtfsTimeToSeconds } from '../../utils/time';
import { historyTransaction } from '../../store/history';
import { primeShapeEditSnapshot } from '../map/mapInteractions';
import type { Calendar, Route, RouteStop, Shape, ShapePoint, Stop, StopTime, Trip } from '../../types/gtfs';
import type { FlexZone } from '../../store/flexSlice';
import type { RouteDetailTab } from '../../types/ui';

export type Bounds = [[number, number], [number, number]];

function expandBounds(b: Bounds | null, lng: number, lat: number): Bounds {
  if (!b) return [[lng, lat], [lng, lat]];
  return [
    [Math.min(b[0][0], lng), Math.min(b[0][1], lat)],
    [Math.max(b[1][0], lng), Math.max(b[1][1], lat)],
  ];
}

function isValidBounds(b: Bounds | null): b is Bounds {
  if (!b) return false;
  return b[0][0] !== b[1][0] || b[0][1] !== b[1][1];
}

/** The map fit for a route detail tab: its stops on the Stops tab, otherwise
 *  the geometry of every shape that belongs to the route (trips, route_stops
 *  and freshly drawn `_route_id` shapes, via deriveRouteShapeIds). Null when
 *  there is nothing to fit yet. */
export function routeFitBounds(
  routeId: string,
  tab: RouteDetailTab,
  data: { shapes: Shape[]; trips: Trip[]; stops: Stop[]; routeStops: RouteStop[] },
): Bounds | null {
  let bounds: Bounds | null = null;
  if (tab === 'stops') {
    const stopIds = new Set(
      data.routeStops.filter((rs) => rs.route_id === routeId).map((rs) => rs.stop_id),
    );
    for (const s of data.stops) {
      if (stopIds.has(s.stop_id)) bounds = expandBounds(bounds, s.stop_lon, s.stop_lat);
    }
  } else {
    const shapeIds = new Set(deriveRouteShapeIds(routeId, data.trips, data.routeStops, data.shapes));
    for (const sh of data.shapes) {
      if (!shapeIds.has(sh.shape_id)) continue;
      for (const p of sh.points) bounds = expandBounds(bounds, p.shape_pt_lon, p.shape_pt_lat);
    }
  }
  return isValidBounds(bounds) ? bounds : null;
}

/**
 * Decide whether the route panel should fit the map now. The fit runs once
 * per (route, tab): later data edits (a dragged vertex, a moved stop) must not
 * re-fit. `lastKey` is the key of the last fit; the returned `key` is what the
 * caller stores, which stays unchanged when there was nothing to fit yet so a
 * route with no geometry still fits once its data arrives.
 */
export function planRouteFit(
  lastKey: string | null,
  routeId: string,
  tab: RouteDetailTab,
  data: { shapes: Shape[]; trips: Trip[]; stops: Stop[]; routeStops: RouteStop[] },
  suppress = false,
): { key: string | null; bounds: Bounds | null } {
  const key = `${routeId}|${tab}`;
  if (key === lastKey) return { key: lastKey, bounds: null };
  // A one-shot suppression (e.g. "Edit Stops" on a shape row) consumes this
  // (route, tab) without fitting.
  if (suppress) return { key, bounds: null };
  const bounds = routeFitBounds(routeId, tab, data);
  return { key: bounds ? key : lastKey, bounds };
}

/** RouteStopsTab unmount/cleanup: release the stop-placement shape, except
 *  while "+ Create new stop" is open. That panel replaces the tab, and the
 *  stop it creates must still attach to the selected shape (CreateStopPanel
 *  clears it when it closes). */
export function releaseStopPlacementShape(): void {
  const st = useStore.getState();
  if (st.creatingStop) return;
  st.setStopPlacementShapeId(null);
}

export interface RouteTripRow {
  trip: Trip;
  start: string | undefined;
  end: string | undefined;
  cal: Calendar | undefined;
}

function startSeconds(t: string | undefined): number {
  if (!t) return Number.MAX_SAFE_INTEGER;
  return gtfsTimeToSeconds(t);
}

/** The Trips tab rows: one per route trip with its first departure and last
 *  arrival, sorted by start time. Uses the per-trip stop_times index rather
 *  than scanning every stop_time per trip. */
export function buildRouteTripRows(
  routeId: string,
  trips: Trip[],
  byTrip: Map<string, StopTime[]>,
  calendars: Calendar[],
): RouteTripRow[] {
  const calById = new Map(calendars.map((c) => [c.service_id, c]));
  return trips
    .filter((t) => t.route_id === routeId)
    .map((trip) => {
      const rows = byTrip.get(trip.trip_id) ?? [];
      let first: StopTime | undefined;
      let last: StopTime | undefined;
      for (const st of rows) {
        if (!first || st.stop_sequence < first.stop_sequence) first = st;
        if (!last || st.stop_sequence > last.stop_sequence) last = st;
      }
      return {
        trip,
        start: first?.departure_time,
        end: last?.arrival_time,
        cal: calById.get(trip.service_id),
      };
    })
    .sort((a, b) => startSeconds(a.start) - startSeconds(b.start));
}

/** A route-colour draft as typed (`#12ab34`, `12AB34`) → the stored hex, or
 *  null while it is still partial or invalid. */
export function parseRouteColorDraft(draft: string): string | null {
  const hex = draft.trim().replace(/^#/, '').toUpperCase();
  return /^[0-9A-F]{6}$/.test(hex) ? hex : null;
}

/** The routes the Routes list manages: everything except routes that exist
 *  only to carry one flex zone. A mixed fixed + flex route, or one shared by
 *  several zones, is a real route and stays listed. */
export function managedRouteList(
  routes: Route[],
  state: { trips: Trip[]; flexZones: FlexZone[] },
): Route[] {
  const hidden = flexOnlyRouteIds(state);
  return hidden.size === 0 ? routes : routes.filter((r) => !hidden.has(r.route_id));
}

/** Whether a shape is used by anything other than `routeId` (another route's
 *  trips or route_stops, or another route's draft `_route_id`), in which case
 *  removeShapeFromRoute keeps it. */
export function isShapeSharedWithOtherRoute(
  shapeId: string,
  routeId: string,
  state: { trips: Trip[]; routeStops: RouteStop[]; shapes: Shape[] },
): boolean {
  if (state.trips.some((t) => t.shape_id === shapeId && t.route_id !== routeId)) return true;
  if (state.routeStops.some((rs) => rs.shape_id === shapeId && rs.route_id !== routeId)) return true;
  const shape = state.shapes.find((s) => s.shape_id === shapeId);
  return shape?._route_id != null && shape._route_id !== routeId;
}

/** The route_stops a shape duplicate copies: this route's pattern on the
 *  shape only (another route sharing the shape keeps its own stops), in
 *  sequence order. */
export function routeStopsToCopy(
  routeStops: RouteStop[],
  routeId: string,
  shapeId: string,
): RouteStop[] {
  return routeStops
    .filter((rs) => rs.route_id === routeId && rs.shape_id === shapeId)
    .sort((a, b) => a.stop_sequence - b.stop_sequence);
}

/**
 * Routes › Shapes › Simplify: replace the shape's points with the simplified
 * ones as ONE undo step, after recording the pre-simplify points as the
 * snapshot the upcoming edit_shape session restores on Cancel. The caller
 * then enters edit mode.
 */
export function applyShapeSimplification(shapeId: string, simplified: ShapePoint[]): void {
  const state = useStore.getState();
  const original = state.shapes.find((s) => s.shape_id === shapeId)?.points;
  if (!original) return;
  primeShapeEditSnapshot(shapeId, original);
  historyTransaction('Simplify shape', () => {
    state.updateShapePoints(shapeId, simplified);
    useStore.getState().recalcShapeDistances(shapeId);
  });
}
