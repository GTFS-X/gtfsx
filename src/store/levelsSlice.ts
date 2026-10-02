import type { StateCreator } from 'zustand';
import type { Level, Translation } from '../types/gtfs';
import { renameTranslationRecord, withoutTranslationsFor } from '../services/translations';

type WithTranslations = { translations?: Translation[] };

export interface LevelsSlice {
  levels: Level[];
  addLevel: (level: Level) => void;
  updateLevel: (index: number, updates: Partial<Level>) => void;
  removeLevel: (index: number) => void;
  setLevels: (levels: Level[]) => void;
}

export const createLevelsSlice: StateCreator<LevelsSlice, [['zustand/immer', never]], [], LevelsSlice> = (set) => ({
  levels: [],
  addLevel: (level) => set((state) => { state.levels.push(level); }),
  updateLevel: (index, updates) => set((state) => {
    if (index >= 0 && index < state.levels.length) {
      const oldId = state.levels[index].level_id;
      Object.assign(state.levels[index], updates);
      const newId = state.levels[index].level_id;
      // level_id edits are live (per keystroke), so translations follow each step.
      if (updates.level_id !== undefined && oldId !== newId
          && !state.levels.some((l, i) => i !== index && l.level_id === oldId)) {
        renameTranslationRecord((state as unknown as WithTranslations).translations, 'levels', oldId, newId);
      }
    }
  }),
  removeLevel: (index) => set((state) => {
    if (index >= 0 && index < state.levels.length) {
      const [removed] = state.levels.splice(index, 1);
      if (!state.levels.some((l) => l.level_id === removed.level_id)) {
        const cross = state as unknown as WithTranslations;
        cross.translations = withoutTranslationsFor(cross.translations, 'levels', new Set([removed.level_id]));
      }
    }
  }),
  setLevels: (levels) => set((state) => { state.levels = levels; }),
});
