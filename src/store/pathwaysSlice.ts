import type { StateCreator } from 'zustand';
import type { Pathway, Translation } from '../types/gtfs';
import { renameTranslationRecord, withoutTranslationsFor } from '../services/translations';

type WithTranslations = { translations?: Translation[] };

export interface PathwaysSlice {
  pathways: Pathway[];
  addPathway: (pathway: Pathway) => void;
  updatePathway: (index: number, updates: Partial<Pathway>) => void;
  removePathway: (index: number) => void;
  setPathways: (pathways: Pathway[]) => void;
}

export const createPathwaysSlice: StateCreator<PathwaysSlice, [['zustand/immer', never]], [], PathwaysSlice> = (set) => ({
  pathways: [],
  addPathway: (pathway) => set((state) => { state.pathways.push(pathway); }),
  updatePathway: (index, updates) => set((state) => {
    if (index >= 0 && index < state.pathways.length) {
      const oldId = state.pathways[index].pathway_id;
      Object.assign(state.pathways[index], updates);
      const newId = state.pathways[index].pathway_id;
      if (updates.pathway_id !== undefined && oldId !== newId
          && !state.pathways.some((p, i) => i !== index && p.pathway_id === oldId)) {
        renameTranslationRecord((state as unknown as WithTranslations).translations, 'pathways', oldId, newId);
      }
    }
  }),
  removePathway: (index) => set((state) => {
    if (index >= 0 && index < state.pathways.length) {
      const [removed] = state.pathways.splice(index, 1);
      if (!state.pathways.some((p) => p.pathway_id === removed.pathway_id)) {
        const cross = state as unknown as WithTranslations;
        cross.translations = withoutTranslationsFor(cross.translations, 'pathways', new Set([removed.pathway_id]));
      }
    }
  }),
  setPathways: (pathways) => set((state) => { state.pathways = pathways; }),
});
