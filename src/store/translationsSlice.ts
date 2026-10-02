import type { StateCreator } from 'zustand';
import type { Translation } from '../types/gtfs';
import { translationKey } from '../services/translations';

/**
 * translations.txt rows. Addressed by INDEX (like levels/pathways): the spec's
 * primary key spans six columns and an imported feed can legally carry rows
 * the editor can't resolve, so an index is the only handle that always names
 * exactly one row.
 */
export interface TranslationsSlice {
  translations: Translation[];
  setTranslations: (translations: Translation[]) => void;
  addTranslation: (t: Translation) => void;
  updateTranslationAt: (index: number, updates: Partial<Translation>) => void;
  removeTranslationAt: (index: number) => void;
  /** Remove several rows at once (one undo step). */
  removeTranslationsAt: (indices: number[]) => void;
  /**
   * Set the translation for one (table, field, language, target) key: updates
   * the row with that primary key if it exists, otherwise appends one. An empty
   * `translation` deletes the row instead — the per-entity editors use this so
   * clearing a box removes the translation rather than writing a blank (which
   * the spec forbids).
   */
  upsertTranslation: (t: Translation) => void;
}

export const createTranslationsSlice: StateCreator<
  TranslationsSlice,
  [['zustand/immer', never]],
  [],
  TranslationsSlice
> = (set) => ({
  translations: [],
  setTranslations: (translations) => set((state) => { state.translations = translations; }),
  addTranslation: (t) => set((state) => { state.translations.push(t); }),
  updateTranslationAt: (index, updates) => set((state) => {
    const row = state.translations[index];
    if (!row) return;
    Object.assign(row, updates);
    // Keep "not set" as an absent key, never '' — the exporter decides which
    // optional columns to emit from which keys are present.
    for (const k of ['record_id', 'record_sub_id', 'field_value'] as const) {
      if (row[k] === '') delete row[k];
    }
  }),
  removeTranslationAt: (index) => set((state) => {
    if (index >= 0 && index < state.translations.length) state.translations.splice(index, 1);
  }),
  removeTranslationsAt: (indices) => set((state) => {
    const drop = new Set(indices);
    if (drop.size === 0) return;
    state.translations = state.translations.filter((_, i) => !drop.has(i));
  }),
  upsertTranslation: (t) => set((state) => {
    const key = translationKey(t);
    const i = state.translations.findIndex((row) => translationKey(row) === key);
    if (t.translation === '') {
      if (i !== -1) state.translations.splice(i, 1);
      return;
    }
    if (i !== -1) state.translations[i].translation = t.translation;
    else state.translations.push(t);
  }),
});
