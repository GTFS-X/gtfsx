// Where a map click in place_stop mode puts the new stop: its (possibly
// snapped) coordinates, the shape it attaches to, and its direction. Pulled
// out of MapView's click handler so the shape choice is unit-testable.

import nearestPointOnLine from '@turf/nearest-point-on-line';
import distance from '@turf/distance';
import { lineString, point } from '@turf/helpers';
import type { Route, RouteStop, Shape, Trip } from '../types/gtfs';
import { directionName } from '../utils/constants';
import type { StopPlacementMode } from '../types/ui';
import { deriveRouteShapeIds } from './routeShapes';
import { activeStopsShapeId, computeShapePatterns } from '../components/ui/shapePatterns';

export interface StopPlacementInput {
  clickLon: number;
  clickLat: number;
  selectedRouteId: string | null;
  stopPlacementMode: StopPlacementMode;
  stopPlacementDirection: 0 | 1;
  /** Shape mirrored from the open Routes > Stops tab (null when it isn't mounted). */
  stopPlacementShapeId: string | null;
  /** Shape pinned in the Stops panel ("Edit Stops" / the Direction dropdown). */
  stopsPanelShapeId: string | null;
  trips: Trip[];
  routeStops: RouteStop[];
  shapes: Shape[];
}

export interface StopPlacementTarget {
  lat: number;
  lon: number;
  directionId: 0 | 1;
  shapeId: string | undefined;
}

/**
 * The shape a new stop on `routeId` should attach to, or null when the route
 * has no shapes. Resolved from store state at click time rather than trusting
 * only `stopPlacementShapeId`, which the Stops tab mirrors while mounted and
 * clears on unmount — and the tab unmounts whenever "+ Create new stop" swaps
 * in the New stop panel. Precedence: the mirrored shape (if it is one of this
 * route's), then the Stops panel's pinned shape, then the shape for the active
 * direction (what the map's "Assign to" dropdown sets).
 */
export function placementTargetShapeId(
  routeId: string | null,
  trips: Trip[],
  routeStops: RouteStop[],
  shapes: Shape[],
  mirroredShapeId: string | null,
  panelShapeId: string | null,
  directionId: 0 | 1,
): string | null {
  if (!routeId) return null;
  const patterns = computeShapePatterns(routeId, trips, routeStops, shapes);
  if (mirroredShapeId && patterns.some((p) => p.shapeId === mirroredShapeId)) return mirroredShapeId;
  return activeStopsShapeId(patterns, panelShapeId, directionId);
}

export function resolveStopPlacement(input: StopPlacementInput): StopPlacementTarget {
  const { clickLon, clickLat, selectedRouteId, trips, routeStops, shapes } = input;
  let lat = clickLat;
  let lon = clickLon;
  let directionId: 0 | 1 = input.stopPlacementDirection;
  const targetShapeId = placementTargetShapeId(
    selectedRouteId, trips, routeStops, shapes,
    input.stopPlacementShapeId, input.stopsPanelShapeId, input.stopPlacementDirection,
  );
  let shapeId: string | undefined = targetShapeId ?? undefined;

  if (selectedRouteId && input.stopPlacementMode === 'snap_to_route') {
    let candidateShapeIds = deriveRouteShapeIds(selectedRouteId, trips, routeStops, shapes);
    // Snap only to the target shape: out-and-back shapes overlap, so "nearest
    // shape" is a coin flip between them. Nearest-shape remains the fallback
    // for a route with no resolvable target.
    if (targetShapeId) {
      candidateShapeIds = candidateShapeIds.filter((id) => id === targetShapeId);
    }
    let bestDist = Infinity;
    for (const id of candidateShapeIds) {
      const shape = shapes.find((s) => s.shape_id === id);
      if (!shape || shape.points.length < 2) continue;
      const line = lineString(shape.points.map((p) => [p.shape_pt_lon, p.shape_pt_lat]));
      const clickPoint = point([clickLon, clickLat]);
      const snapped = nearestPointOnLine(line, clickPoint);
      const dist = distance(clickPoint, snapped, { units: 'meters' });
      if (dist < bestDist) {
        bestDist = dist;
        lat = snapped.geometry.coordinates[1];
        lon = snapped.geometry.coordinates[0];
        directionId = trips.find((t) => t.shape_id === id)?.direction_id ?? input.stopPlacementDirection;
        shapeId = id;
      }
    }
  }
  return { lat, lon, directionId, shapeId };
}

export interface PlaceStopOption {
  /** `${routeId}__${shapeId}` */
  key: string;
  routeId: string;
  shapeId: string;
  directionId: 0 | 1;
  label: string;
}

/**
 * Options for the map's place-stop "Assign to" dropdown: one per shape pattern
 * of each route (computeShapePatterns — the same shapes and directions the
 * Routes > Stops tab offers), labelled "{route} — {shape name or direction}".
 */
export function placeStopOptions(
  routes: Route[],
  trips: Trip[],
  routeStops: RouteStop[],
  shapes: Shape[],
): PlaceStopOption[] {
  const out: PlaceStopOption[] = [];
  for (const route of routes) {
    const patterns = computeShapePatterns(route.route_id, trips, routeStops, shapes);
    if (patterns.length === 0) continue;
    const routeName = route.route_short_name || route.route_long_name || route.route_id;
    for (const p of patterns) {
      const name = shapes.find((s) => s.shape_id === p.shapeId)?._name?.trim();
      out.push({
        key: `${route.route_id}__${p.shapeId}`,
        routeId: route.route_id,
        shapeId: p.shapeId,
        directionId: p.directionId,
        label: `${routeName} — ${name || directionName(route, p.directionId)}`,
      });
    }
  }
  return out;
}
