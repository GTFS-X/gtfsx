import type { StateCreator } from 'zustand';
import type { Shape } from '../types/gtfs';
import { fillShapeDistances } from '../services/shapeDistance';

export interface ShapeSlice {
  shapes: Shape[];
  addShape: (shape: Shape) => void;
  updateShapePoints: (shape_id: string, points: Shape['points']) => void;
  renameShape: (shape_id: string, name: string) => void;
  removeShape: (shape_id: string) => void;
  setShapes: (shapes: Shape[]) => void;
  recalcShapeDistances: (shape_id: string) => void;
}

export const createShapeSlice: StateCreator<ShapeSlice, [['zustand/immer', never]], [], ShapeSlice> = (set) => ({
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
  recalcShapeDistances: (shape_id) => set((state) => {
    const shape = state.shapes.find((s) => s.shape_id === shape_id);
    if (!shape || shape.points.length < 2) return;
    // One O(n) pass (S1-27); the previous per-prefix re-measure was O(n^2).
    fillShapeDistances(shape.points);
  }),
});
