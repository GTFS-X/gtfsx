import type { StateCreator } from 'zustand';
import type { Trip, StopTime } from '../types/gtfs';

export interface TripSlice {
  trips: Trip[];
  stopTimes: StopTime[];
  addTrip: (trip: Trip) => void;
  updateTrip: (trip_id: string, updates: Partial<Trip>) => void;
  removeTrip: (trip_id: string) => void;
  setTrips: (trips: Trip[]) => void;
  setStopTime: (trip_id: string, stop_id: string, stop_sequence: number, updates: Partial<StopTime>) => void;
  setStopTimes: (stopTimes: StopTime[]) => void;
  duplicateTrip: (trip_id: string, newTripId: string, offsetMinutes: number) => void;
}

function addMinutesToGtfsTime(time: string, minutes: number): string {
  const parts = time.split(':').map(Number);
  const totalSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2] + minutes * 60;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export const createTripSlice: StateCreator<TripSlice, [['zustand/immer', never]], [], TripSlice> = (set) => ({
  trips: [],
  stopTimes: [],
  addTrip: (trip) => set((state) => { state.trips.push(trip); }),
  updateTrip: (trip_id, updates) => set((state) => {
    const idx = state.trips.findIndex((t) => t.trip_id === trip_id);
    if (idx !== -1) Object.assign(state.trips[idx], updates);
  }),
  removeTrip: (trip_id) => set((state) => {
    state.trips = state.trips.filter((t) => t.trip_id !== trip_id);
    state.stopTimes = state.stopTimes.filter((st) => st.trip_id !== trip_id);
  }),
  setTrips: (trips) => set((state) => { state.trips = trips; }),
  setStopTime: (trip_id, stop_id, stop_sequence, updates) => set((state) => {
    const idx = state.stopTimes.findIndex(
      (st) => st.trip_id === trip_id && st.stop_id === stop_id && st.stop_sequence === stop_sequence
    );
    if (idx !== -1) {
      Object.assign(state.stopTimes[idx], updates);
    } else {
      state.stopTimes.push({
        trip_id, stop_id, stop_sequence,
        arrival_time: '', departure_time: '',
        ...updates,
      });
    }
  }),
  setStopTimes: (stopTimes) => set((state) => { state.stopTimes = stopTimes; }),
  duplicateTrip: (trip_id, newTripId, offsetMinutes) => set((state) => {
    const trip = state.trips.find((t) => t.trip_id === trip_id);
    if (!trip) return;
    state.trips.push({ ...trip, trip_id: newTripId });
    const times = state.stopTimes.filter((st) => st.trip_id === trip_id);
    for (const st of times) {
      state.stopTimes.push({
        ...st,
        trip_id: newTripId,
        arrival_time: addMinutesToGtfsTime(st.arrival_time, offsetMinutes),
        departure_time: addMinutesToGtfsTime(st.departure_time, offsetMinutes),
      });
    }
  }),
});
