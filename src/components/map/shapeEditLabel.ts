import type { Route, Shape, Trip } from '../../types/gtfs';

/**
 * Resolve a concise "{route} · {shape}" label for the shape currently being
 * edited, for the "Editing …" banner. A Shape doesn't carry its route, so the
 * route is found via the first trip that references the shape, else the
 * shape's draft `_route_id`.
 *
 * Fallbacks: omit the route if neither resolves; return null if nothing resolves (caller shows the generic "Editing
 * Shape" text). Names are truncated so the banner doesn't overflow.
 */
export function shapeEditLabel(
  editingShapeId: string | null,
  shapes: Shape[],
  trips: Trip[],
  routes: Route[],
): string | null {
  if (!editingShapeId) return null;

  const shape = shapes.find((s) => s.shape_id === editingShapeId);
  if (!shape) return null;

  const shapeName = truncate(shape._name || shape.shape_id);

  // A drawn shape with no trip yet still belongs to its route via _route_id
  // (the same fallback RouteLayer and the route list use).
  const trip = trips.find((t) => t.shape_id === editingShapeId);
  const routeId = trip?.route_id ?? shape._route_id;
  const route = routeId ? routes.find((r) => r.route_id === routeId) : undefined;
  if (route) {
    const routeName = truncate(
      route.route_short_name || route.route_long_name || route.route_id,
    );
    return `${routeName} · ${shapeName}`;
  }

  return shapeName;
}

function truncate(s: string, max = 28): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
