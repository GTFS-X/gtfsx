import type { StateCreator } from 'zustand';
import {
  isUnitSystem,
  loadUnitSystem,
  persistUnitSystem,
  readStoredUnitSystem,
  type UnitSystem,
} from '../utils/units';
import { me as fetchMe, updateUnitSystem, type AuthedUser } from '../services/authApi';
import { decideUnitSync } from '../services/unitPreferenceSync';
import type { AuthSlice } from './authSlice';

// Per-user display preferences. Not feed data: deliberately absent from
// persistedKeys.ts, so changing one never dirties or autosaves a feed and
// never lands in undo history. Always cached in localStorage like the active
// workspace (orgsSlice), so it works for anonymous editor users too; for a
// signed-in user it also follows the account (user.unit_system, migration
// 0033) — see syncUnitSystemFromAccount and services/unitPreferenceSync.ts.
export interface PreferencesSlice {
  /** Units for distance/speed readouts (issue #76). Imperial by default. */
  unitSystem: UnitSystem;
  /** The user picked a unit system. Cached locally; when signed in, also
   *  saved to the account (optimistic: a failed save keeps the local choice). */
  setUnitSystem: (system: UnitSystem) => void;
  /** Reconcile with the signed-in account's stored preference. Called by the
   *  auth slice when a user session is established. Never throws. */
  syncUnitSystemFromAccount: (user: AuthedUser) => Promise<void>;
}

// True once the user has touched the toggle in this tab. A later-arriving
// account value must not overwrite a choice they just made.
let changedLocally = false;

/** Test hook: forget in-tab toggle history. */
export function resetUnitSyncStateForTests(): void {
  changedLocally = false;
}

// Staff impersonation must never write the target's preferences, and the
// target's preference shouldn't overwrite the staff member's browser either.
function canSync(user: AuthedUser | null): user is AuthedUser {
  return !!user && user.impersonating !== true;
}

function pushUnitSystem(system: UnitSystem): Promise<void> {
  return updateUnitSystem(system).then(
    () => undefined,
    (err: unknown) => {
      // Optimistic: keep the local value; the next session load reconciles.
      console.warn('[units] could not save preference to account', err);
    },
  );
}

export const createPreferencesSlice: StateCreator<
  PreferencesSlice & AuthSlice,
  [['zustand/immer', never]],
  [],
  PreferencesSlice
> = (set, get) => {
  const applyLocal = (system: UnitSystem) => {
    persistUnitSystem(system);
    set((state) => {
      state.unitSystem = system;
    });
  };

  return {
    unitSystem: loadUnitSystem(),

    setUnitSystem: (system) => {
      changedLocally = true;
      applyLocal(system);
      const user = get().currentUser;
      if (canSync(user)) void pushUnitSystem(system);
    },

    syncUnitSystemFromAccount: async (user) => {
      if (!canSync(user)) return;
      try {
        let server = user.unitSystem;
        // Login/signup responses don't carry the field; ask /api/me once.
        if (server === undefined) {
          const { user: fresh } = await fetchMe();
          // Signed out or switched account while we waited: drop it.
          if (get().currentUser?.id !== user.id || !canSync(fresh)) return;
          server = fresh.unitSystem;
        }
        const decision = decideUnitSync({
          server: server === null || server === undefined || isUnitSystem(server) ? server : undefined,
          stored: readStoredUnitSystem(),
          current: get().unitSystem,
          changedLocally,
        });
        if (decision.apply) applyLocal(decision.apply);
        if (decision.push) await pushUnitSystem(decision.push);
      } catch (err) {
        console.warn('[units] could not load account preference', err);
      }
    },
  };
};
