import type { StateCreator } from 'zustand';
import type { Agency, Translation } from '../types/gtfs';
import { renameTranslationRecord, withoutTranslationsFor } from '../services/translations';
import type { RouteSlice } from './routeSlice';
import type { FareSlice } from './fareSlice';

// Renaming an agency_id has to follow the references other files keep to it
// (routes.txt, fare_attributes.txt). Casting the draft to this intersection is
// narrower than `any` and still catches field typos — same approach routeSlice
// uses for its cascades.
type CrossSliceState = AgencySlice & RouteSlice & FareSlice & { translations?: Translation[] };

// A deleted agency takes its translations with it — unless another agency row
// still carries the same id (an imported feed can have duplicates), in which
// case the translations still have a record to name.
function dropAgencyTranslations(state: CrossSliceState, agencyId: string) {
  if (!agencyId || state.agencies.some((a) => a.agency_id === agencyId)) return;
  state.translations = withoutTranslationsFor(state.translations, 'agency', new Set([agencyId]));
}

export interface AgencySlice {
  agencies: Agency[];
  addAgency: (agency: Agency) => void;
  updateAgency: (agency_id: string, updates: Partial<Agency>) => void;
  /**
   * Update the agency at `index`.
   *
   * Index-addressed on purpose: `agency_id` is only *conditionally* required by
   * the GTFS spec, so an imported feed can arrive with blank (or even duplicate)
   * agency_ids. An id-addressed update would then resolve to the wrong row and
   * silently edit somebody else's agency. The Agency panel therefore edits by
   * index; `updateAgency` stays for callers that legitimately hold an id.
   */
  updateAgencyAt: (index: number, updates: Partial<Agency>) => void;
  /**
   * Rename the `agency_id` of the agency at `index`, cascading to every row that
   * references it (routes.txt, fare_attributes.txt) so nothing is orphaned.
   * No-op when another agency already uses `newId` — agency_id must be unique.
   */
  renameAgencyIdAt: (index: number, newId: string) => void;
  removeAgency: (agency_id: string) => void;
  /**
   * Remove the agency at `index` (index-addressed for the same reason as
   * `updateAgencyAt`). Deliberately does NOT cascade: dropping an agency that
   * routes still point at would orphan them, so the caller is responsible for
   * checking references first (the Agency panel blocks the delete and says why).
   */
  removeAgencyAt: (index: number) => void;
  setAgencies: (agencies: Agency[]) => void;
}

export const createAgencySlice: StateCreator<AgencySlice, [['zustand/immer', never]], [], AgencySlice> = (set) => ({
  agencies: [],
  addAgency: (agency) => set((state) => { state.agencies.push(agency); }),
  updateAgency: (agency_id, updates) => set((state) => {
    const idx = state.agencies.findIndex((a) => a.agency_id === agency_id);
    if (idx !== -1) Object.assign(state.agencies[idx], updates);
  }),
  updateAgencyAt: (index, updates) => set((state) => {
    const agency = state.agencies[index];
    if (agency) Object.assign(agency, updates);
  }),
  renameAgencyIdAt: (index, newId) => set((state) => {
    const agency = state.agencies[index];
    if (!agency) return;
    const oldId = agency.agency_id;
    if (oldId === newId) return;
    // agency_id is a key: refuse a collision rather than merge two agencies.
    if (state.agencies.some((a, i) => i !== index && a.agency_id === newId)) return;
    agency.agency_id = newId;

    // translations.txt rows name the agency by agency_id; they follow the rename
    // (a blank old id names no translation, so this is a no-op for it).
    renameTranslationRecord((state as unknown as CrossSliceState).translations, 'agency', oldId, newId);

    // Cascade to the referencing rows. A blank `oldId` only identifies an agency
    // unambiguously in a single-agency feed — there, rows with no agency_id can
    // only mean the one agency, so adopting them is right (and is exactly what
    // fixes the NTD single-agency advisory in one move). In a multi-agency feed
    // a blank id cannot say *which* agency a blank row meant, so don't guess.
    if (oldId === '' && state.agencies.length > 1) return;
    const cross = state as unknown as CrossSliceState;
    for (const route of cross.routes) {
      if ((route.agency_id ?? '') === oldId) route.agency_id = newId;
    }
    for (const fare of cross.fareAttributes) {
      if ((fare.agency_id ?? '') === oldId) fare.agency_id = newId;
    }
  }),
  removeAgency: (agency_id) => set((state) => {
    state.agencies = state.agencies.filter((a) => a.agency_id !== agency_id);
    dropAgencyTranslations(state as unknown as CrossSliceState, agency_id);
  }),
  removeAgencyAt: (index) => set((state) => {
    if (index < 0 || index >= state.agencies.length) return;
    const [removed] = state.agencies.splice(index, 1);
    dropAgencyTranslations(state as unknown as CrossSliceState, removed.agency_id);
  }),
  setAgencies: (agencies) => set((state) => { state.agencies = agencies; }),
});
