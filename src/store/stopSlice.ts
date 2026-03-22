import type { StateCreator } from 'zustand';
import type { Stop } from '../types/gtfs';

export interface StopSlice {
  stops: Stop[];
  addStop: (stop: Stop) => void;
  updateStop: (stop_id: string, updates: Partial<Stop>) => void;
  removeStop: (stop_id: string) => void;
  setStops: (stops: Stop[]) => void;
}

export const createStopSlice: StateCreator<StopSlice, [['zustand/immer', never]], [], StopSlice> = (set) => ({
  stops: [],
  addStop: (stop) => set((state) => { state.stops.push(stop); }),
  updateStop: (stop_id, updates) => set((state) => {
    const idx = state.stops.findIndex((s) => s.stop_id === stop_id);
    if (idx !== -1) Object.assign(state.stops[idx], updates);
  }),
  removeStop: (stop_id) => set((state) => {
    state.stops = state.stops.filter((s) => s.stop_id !== stop_id);
  }),
  setStops: (stops) => set((state) => { state.stops = stops; }),
});
