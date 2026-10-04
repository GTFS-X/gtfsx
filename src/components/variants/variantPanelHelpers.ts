// Pure presentation logic for the variants management panel — kept out of the
// component so it's unit-testable without rendering.
import type { FeedDiff, FeedState } from '../../services/feedDiff';

// Every store array the variant diff reads. A Record over keyof FeedState so a
// new FeedState field fails to compile here until it's subscribed too.
const DIFF_KEY_RECORD: Record<keyof FeedState, true> = {
  routes: true,
  routeStops: true,
  trips: true,
  stopTimes: true,
  stops: true,
  calendars: true,
  calendarDates: true,
  frequencies: true,
};
export const VARIANT_DIFF_KEYS = Object.keys(DIFF_KEY_RECORD) as (keyof FeedState)[];

/**
 * The live feed arrays the diff reads, for a `useShallow` subscription: the
 * panel's chips for the active variant (and, when the baseline is active, for
 * every variant) read the live store, so they must recompute when these
 * change (C2-15).
 */
export function pickDiffInputs(s: FeedState): FeedState {
  const out = {} as Record<keyof FeedState, unknown>;
  for (const k of VARIANT_DIFF_KEYS) out[k] = s[k];
  return out as FeedState;
}

const MINUS = '−'; // U+2212, matches the compare dialog's delta glyph

function signed(n: number): string {
  return n > 0 ? `+${n}` : `${MINUS}${Math.abs(n)}`;
}
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Compact per-variant change chips vs baseline, from a feedDiff. Empty when the
 * variant is identical to baseline (the caller shows "No changes"). Cheap — uses
 * only the diff's entity counts, no spatial/network work.
 */
export function summarizeDiff(diff: FeedDiff | null): string[] {
  if (!diff || diff.identical) return [];
  const out: string[] = [];
  if (diff.trips.delta !== 0) out.push(`${signed(diff.trips.delta)} trips`);
  if (diff.routes.added) out.push(`+${plural(diff.routes.added, 'route')}`);
  if (diff.routes.removed) out.push(`${MINUS}${plural(diff.routes.removed, 'route')}`);
  if (diff.routes.changed) out.push(`${plural(diff.routes.changed, 'route')} changed`);
  const stopEdits = diff.stops.added + diff.stops.removed + diff.stops.changed;
  if (stopEdits) out.push(plural(stopEdits, 'stop edit'));
  const freqEdits = diff.frequencies.added + diff.frequencies.removed + diff.frequencies.changed;
  if (freqEdits) out.push(plural(freqEdits, 'frequency edit'));
  const patternEdits = diff.patterns.added + diff.patterns.removed;
  if (patternEdits) out.push(plural(patternEdits, 'pattern change'));
  const calendarEdits = diff.calendars.added + diff.calendars.removed + diff.calendars.changed;
  if (calendarEdits) out.push(plural(calendarEdits, 'service pattern edit'));
  // Re-timed trips or changed calendar_dates move no count, so without this a
  // uniform 15-minute shift read "no changes vs baseline" (S1-26).
  if (diff.scheduleChanged) out.push('schedule changed');
  // Not identical, but nothing above names the change (e.g. per-route KPIs
  // only): never fall through to "no changes".
  if (!out.length) out.push('service changed');
  return out;
}

export interface RowActions {
  canSwitch: boolean;
  canRename: boolean;
  canDuplicate: boolean;
  canDelete: boolean;
  canPromote: boolean;
  canCompare: boolean;
}

/**
 * Which actions a variant row exposes. The baseline is protected (no delete /
 * promote) and comparing it to itself is meaningless (no compare); the active
 * variant has no "switch" (you're already on it). Everything is renameable and
 * duplicable, including the baseline.
 */
export function rowActions(variant: { baseline: boolean }, isActive: boolean): RowActions {
  return {
    canSwitch: !isActive,
    canRename: true,
    canDuplicate: true,
    canDelete: !variant.baseline,
    canPromote: !variant.baseline,
    canCompare: !variant.baseline,
  };
}
