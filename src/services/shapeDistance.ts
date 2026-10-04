import length from '@turf/length';
import { lineString } from '@turf/helpers';
import type { ShapePoint } from '../types/gtfs';

/**
 * Populate shape_dist_traveled (cumulative metres) from the lat/lon geometry,
 * IN PLACE, and return the same array. Works on plain arrays and on Immer
 * drafts (shapeSlice.recalcShapeDistances can call it inside a recipe).
 *
 * Single pass, O(n): each segment is measured once and accumulated. turf
 * `length` sums consecutive-point haversine distances, so this equals
 * measuring the polyline up to point i (the old O(n²) approach) to within
 * floating-point rounding.
 */
export function fillShapeDistances<T extends Pick<ShapePoint, 'shape_pt_lat' | 'shape_pt_lon' | 'shape_dist_traveled'>>(
  points: T[],
): T[] {
  if (points.length === 0) return points;
  points[0].shape_dist_traveled = 0;
  let cumulative = 0;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const segment = lineString([
      [prev.shape_pt_lon, prev.shape_pt_lat],
      [cur.shape_pt_lon, cur.shape_pt_lat],
    ]);
    cumulative += length(segment, { units: 'meters' });
    cur.shape_dist_traveled = cumulative;
  }
  return points;
}
