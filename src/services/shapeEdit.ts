// One entry point for "this shape's geometry changed": write the new points,
// recompute shape_dist_traveled (shapes AND the stop_times of every trip on the
// shape), and record the whole thing as ONE undo step.
//
// Before this, callers did updateShapePoints + recalcShapeDistances as two
// writes. That only stayed a single undo step because both writes touched the
// same shape and coalesced; once the recompute also writes stop_times, the two
// writes would split across two undo entries. historyTransaction keeps it one.
//
// When a trip's stops can't be placed on the new geometry, its distances are
// cleared rather than left stale, and a notice is raised (useShapeDistNotice)
// so the editor can tell the user.

import { create } from 'zustand';
import { useStore } from '../store';
import { historyTransaction } from '../store/history';
import type { ShapePoint } from '../types/gtfs';
import type { ShapeDistanceReport } from '../store/shapeSlice';

export interface ShapeDistNotice {
  text: string;
  nonce: number;
}

/** Transient notice about stop distances that had to be cleared. */
export const useShapeDistNotice = create<{ notice: ShapeDistNotice | null }>(() => ({ notice: null }));

/** Human summary of a report's cleared trips, or null when nothing was cleared. */
export function clearedTripsMessage(report: ShapeDistanceReport | null): string | null {
  if (!report || report.tripsCleared.length === 0) return null;
  const n = report.tripsCleared.length;
  const why = report.tripsCleared[0].reason;
  return `Couldn't place the stops of ${n} trip${n === 1 ? '' : 's'} on the edited shape (${why}), `
    + `so ${n === 1 ? 'its' : 'their'} stop distances (shape_dist_traveled) were cleared. Check the Validation panel.`;
}

export function raiseShapeDistNotice(report: ShapeDistanceReport | null): void {
  const text = clearedTripsMessage(report);
  if (!text) return;
  useShapeDistNotice.setState((s) => ({ notice: { text, nonce: (s.notice?.nonce ?? 0) + 1 } }));
}

/**
 * Commit new geometry for a shape and recompute its distances, as one undo
 * step labelled `label`. Points are renumbered 0..n-1 in the given order.
 */
export function commitShapeGeometry(
  shapeId: string,
  points: Pick<ShapePoint, 'shape_pt_lat' | 'shape_pt_lon'>[],
  label = 'reshape route',
): ShapeDistanceReport | null {
  const report = historyTransaction(label, () => {
    const st = useStore.getState();
    st.updateShapePoints(shapeId, points.map((p, i) => ({
      shape_pt_lat: p.shape_pt_lat,
      shape_pt_lon: p.shape_pt_lon,
      shape_pt_sequence: i,
      shape_dist_traveled: 0,
    })));
    return useStore.getState().recalcShapeDistances(shapeId);
  });
  raiseShapeDistNotice(report);
  return report;
}

/** Recompute an existing shape's distances (no geometry change), one undo step. */
export function recomputeShapeDistances(shapeId: string): ShapeDistanceReport | null {
  const report = historyTransaction('recompute distances', () => useStore.getState().recalcShapeDistances(shapeId));
  raiseShapeDistNotice(report);
  return report;
}
