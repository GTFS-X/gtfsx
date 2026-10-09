import type { StateCreator } from 'zustand';
import { loadUnitSystem, persistUnitSystem, type UnitSystem } from '../utils/units';

// Per-browser display preferences. Not feed data: deliberately absent from
// persistedKeys.ts, so changing one never dirties or autosaves a feed and
// never lands in undo history. Persisted in localStorage like the active
// workspace (orgsSlice), so it works for anonymous editor users too.
export interface PreferencesSlice {
  /** Units for distance/speed readouts (issue #76). Imperial by default. */
  unitSystem: UnitSystem;
  setUnitSystem: (system: UnitSystem) => void;
}

export const createPreferencesSlice: StateCreator<
  PreferencesSlice,
  [['zustand/immer', never]],
  [],
  PreferencesSlice
> = (set) => ({
  unitSystem: loadUnitSystem(),
  setUnitSystem: (system) => {
    persistUnitSystem(system);
    set((state) => {
      state.unitSystem = system;
    });
  },
});
