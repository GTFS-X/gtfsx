// Route → Shapes "Recompute distances": rerun the shape_dist_traveled
// recompute (services/shapeDistRecompute.ts via the store's
// recalcShapeDistances) on every shape the route lists, without editing any
// shape. Until this existed the recompute only ran as a Validation fix or after
// a shape edit, and saving an unchanged shape is skipped, so a route whose
// stops were reordered (Butte's Green route: 22 stop distances went blank)
// had no direct way to get its distances back.
//
// Only distances are written: shapes.shape_dist_traveled and
// stop_times.shape_dist_traveled. Shape points (lat/lon/sequence) are never
// touched. Every shape is recomputed inside one history transaction, so one
// Undo reverses the whole button press.
import { useStore } from '../../store';
import { historyTransaction } from '../../store/history';

export interface RouteDistanceRecomputeResult {
  shapes: number;
  tripsRecomputed: number;
  /** Trips whose stops couldn't be placed on the shape; their distances were cleared. */
  tripsCleared: number;
  stopTimesChanged: number;
  shapesChanged: number;
}

export function recomputeRouteDistances(shapeIds: readonly string[]): RouteDistanceRecomputeResult {
  const out: RouteDistanceRecomputeResult = {
    shapes: 0, tripsRecomputed: 0, tripsCleared: 0, stopTimesChanged: 0, shapesChanged: 0,
  };
  historyTransaction('recompute distances', () => {
    for (const id of new Set(shapeIds)) {
      const report = useStore.getState().recalcShapeDistances(id);
      if (!report) continue;
      out.shapes += 1;
      out.tripsRecomputed += report.tripsRecomputed;
      out.tripsCleared += report.tripsCleared.length;
      out.stopTimesChanged += report.stopTimesChanged;
      if (report.shapeChanged) out.shapesChanged += 1;
    }
  });
  return out;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One plain sentence for the Shapes tab after a recompute. */
export function describeRouteDistanceRecompute(r: RouteDistanceRecomputeResult): string {
  if (r.shapes === 0) return 'No shape with at least two points to measure.';
  if (r.stopTimesChanged === 0 && r.shapesChanged === 0) {
    return 'Distances already match the shapes. Nothing changed.';
  }
  const parts = [`Updated ${plural(r.stopTimesChanged, 'stop distance')} on ${plural(r.tripsRecomputed, 'trip')}`];
  if (r.shapesChanged > 0) parts.push(`and the distances along ${plural(r.shapesChanged, 'shape')}`);
  let s = `${parts.join(' ')}.`;
  if (r.tripsCleared > 0) {
    s += ` ${plural(r.tripsCleared, 'trip')} had stops too far from the shape to place, so their distances were removed.`;
  }
  return `${s} Undo reverses this.`;
}
