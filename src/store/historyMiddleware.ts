// Drop-in replacement for `zustand/middleware/immer` that ALSO captures Immer
// inverse-patches for the undo/redo history (history.ts, GitHub #49) and marks
// the project dirty whenever persisted feed state changes.
//
// It presents the identical `['zustand/immer', never]` store mutator, so every
// slice typed against the stock immer middleware composes unchanged. The only
// behavioural difference: each recipe `set` runs through `produceWithPatches`
// (instead of `produce`) and the resulting patch sets are handed to
// `recordChange`. The recipe still runs EXACTLY ONCE — important, because some
// recipes are non-deterministic (e.g. routeSlice.duplicateRoute mints ids with
// `generateId` inside the recipe), so a re-run would desync the patches.
//
// Non-recipe `set(object, replace)` calls (the undo/redo patch-apply path, and
// any direct `setState(obj)`) pass straight through without patch capture, but
// still get the dirty check.
//
// ─── Why dirty-tracking lives HERE ───────────────────────────────────────────
// It used to live in a store SUBSCRIPTION installed by db/persistence.ts
// `setupAutoSave()`, which the editor routes mounted with a ref count and tore
// down when the last one unmounted. That made "are there unsaved changes?" a
// function of React mount state: any window in which no editor route held a
// live reference (a route transition, an effect re-run whose async re-subscribe
// hadn't landed yet, a read-only /demo mount that deliberately never
// subscribes) silently swallowed edits — they mutated the store, never set
// `isDirty`, and so left TopBar's Save button DISABLED with hours of real work
// in memory and nothing on the server.
//
// Dirtiness is a property of the DATA, not of which components happen to be
// mounted, so it is computed on the store's own write path where nothing can
// bypass it. `markSaved()` still clears the flag, and the bulk-load paths still
// end with `markSaved()`, so the observable semantics are unchanged — only the
// place they can no longer be lost.

// Keep the `['zustand/immer']` StoreMutators augmentation in the type program
// now that we no longer import the stock middleware at runtime.
import type {} from 'zustand/middleware/immer';
import { produce, produceWithPatches, enablePatches, type Draft } from 'immer';
import type { StateCreator, StoreMutatorIdentifier } from 'zustand';
import { recordChange, isSuppressed } from './history';
import { DATA_KEYS } from './persistedKeys';

enablePatches();

/**
 * True when `next` moves any persisted feed key off the value it had in `prev`.
 *
 * Reference identity is the signal: Immer structurally shares, so an untouched
 * array/object comes back as the very same reference and only what the recipe
 * actually wrote gets replaced. `own` limits the comparison to keys the update
 * carries, so a PARTIAL `setState({ ... })` isn't read as clearing everything
 * it happens to omit.
 */
function touchesPersistedData(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
  own: boolean,
): boolean {
  for (const key of DATA_KEYS) {
    if (own && !(key in next)) continue;
    if (prev[key] !== next[key]) return true;
  }
  return false;
}

/**
 * Stamp `isDirty: true` onto an update that changed persisted feed data.
 *
 * Returns `next` untouched when nothing persisted moved (or the project is
 * already dirty), so the common case allocates nothing. Immer auto-freezes its
 * output, hence the spread rather than an in-place write.
 */
function withDirty(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
  own: boolean,
): Record<string, unknown> {
  if (!touchesPersistedData(prev, next, own)) return next;
  if (next.isDirty === true) return next;
  // Note there is deliberately no "the update set isDirty itself, so respect
  // it" escape hatch: undo/redo apply a FULL replacement state, which always
  // carries whatever `isDirty` was before the step, and an undo is an unsaved
  // change. The clean-slate declarations (markSaved) don't touch persisted keys
  // and so never reach here; the load paths call markSaved LAST, after their
  // mutations, which is what makes a freshly-opened feed read as saved.
  return { ...next, isDirty: true };
}

type ImmerWithHistory = <
  T,
  Mps extends [StoreMutatorIdentifier, unknown][] = [],
  Mcs extends [StoreMutatorIdentifier, unknown][] = [],
  U = T,
>(
  initializer: StateCreator<T, [...Mps, ['zustand/immer', never]], Mcs, U>,
) => StateCreator<T, Mps, [['zustand/immer', never], ...Mcs], U>;

/* eslint-disable @typescript-eslint/no-explicit-any */
const immerWithHistoryImpl =
  (initializer: any) =>
  (set: any, get: any, store: any) => {
    store.setState = (updater: any, replace?: any, ...args: any[]) => {
      const prev = get() as Record<string, unknown>;

      // Plain-object / partial updates (incl. the undo/redo apply path) don't
      // carry a recipe — nothing to diff for history, but they still change
      // feed data (an undo IS an unsaved change), so they get the dirty check.
      if (typeof updater !== 'function') {
        const partial = updater as Record<string, unknown>;
        return set(withDirty(prev, partial, true), replace, ...args);
      }
      // During a suppressed bulk load (or undo/redo apply) skip the patch work
      // and behave exactly like the stock immer middleware.
      if (isSuppressed()) {
        const nextState = produce(prev, updater as (d: Draft<unknown>) => void) as Record<
          string,
          unknown
        >;
        return set(withDirty(prev, nextState, false), replace, ...args);
      }
      // `get()` is `unknown` here, which trips up produceWithPatches' overload
      // inference (it resolves to the curried form); call through `any` — the
      // surrounding impl is already untyped zustand-mutator plumbing.
      const [nextState, patches, inversePatches] = (produceWithPatches as any)(
        prev,
        updater as (d: Draft<unknown>) => void,
      );
      recordChange(patches, inversePatches);
      return set(withDirty(prev, nextState, false), replace, ...args);
    };
    return initializer(store.setState, get, store);
  };
/* eslint-enable @typescript-eslint/no-explicit-any */

export const immerWithHistory = immerWithHistoryImpl as unknown as ImmerWithHistory;
