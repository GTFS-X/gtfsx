// One-click "Fix" catalog for validation errors.
//
// A ValidationMessage can carry an optional `fix: { id }` descriptor (see
// types/ui.ts). This registry maps that stable id → a ValidationFix with a
// human label/description and an `apply(message)` that mutates the store (via
// store actions) and returns an undo handle. The validation panel renders a
// "Fix" button for any message whose id is registered here; clicking it applies
// the fix and shows an undo toast.
//
// The undo-snapshot pattern mirrors the wheelchair bulk-fill (store/stopSlice.ts
// `fillMissingWheelchairBoarding` + `restoreWheelchairBoarding`): the store
// action returns a data snapshot of what it changed, and a paired restore action
// reverses it. Here `apply` wraps that into a generic `{ changed, label, undo }`
// so the panel stays fix-agnostic.
import type { ValidationFixId, ValidationMessage } from '../types/ui';
import { useStore } from '../store';
import { omittedTranslationIndices } from './translations';
import { serviceDateRange } from './feedInfo';

/** The result of applying a fix: a human label for the undo toast, whether
 *  anything actually changed (false → caller can skip the toast), and a closure
 *  that reverses the mutation. */
export interface ValidationFixResult {
  fixId: ValidationFixId;
  label: string;
  changed: boolean;
  undo: () => void;
}

export interface ValidationFix {
  id: ValidationFixId;
  /** Button label shown in the validation panel (e.g. "Fix"). */
  label: string;
  /** Tooltip / a11y description of what the fix does. */
  description: string;
  /**
   * True when this recipe needs a dedicated dialog rather than a one-click
   * mutation (e.g. it's async, needs user-chosen options, or shows progress).
   * The panel opens that dialog instead of calling `apply` — see the
   * `interactive` special-case in components/validation/ValidationPanel.tsx,
   * which mirrors the existing wheelchair-picker special-case. `apply` is
   * absent on these fixes so the batch "Fix all" path can never invoke them.
   */
  interactive?: boolean;
  /** Mutate the store to resolve `message`; return an undo handle. Omitted
   *  for `interactive` fixes (there's no one-click mutation to run). */
  apply?: (message: ValidationMessage) => ValidationFixResult;
  /**
   * An alternative remedy for the same messages, offered beside the main one
   * (e.g. "Clear" next to "Recompute"). Must be a registered, non-interactive
   * fix; the panel renders it as a secondary button and calls it with the
   * same message(s).
   */
  secondary?: ValidationFixId;
}

const FIXES: Record<ValidationFixId, ValidationFix> = {
  'fill-trip-edge-times': {
    id: 'fill-trip-edge-times',
    label: 'Fix',
    description:
      "Copy the one present time into the blank field on the trip's first/last "
      + 'stop, so arrival_time and departure_time both have a value (the '
      + "recommended remedy for a partially-timed trip endpoint). You can undo this.",
    apply: (message) => {
      const tripId = message.entity_id ?? '';
      // fillTripEdgeTimes touches ONLY endpoints with exactly one of
      // arrival/departure set — the both-blank (interpolated) endpoint the
      // validator flags separately is left untouched here.
      const snapshot = useStore.getState().fillTripEdgeTimes(tripId);
      return {
        fixId: 'fill-trip-edge-times',
        changed: snapshot.length > 0,
        label: snapshot.length > 0
          ? `Filled trip-edge time${snapshot.length === 1 ? '' : 's'} on trip "${tripId}".`
          : 'Nothing to fix on this trip.',
        undo: () => useStore.getState().restoreTripEdgeTimes(snapshot),
      };
    },
  },

  'fill-missing-wheelchair': {
    id: 'fill-missing-wheelchair',
    label: 'Fix',
    description:
      'Fill wheelchair_boarding on every board point that is missing a value. Choose '
      + 'which value to apply: 1 (accessible) or 2 (not accessible) records the status '
      + 'and clears the warning; 0 (no information) marks the stops reviewed without '
      + 'asserting a status. You can undo this.',
    // The validation panel renders a VALUE PICKER for this fix and calls
    // applyWheelchairFill(value) directly. This generic apply is the fallback
    // (e.g. the batch path): it fills 0 = "no information", the non-asserting
    // default.
    apply: () => applyWheelchairFill(0),
  },

  'remove-orphan-trips': {
    id: 'remove-orphan-trips',
    label: 'Fix',
    description:
      'Removes this trip (and its stop_times and any frequency windows) because its '
      + 'service_id does not match any calendar. The trip cannot run without a '
      + 'calendar — delete it or reassign it to a valid service_id first. You can undo this.',
    apply: (message) => {
      const tripId = message.entity_id ?? '';
      const snapshot = useStore.getState().removeTripWithSnapshot(tripId);
      const stCount = snapshot.stopTimes.length;
      const fqCount = snapshot.frequencies.length;
      return {
        fixId: 'remove-orphan-trips',
        changed: snapshot.trip !== undefined,
        label: snapshot.trip
          ? `Removed orphan trip "${tripId}" (${stCount} stop time${stCount === 1 ? '' : 's'}`
            + `${fqCount > 0 ? `, ${fqCount} frequency window${fqCount === 1 ? '' : 's'}` : ''}).`
          : `Trip "${tripId}" not found — nothing removed.`,
        undo: () => useStore.getState().restoreTrip(snapshot),
      };
    },
  },

  'remove-ghost-trips': {
    id: 'remove-ghost-trips',
    label: 'Fix',
    description:
      "Removes this trip (and its stop_times and any frequency windows) because it "
      + "can't be reached in the timetable editor: its route has shapes but this trip "
      + 'has no matching shape, so the grid hides it. Delete it here, or assign it a '
      + 'shape to make it visible. You can undo this.',
    apply: (message) => {
      const tripId = message.entity_id ?? '';
      const snapshot = useStore.getState().removeTripWithSnapshot(tripId);
      const stCount = snapshot.stopTimes.length;
      const fqCount = snapshot.frequencies.length;
      return {
        fixId: 'remove-ghost-trips',
        changed: snapshot.trip !== undefined,
        label: snapshot.trip
          ? `Removed unreachable trip "${tripId}" (${stCount} stop time${stCount === 1 ? '' : 's'}`
            + `${fqCount > 0 ? `, ${fqCount} frequency window${fqCount === 1 ? '' : 's'}` : ''}).`
          : `Trip "${tripId}" not found — nothing removed.`,
        undo: () => useStore.getState().restoreTrip(snapshot),
      };
    },
  },

  'delete-unused-stop': {
    id: 'delete-unused-stop',
    label: 'Fix',
    description:
      'Deletes this stop because no trip serves it (no stop_times reference it). '
      + 'Also removes any orphaned route_stops and transfers that reference it. '
      + 'You can undo this.',
    apply: (message) => {
      const stopId = message.entity_id ?? '';
      const snapshot = useStore.getState().removeStopWithSnapshot(stopId);
      const name = snapshot.stop?.stop_name || stopId;
      return {
        fixId: 'delete-unused-stop',
        changed: snapshot.stop !== undefined,
        label: snapshot.stop
          ? `Deleted unused stop "${name}".`
          : `Stop "${stopId}" not found — nothing deleted.`,
        undo: () => useStore.getState().restoreStop(snapshot),
      };
    },
  },

  'generate-shapes-from-stops': {
    id: 'generate-shapes-from-stops',
    label: 'Generate shapes',
    description:
      'Opens a dialog that builds a shape for every stop pattern missing one (snapped to '
      + 'the road network, or straight lines between stops), links it onto the matching '
      + 'trips, and flags any pattern that needs a second look. Interactive (network calls '
      + 'and a mode choice), so it runs from its own dialog rather than one click. '
      + 'You can undo the whole batch afterward.',
    // No `apply` — this recipe is interactive-only (see the `interactive` doc
    // above). applyValidationFix / applyValidationFixBatch both skip it.
    interactive: true,
  },

  'clear-route-desc': {
    id: 'clear-route-desc',
    label: 'Clear',
    description:
      'Clears route_desc on this route because it only repeats the route name, which adds '
      + 'no information for riders. The name is unchanged; only the redundant description is '
      + 'removed. You can undo this.',
    apply: (message) => {
      const routeId = message.entity_id ?? '';
      const route = useStore.getState().routes.find((r) => r.route_id === routeId);
      const prev = route?.route_desc;
      const had = route !== undefined && prev !== undefined && prev !== '';
      if (had) useStore.getState().updateRoute(routeId, { route_desc: '' });
      const label = route?.route_short_name || route?.route_long_name || routeId;
      return {
        fixId: 'clear-route-desc',
        changed: had,
        label: had
          ? `Cleared the redundant description on route "${label}".`
          : `Route "${routeId}" has no redundant description — nothing changed.`,
        undo: () => { if (had) useStore.getState().updateRoute(routeId, { route_desc: prev }); },
      };
    },
  },

  'recompute-shape-distances': {
    id: 'recompute-shape-distances',
    label: 'Recompute',
    description:
      'Recomputes shape_dist_traveled along the shape as it is now: the shape\'s own column, '
      + 'and the stop distances of every trip on it, found by placing each stop on the shape '
      + 'in stop order (a loop or out-and-back that passes a stop twice gets the right pass). '
      + 'Values stay in the unit the feed already uses. A trip whose stops can\'t be placed '
      + 'has its distances cleared instead. Fix all recomputes every flagged shape in the feed. '
      + 'You can undo this.',
    secondary: 'clear-shape-distances',
    apply: (message) => {
      const shapeId = message.entity_id ?? '';
      const report = useStore.getState().recalcShapeDistances(shapeId);
      const changed = !!report && (report.stopTimesChanged > 0 || report.shapeChanged);
      const cleared = report?.tripsCleared.length ?? 0;
      return {
        fixId: 'recompute-shape-distances',
        changed,
        label: !report
          ? `Shape "${shapeId}" not found — nothing changed.`
          : `Recomputed distances on shape "${shapeId}" (${report.tripsRecomputed} trip${report.tripsRecomputed === 1 ? '' : 's'}, ${report.unit})`
            + (cleared > 0 ? `; cleared ${cleared} trip${cleared === 1 ? '' : 's'} whose stops couldn't be placed.` : '.'),
        undo: () => { if (report) useStore.getState().restoreShapeDistances(report.snapshot); },
      };
    },
  },

  'clear-shape-distances': {
    id: 'clear-shape-distances',
    label: 'Clear',
    description:
      'Removes stop_times.shape_dist_traveled from every trip on the shape. The column is '
      + 'optional; without it, apps place stops by their coordinates instead. The shape\'s own '
      + 'distances are recomputed from its geometry so they stay consistent. You can undo this.',
    apply: (message) => {
      const shapeId = message.entity_id ?? '';
      const report = useStore.getState().clearShapeDistances(shapeId);
      return {
        fixId: 'clear-shape-distances',
        changed: !!report && report.stopTimesChanged > 0,
        label: report
          ? `Cleared ${report.stopTimesChanged} stop distance${report.stopTimesChanged === 1 ? '' : 's'} on shape "${shapeId}".`
          : `Shape "${shapeId}" not found — nothing changed.`,
        undo: () => { if (report) useStore.getState().restoreShapeDistances(report.snapshot); },
      };
    },
  },

  'remove-invalid-translations': {
    id: 'remove-invalid-translations',
    label: 'Remove',
    description:
      'Deletes every translations.txt row the export already leaves out — rows that point at a '
      + 'record that no longer exists, use a malformed language code, repeat another row, or break '
      + "the spec's record_id / field_value rules. Valid translations are untouched. You can undo this.",
    apply: () => {
      const before = useStore.getState().translations;
      const drop = omittedTranslationIndices(useStore.getState());
      // Undo re-inserts ONLY the removed rows (at their original positions)
      // into whatever the table holds then, so translation edits made after
      // the fix survive the undo.
      const removed = [...new Set(drop)].sort((a, b) => a - b).map((i) => [i, before[i]] as const);
      if (drop.length > 0) useStore.getState().removeTranslationsAt(drop);
      return {
        fixId: 'remove-invalid-translations',
        changed: drop.length > 0,
        label: drop.length > 0
          ? `Removed ${drop.length} invalid translation${drop.length === 1 ? '' : 's'}.`
          : 'No invalid translations left to remove.',
        undo: () => {
          if (removed.length === 0) return;
          const next = [...useStore.getState().translations];
          // Ascending original indices: each insert lands where the row was,
          // relative to the rows that were kept.
          for (const [i, row] of removed) next.splice(Math.min(i, next.length), 0, row);
          useStore.getState().setTranslations(next);
        },
      };
    },
  },

  'feed-info-dates-from-service': {
    id: 'feed-info-dates-from-service',
    label: 'Fix',
    description:
      "Sets feed_info's start and end dates to the span your service calendar covers (the "
      + 'earliest to the latest date in calendar.txt and added calendar_dates.txt service), so '
      + "apps stop reading the feed as expired. Nothing else changes. You can undo this.",
    apply: () => applyServiceDatesToFeedInfo('feed-info-dates-from-service'),
  },
};

/** Set feed_info.feed_start_date / feed_end_date from the service calendar.
 *  Shared by the validation fix recipe and the "Set dates from service
 *  calendar" button in Agency → Feed Info. Creates feed_info when the feed has
 *  none. Returns a ValidationFixResult so both callers can offer undo. */
export function applyServiceDatesToFeedInfo(
  fixId: ValidationFixId = 'feed-info-dates-from-service',
): ValidationFixResult {
  const state = useStore.getState();
  const range = serviceDateRange(state.calendars, state.calendarDates);
  const before = state.feedInfo;
  const prev = { start: before?.feed_start_date, end: before?.feed_end_date };
  if (!range) {
    return { fixId, changed: false, label: 'No service calendar dates to copy.', undo: () => {} };
  }
  const changed = prev.start !== range.start || prev.end !== range.end;
  if (changed) state.updateFeedInfo({ feed_start_date: range.start, feed_end_date: range.end });
  const pretty = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  return {
    fixId,
    changed,
    label: changed
      ? `Set feed dates to ${pretty(range.start)} – ${pretty(range.end)} from the service calendar.`
      : 'Feed dates already match the service calendar.',
    undo: () => {
      if (!changed) return;
      if (before === null) {
        // feed_info didn't exist before: drop only the two dates, keeping
        // anything typed into the panel since.
        useStore.getState().updateFeedInfo({ feed_start_date: undefined, feed_end_date: undefined });
        return;
      }
      useStore.getState().updateFeedInfo({ feed_start_date: prev.start, feed_end_date: prev.end });
    },
  };
}

/** Look up a registered fix by id (undefined if the id isn't in the catalog —
 *  e.g. a message persisted with an id this build no longer ships). */
export function getValidationFix(id: ValidationFixId): ValidationFix | undefined {
  return FIXES[id];
}

/** Board-point stops (location_type 0) missing an authoritative
 *  wheelchair_boarding value — 0 OR absent both read as "no information". */
function wheelchairGapStopIds(): string[] {
  return useStore.getState().stops
    .filter((s) => (s.location_type ?? 0) === 0)
    .filter((s) => s.wheelchair_boarding !== 1 && s.wheelchair_boarding !== 2)
    .map((s) => s.stop_id);
}

export const WHEELCHAIR_VALUE_LABEL: Record<number, string> = {
  0: 'no info',
  1: 'accessible',
  2: 'not accessible',
};

/** Count of board points that would be filled (for the picker's button label). */
export function wheelchairGapCount(): number {
  return wheelchairGapStopIds().length;
}

/** Fill every board point missing wheelchair_boarding with `value` (0/1/2), for
 *  the Validation panel's wheelchair fix-recipe value picker. Returns a
 *  ValidationFixResult so the panel's undo toast reverses it. Note: filling 0
 *  ("no info") does not clear the validator warning (GTFS treats blank and 0
 *  identically); 1 or 2 does. */
export function applyWheelchairFill(value: number): ValidationFixResult {
  const ids = wheelchairGapStopIds();
  const snapshot = useStore.getState().fillMissingWheelchairBoarding(ids, value);
  const n = snapshot.length;
  const label = WHEELCHAIR_VALUE_LABEL[value] ?? String(value);
  return {
    fixId: 'fill-missing-wheelchair',
    changed: n > 0,
    label: n > 0
      ? `Set wheelchair_boarding = ${value} (${label}) on ${n} stop${n === 1 ? '' : 's'}.`
      : 'Nothing to fill — all board points already have a value.',
    undo: () => useStore.getState().restoreWheelchairBoarding(snapshot),
  };
}

/** Apply the fix a message carries, if any. Returns the undo result, or null
 *  when the message has no fix, its id isn't registered, or it's `interactive`
 *  (no `apply` — the caller should open its dialog instead; see
 *  components/validation/ValidationPanel.tsx). */
export function applyValidationFix(message: ValidationMessage, overrideFixId?: ValidationFixId): ValidationFixResult | null {
  if (!message.fix) return null;
  if (overrideFixId && FIXES[message.fix.id]?.secondary !== overrideFixId) return null;
  const fix = FIXES[overrideFixId ?? message.fix.id];
  if (!fix || !fix.apply) return null;
  return fix.apply(message);
}

/**
 * Apply the relevant fix to EVERY message in a group that carries one, as a
 * single undoable step. Each per-message `apply` already returns its own undo;
 * we run them in order, count how many actually changed (vs were already fine),
 * and fold the per-message undos into one closure so the panel's existing
 * single-fix undo toast can reverse the whole batch.
 *
 * Returns a ValidationFixResult shaped exactly like the single-fix path (so the
 * toast component is unchanged): `label` reports "Fixed X of N" (with the
 * already-fine remainder), `changed` is true when at least one row changed, and
 * `undo()` reverses all of them. Returns null when no message in the batch has a
 * registered fix. Re-running validation after a batch is automatic: the fixes
 * mutate store slices the validation memo depends on, so the list refreshes.
 *
 * `interactive` fixes (no `apply`) are skipped here — they can never be
 * silently invoked by the batch "Fix all" path; the panel doesn't even show
 * that affordance for them (see ValidationPanel.tsx), but this guard holds
 * even if a caller passes one in directly.
 */
export function applyValidationFixBatch(messages: ValidationMessage[], overrideFixId?: ValidationFixId): ValidationFixResult | null {
  const results: ValidationFixResult[] = [];
  let total = 0;
  let changed = 0;
  let fixId: ValidationFixId | null = null;
  for (const m of messages) {
    if (!m.fix) continue;
    // overrideFixId runs a message's SECONDARY remedy (e.g. Clear instead of
    // Recompute) — only when the message's own fix declares it.
    const id = overrideFixId && FIXES[m.fix.id]?.secondary === overrideFixId ? overrideFixId : m.fix.id;
    if (overrideFixId && id !== overrideFixId) continue;
    const fix = FIXES[id];
    if (!fix || !fix.apply) continue;
    total++;
    fixId = id;
    const r = fix.apply(m);
    results.push(r);
    if (r.changed) changed++;
  }
  if (total === 0 || fixId === null) return null;
  const alreadyFine = total - changed;
  const label = changed > 0
    ? `Fixed ${changed} of ${total}${alreadyFine > 0 ? ` (${alreadyFine} already fine)` : ''}.`
    : `Nothing to fix (all ${total} already fine).`;
  return {
    fixId,
    changed: changed > 0,
    label,
    // Reverse order so overlapping snapshots unwind cleanly (independent here,
    // but order-safe by construction).
    undo: () => { for (let i = results.length - 1; i >= 0; i--) results[i].undo(); },
  };
}
