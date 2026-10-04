// Small, map-instance-agnostic pieces of MapView's event handling, pulled out
// so they can be unit-tested against a mocked map (MapView itself needs a real
// WebGL map to mount).
import type { PointLike } from 'mapbox-gl';
import type { ShapePoint } from '../../types/gtfs';
import { STOPS_CLUSTER_SOURCE_ID, STOP_POINT_LAYER_IDS, existingLayerIds } from './stopLayerIds';

interface ClusterSource {
  getClusterExpansionZoom: (id: number, cb: (err: unknown, zoom: number) => void) => void;
}

interface ClusterMap {
  getSource: (id: string) => unknown;
  easeTo: (opts: { center: [number, number]; zoom: number; duration: number }) => void;
}

/**
 * Zoom in far enough to break the clicked cluster apart. Returns false when the
 * clustered source isn't on the map (nothing to expand).
 */
export function expandStopCluster(
  map: ClusterMap,
  clusterId: unknown,
  center: [number, number],
): boolean {
  const source = map.getSource(STOPS_CLUSTER_SOURCE_ID) as ClusterSource | undefined;
  if (!source || typeof clusterId !== 'number') return false;
  source.getClusterExpansionZoom(clusterId, (err, zoom) => {
    if (err) return;
    map.easeTo({ center, zoom, duration: 500 });
  });
  return true;
}

interface QueryMap {
  getLayer: (id: string) => unknown;
  queryRenderedFeatures: (
    point: PointLike,
    opts: { layers: string[] },
  ) => Array<{ properties?: Record<string, unknown> | null }>;
}

/**
 * Is the selected stop under the pointer? Queries only the stop layers that
 * exist in the current mode: in clustered mode the detailed 'stop-circles'
 * layers aren't mounted, and asking for a missing layer makes mapbox-gl return
 * no features at all, so the drag never started on large feeds.
 */
export function pointerHitsStop(map: QueryMap, point: PointLike, stopId: string): boolean {
  const layers = existingLayerIds(map, STOP_POINT_LAYER_IDS);
  if (layers.length === 0) return false;
  return map.queryRenderedFeatures(point, { layers })
    .some((f) => f.properties?.stop_id === stopId);
}

/** Pre-edit points of the shape being edited, for Cancel. */
export interface ShapeEditSnapshot {
  shapeId: string;
  points: ShapePoint[];
}

/**
 * Pre-edit points recorded by a caller that changes the shape BEFORE edit
 * mode starts (Routes › Shapes › Simplify writes the simplified points, then
 * enters edit_shape). Without it the edit-mode snapshot would be taken of the
 * already-simplified points and Cancel would not restore the original.
 */
let primedShapeEditSnapshot: ShapeEditSnapshot | null = null;

/**
 * Snapshot to keep when the edit effect runs for `shapeId`. A re-run for the
 * SAME shape (Simplify toggles editingShapeId null→id; the store write per
 * vertex drag re-renders) keeps the original snapshot, so Cancel still restores
 * the pre-edit geometry rather than the simplified/half-edited one.
 */
export function nextShapeEditSnapshot(
  prev: ShapeEditSnapshot | null,
  shapeId: string,
  points: ShapePoint[],
): ShapeEditSnapshot {
  // A primed snapshot is consumed (or discarded) by the first edit that
  // starts after it, so it can never leak into a later, unrelated edit.
  const primed = primedShapeEditSnapshot;
  primedShapeEditSnapshot = null;
  if (prev && prev.shapeId === shapeId) return prev;
  if (primed && primed.shapeId === shapeId) return primed;
  return { shapeId, points: JSON.parse(JSON.stringify(points)) as ShapePoint[] };
}

export function primeShapeEditSnapshot(shapeId: string, points: ShapePoint[]): void {
  primedShapeEditSnapshot = { shapeId, points: JSON.parse(JSON.stringify(points)) as ShapePoint[] };
}

/** True when a key event comes from a text field (the PlaceStopDialog name box,
 *  etc.); Esc there exits the mode but must not undo the last placed stop. */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  const tag = (target as { tagName?: string } | null)?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
