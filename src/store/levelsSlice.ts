import type { StateCreator } from 'zustand';
import type { Level, Stop, Translation } from '../types/gtfs';
import { renameTranslationRecord, withoutTranslationsFor } from '../services/translations';

type WithTranslations = { translations?: Translation[]; stops?: Stop[] };

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
      // level_id edits are live (per keystroke), so translations and the stops
      // on this level (stops.level_id) follow each step. Skipped when another
      // level still carries the old id: those references are then ambiguous.
      if (updates.level_id !== undefined && oldId !== newId
          && !state.levels.some((l, i) => i !== index && l.level_id === oldId)) {
        const cross = state as unknown as WithTranslations;
        renameTranslationRecord(cross.translations, 'levels', oldId, newId);
        for (const s of cross.stops ?? []) {
          if (s.level_id === oldId) s.level_id = newId;
        }
      }
    }
  }),
  removeLevel: (index) => set((state) => {
    if (index >= 0 && index < state.levels.length) {
      const [removed] = state.levels.splice(index, 1);
      if (!state.levels.some((l) => l.level_id === removed.level_id)) {
        const cross = state as unknown as WithTranslations;
        cross.translations = withoutTranslationsFor(cross.translations, 'levels', new Set([removed.level_id]));
        // Stops on the deleted level no longer have one.
        for (const s of cross.stops ?? []) {
          if (s.level_id === removed.level_id) s.level_id = undefined;
        }
      }
    }
  }),
  setLevels: (levels) => set((state) => { state.levels = levels; }),
});
