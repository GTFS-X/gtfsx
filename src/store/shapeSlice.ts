import type { StateCreator } from 'zustand';
import type { Shape, Stop, StopTime, Trip } from '../types/gtfs';
import {
  planShapeDistanceRecompute, type DistUnit, type LngLat,
} from '../services/shapeDistRecompute';

/** What a distance recompute/clear changed, so it can be reported and reversed. */
export interface ShapeDistanceSnapshot {
  /** Prior shape_dist_traveled per point, by index into shape.points. */
  shapes: { shape_id: string; dists: number[] }[];
  /** Prior stop_times.shape_dist_traveled per row (undefined = was absent). */
  stopTimes: { trip_id: string; stop_sequence: number; value: number | undefined }[];
}

export interface ShapeDistanceReport {
  shape_id: string;
  unit: DistUnit;
  /** Trips whose stop distances were recomputed along the new geometry. */
  tripsRecomputed: number;
  /** Trips whose stop distances were CLEARED because projection failed. */
  tripsCleared: { trip_id: string; reason: string }[];
  /** Stop_time rows whose value actually changed. */
  stopTimesChanged: number;
  /** Whether the shape's own distance column changed. */
  shapeChanged: boolean;
  snapshot: ShapeDistanceSnapshot;
}

export interface RecalcShapeDistanceOptions {
  /** Force a unit instead of detecting it. */
  unit?: DistUnit;
  /** Also fill trips on this shape that carry no stop distances yet. */
  fillMissing?: boolean;
}

export interface ShapeSlice {
  shapes: Shape[];
  addShape: (shape: Shape) => void;
  updateShapePoints: (shape_id: string, points: Shape['points']) => void;
  renameShape: (shape_id: string, name: string) => void;
  removeShape: (shape_id: string) => void;
  setShapes: (shapes: Shape[]) => void;
  /**
   * Recompute shapes.shape_dist_traveled along the shape's CURRENT geometry,
   * in the feed's unit, and re-project stop_times.shape_dist_traveled for
   * every trip on the shape that carries stop distances. A trip whose stops
   * can't be placed has its distances cleared (never left stale) and is listed
   * in `tripsCleared`. Returns null when the shape is missing or degenerate.
   */
  recalcShapeDistances: (shape_id: string, opts?: RecalcShapeDistanceOptions) => ShapeDistanceReport | null;
  /** Remove stop_times.shape_dist_traveled for every trip on the shape and
   *  recompute the shape's own column from geometry (it stays consistent). */
  clearShapeDistances: (shape_id: string) => ShapeDistanceReport | null;
  /** Put back what a recalc/clear changed (validation-fix undo, edit Cancel). */
  restoreShapeDistances: (snapshot: ShapeDistanceSnapshot) => void;
}

type FullState = ShapeSlice & { trips: Trip[]; stopTimes: StopTime[]; stops: Stop[] };

function stopCoordResolver(stops: Stop[]): (id: string) => LngLat | null {
  const byId = new Map(stops.map((s) => [s.stop_id, s]));
  const resolve = (id: string, depth = 0): LngLat | null => {
    const s = byId.get(id);
    if (!s || depth > 8) return null;
    if (s.stop_lat && s.stop_lon) return [s.stop_lon, s.stop_lat];
    if (s.parent_station) return resolve(s.parent_station, depth + 1);
    return null;
  };
  return (id) => resolve(id);
}

export const createShapeSlice: StateCreator<ShapeSlice, [['zustand/immer', never]], [], ShapeSlice> = (set, get) => {
  const run = (shape_id: string, mode: 'recalc' | 'clear', opts?: RecalcShapeDistanceOptions): ShapeDistanceReport | null => {
    const full = get() as unknown as FullState;
    const shapeIdx = full.shapes.findIndex((s) => s.shape_id === shape_id);
    if (shapeIdx === -1) return null;
    const shape = full.shapes[shapeIdx];
    if (shape.points.length < 2) return null;
    const trips = full.trips.filter((t) => t.shape_id === shape_id);
    const tripIds = new Set(trips.map((t) => t.trip_id));
    // Row indices of this shape's trips, found in ONE pass over stop_times.
    const rowIdx: number[] = [];
    if (tripIds.size > 0) {
      for (let i = 0; i < full.stopTimes.length; i++) if (tripIds.has(full.stopTimes[i].trip_id)) rowIdx.push(i);
    }
    const rows = rowIdx.map((i) => full.stopTimes[i]);
    const plan = planShapeDistanceRecompute({
      shape_id,
      points: shape.points,
      allShapes: full.shapes,
      trips,
      stopTimes: rows,
      stopCoord: stopCoordResolver(full.stops),
      unit: opts?.unit,
      fillMissing: opts?.fillMissing,
    });
    if (!plan) return null;

    // New shape distances by points-array index (the plan is in sequence order).
    const order = shape.points.map((_, i) => i).sort((a, b) => shape.points[a].shape_pt_sequence - shape.points[b].shape_pt_sequence);
    const newShapeDists = new Array<number>(shape.points.length);
    order.forEach((pIdx, k) => { newShapeDists[pIdx] = plan.shapeDistances[k]; });

    // Row writes: recompute → plan values; clear → undefined for every row
    // of every trip on the shape.
    const writes: { idx: number; value: number | undefined }[] = [];
    if (mode === 'recalc') {
      const byTrip = new Map(plan.tripUpdates.map((u) => [u.trip_id, u.values]));
      for (const i of rowIdx) {
        const st = full.stopTimes[i];
        const values = byTrip.get(st.trip_id);
        if (!values || !values.has(st.stop_sequence)) continue;
        const v = values.get(st.stop_sequence);
        if (v !== st.shape_dist_traveled) writes.push({ idx: i, value: v });
      }
    } else {
      for (const i of rowIdx) if (full.stopTimes[i].shape_dist_traveled !== undefined) writes.push({ idx: i, value: undefined });
    }

    const snapshot: ShapeDistanceSnapshot = {
      shapes: [{ shape_id, dists: shape.points.map((p) => p.shape_dist_traveled) }],
      stopTimes: writes.map((w) => ({
        trip_id: full.stopTimes[w.idx].trip_id,
        stop_sequence: full.stopTimes[w.idx].stop_sequence,
        value: full.stopTimes[w.idx].shape_dist_traveled,
      })),
    };

    const shapeChanged = shape.points.some((p, i) => p.shape_dist_traveled !== newShapeDists[i]);
    if (shapeChanged || writes.length > 0) {
      set((draft) => {
        const d = draft as unknown as FullState;
        if (shapeChanged) {
          const pts = d.shapes[shapeIdx].points;
          for (let i = 0; i < pts.length; i++) {
            if (pts[i].shape_dist_traveled !== newShapeDists[i]) pts[i].shape_dist_traveled = newShapeDists[i];
          }
        }
        for (const w of writes) {
          const row = d.stopTimes[w.idx];
          if (w.value === undefined) delete row.shape_dist_traveled;
          else row.shape_dist_traveled = w.value;
        }
      });
    }

    return {
      shape_id,
      unit: plan.unit,
      tripsRecomputed: mode === 'recalc' ? plan.tripsRecomputed.length : 0,
      tripsCleared: mode === 'recalc' ? plan.tripsCleared : [],
      stopTimesChanged: writes.length,
      shapeChanged,
      snapshot,
    };
  };

  return {
    shapes: [],
    addShape: (shape) => set((state) => { state.shapes.push(shape); }),
    updateShapePoints: (shape_id, points) => set((state) => {
      const idx = state.shapes.findIndex((s) => s.shape_id === shape_id);
      if (idx !== -1) state.shapes[idx].points = points;
    }),
    renameShape: (shape_id, name) => set((state) => {
      const shape = state.shapes.find((s) => s.shape_id === shape_id);
      if (shape) shape._name = name.trim() || undefined;
    }),
    removeShape: (shape_id) => set((state) => {
      state.shapes = state.shapes.filter((s) => s.shape_id !== shape_id);
    }),
    setShapes: (shapes) => set((state) => { state.shapes = shapes; }),
    // One O(n) pass over the shape (S1-27) plus one pass over stop_times to
    // find this shape's trips; projection is shared by trips with the same
    // stop pattern.
    recalcShapeDistances: (shape_id, opts) => run(shape_id, 'recalc', opts),
    clearShapeDistances: (shape_id) => run(shape_id, 'clear'),
    restoreShapeDistances: (snapshot) => set((draft) => {
      const d = draft as unknown as FullState;
      for (const s of snapshot.shapes) {
        const shape = d.shapes.find((x) => x.shape_id === s.shape_id);
        if (!shape || shape.points.length !== s.dists.length) continue;
        shape.points.forEach((p, i) => { p.shape_dist_traveled = s.dists[i]; });
      }
      if (snapshot.stopTimes.length === 0) return;
      const want = new Map(snapshot.stopTimes.map((r) => [`${r.trip_id}\u0001${r.stop_sequence}`, r.value]));
      for (const row of d.stopTimes) {
        const key = `${row.trip_id}\u0001${row.stop_sequence}`;
        if (!want.has(key)) continue;
        const v = want.get(key);
        if (v === undefined) delete row.shape_dist_traveled;
        else row.shape_dist_traveled = v;
      }
    }),
  };
};
