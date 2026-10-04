// Shared, DOM-free pieces of the validation UI (ValidationPanel and
// ExportDialog), split out so they can be unit-tested in the node env.
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore, type AppStore } from '../../store';
import { HISTORY_KEYS } from '../../store/history';
import { runValidation, VALIDATION_INPUT_KEYS } from '../../services/validation';
import type { ValidationMessage } from '../../types/ui';

/** The store slices runValidation reads, as a tuple. Shallow-compared, so a
 * change to any of them (and only them) re-runs validation. Built from the
 * validator's own VALIDATION_INPUT_KEYS so the deps can't drift out of sync
 * with what it reads (C3-11: translations and feedInfo were missing). */
export function selectValidationInputs(s: AppStore): unknown[] {
  return VALIDATION_INPUT_KEYS.map((k) => s[k]);
}

/** runValidation, memoized on the validator's inputs. Unrelated store changes
 * (selection, UI state, a dialog's own typing) don't re-validate the feed. */
export function useValidationMessages(): ValidationMessage[] {
  const inputs = useStore(useShallow(selectValidationInputs));
  return useMemo(
    () => {
      void inputs; // the memo key; the validator reads the live store
      return runValidation(useStore.getState());
    },
    [inputs],
  );
}

/** Only warnings can be dismissed. An error still blocks export (ExportDialog
 * gates on every error), so hiding it in the panel would leave the user with a
 * disabled Export button and no visible reason (C3-12). */
export function isDismissible(m: ValidationMessage): boolean {
  return !!m.code && m.severity !== 'error';
}

/** Split messages into the active list and the dismissed drawer. A dismissed
 * rule code hides its warnings only; errors with that code stay visible. */
export function partitionDismissed(
  messages: ValidationMessage[],
  dismissedCodes: readonly string[],
): { visible: ValidationMessage[]; dismissed: ValidationMessage[] } {
  const visible: ValidationMessage[] = [];
  const dismissed: ValidationMessage[] = [];
  for (const m of messages) {
    if (isDismissible(m) && dismissedCodes.includes(m.code!)) dismissed.push(m);
    else visible.push(m);
  }
  return { visible, dismissed };
}

type Subscribable = {
  subscribe: (listener: (state: AppStore, prev: AppStore) => void) => () => void;
};

/** Call `onChange` once, on the first later store change that touches feed
 * data (any HISTORY_KEYS slice). Used to retire a validation-fix Undo toast as
 * soon as anything else edits the feed: its undo restores a snapshot taken at
 * fix time, so pressing it after later edits could drop them (C3-13).
 * Returns the unsubscribe function. */
export function onNextFeedDataChange(
  store: Subscribable,
  onChange: () => void,
): () => void {
  let done = false;
  const unsubscribe = store.subscribe((state, prev) => {
    if (done) return;
    const s = state as unknown as Record<string, unknown>;
    const p = prev as unknown as Record<string, unknown>;
    for (const key of HISTORY_KEYS) {
      if (s[key] !== p[key]) {
        done = true;
        unsubscribe();
        onChange();
        return;
      }
    }
  });
  return () => {
    done = true;
    unsubscribe();
  };
}
