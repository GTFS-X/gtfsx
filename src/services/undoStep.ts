import type { Patch } from 'immer';
import { useStore } from '../store';
import { HISTORY_KEYS, recordChange, runWithoutHistory } from '../store/history';

/**
 * Run `fn`'s store mutations as ONE undo step.
 *
 * INTEGRATION POINT: a `historyTransaction(label, fn)` with these semantics is
 * being added to store/history.ts. Once it lands, make this a thin
 * re-export of it (or replace the call sites) — do not keep two copies.
 *
 * Suspends recording while `fn` runs, then records a single entry of
 * whole-key replace patches (references only, so cheap) for every history key
 * `fn` changed. Nothing is recorded when nothing changed.
 */
export function asOneUndoStep(fn: () => void): void {
  const before = useStore.getState() as unknown as Record<string, unknown>;
  const snap = new Map<string, unknown>();
  for (const k of HISTORY_KEYS) snap.set(k, before[k]);
  runWithoutHistory(fn);
  const after = useStore.getState() as unknown as Record<string, unknown>;
  const patches: Patch[] = [];
  const inverse: Patch[] = [];
  for (const [k, v] of snap) {
    if (after[k] === v) continue;
    patches.push({ op: 'replace', path: [k], value: after[k] });
    inverse.push({ op: 'replace', path: [k], value: v });
  }
  if (patches.length > 0) recordChange(patches, inverse);
}
