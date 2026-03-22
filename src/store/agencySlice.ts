import type { StateCreator } from 'zustand';
import type { Agency } from '../types/gtfs';

export interface AgencySlice {
  agencies: Agency[];
  addAgency: (agency: Agency) => void;
  updateAgency: (agency_id: string, updates: Partial<Agency>) => void;
  removeAgency: (agency_id: string) => void;
  setAgencies: (agencies: Agency[]) => void;
}

export const createAgencySlice: StateCreator<AgencySlice, [['zustand/immer', never]], [], AgencySlice> = (set) => ({
  agencies: [],
  addAgency: (agency) => set((state) => { state.agencies.push(agency); }),
  updateAgency: (agency_id, updates) => set((state) => {
    const idx = state.agencies.findIndex((a) => a.agency_id === agency_id);
    if (idx !== -1) Object.assign(state.agencies[idx], updates);
  }),
  removeAgency: (agency_id) => set((state) => {
    state.agencies = state.agencies.filter((a) => a.agency_id !== agency_id);
  }),
  setAgencies: (agencies) => set((state) => { state.agencies = agencies; }),
});
