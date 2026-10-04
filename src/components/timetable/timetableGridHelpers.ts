import { type RefObject, useEffect, useLayoutEffect, useState } from 'react';
import { formatTimeShort, gtfsTimeToSeconds, normalizeTimeInput, secondsToGtfsTime } from '../../utils/time';
import { validateFrequencyWindows, type FrequencyWindow } from '../../services/frequencyExpansion';

/* ============================================================================
   Layout constants + content-based column widths (HANDOFF §5)
   ========================================================================== */

export const TRIP_COL_MIN = 58;
export const TRIP_COL_DEFAULT = 78;
export const COL_MIN = 58;
export const COL_MAX = 300;

/* ============================================================================
   Split-view divider ratio (draggable pane resize)
   ========================================================================== */

/** Neither split pane may drop below this — a timetable narrower than this is
 *  unusable (Trip + actions + a couple of stop columns). */
export const SPLIT_MIN_PANE_PX = 300;
export const SPLIT_DEFAULT_RATIO = 0.5;

/** Clamp a left-pane width fraction so both panes keep SPLIT_MIN_PANE_PX. When
 *  the container can't fit two min-width panes (narrow / 390px mobile), the split
 *  is pinned even (0.5) — the caller also disables dragging there. Pure. */
export function clampSplitRatio(ratio: number, containerWidth: number, minPanePx = SPLIT_MIN_PANE_PX): number {
  if (!(containerWidth > 0) || containerWidth < 2 * minPanePx) return SPLIT_DEFAULT_RATIO;
  const min = minPanePx / containerWidth;
  return Math.min(1 - min, Math.max(min, ratio));
}

/** Whether the divider can be dragged at a given container width (both panes can
 *  still meet the minimum). Below this the split is a fixed even 50/50. */
export function splitResizable(containerWidth: number, minPanePx = SPLIT_MIN_PANE_PX): boolean {
  return containerWidth >= 2 * minPanePx;
}

/** The left-pane fraction for a pointer x within the container, clamped. Pure. */
export function splitRatioFromPointer(pointerX: number, containerLeft: number, containerWidth: number, minPanePx = SPLIT_MIN_PANE_PX): number {
  return clampSplitRatio((pointerX - containerLeft) / containerWidth, containerWidth, minPanePx);
}

/* ============================================================================
   Default direction on route select — the direction that begins service first
   ========================================================================== */

/** The direction a freshly selected route should default to: the one with the
 *  earliest first departure among the given trips (each carries its first-stop
 *  time in seconds, or null if untimed). Direction 1 wins only when it is
 *  STRICTLY earlier; ties and no-times fall back to 0. Pure. */
export function earliestDepartureDirection(trips: { directionId: 0 | 1; firstSec: number | null }[]): 0 | 1 {
  let min0: number | null = null;
  let min1: number | null = null;
  for (const t of trips) {
    if (t.firstSec == null) continue;
    if (t.directionId === 1) { if (min1 == null || t.firstSec < min1) min1 = t.firstSec; }
    else { if (min0 == null || t.firstSec < min0) min0 = t.firstSec; }
  }
  if (min1 != null && (min0 == null || min1 < min0)) return 1;
  return 0;
}

/** Flip direction_id (0↔1) on every item of one route, leaving other routes
 *  untouched. Works for trips and route_stops alike (both carry route_id +
 *  direction_id). Pure — returns a new array. */
export function swapRouteDirections<T extends { route_id: string; direction_id: 0 | 1 }>(items: T[], routeId: string): T[] {
  return items.map((it) => (it.route_id === routeId ? { ...it, direction_id: (it.direction_id === 0 ? 1 : 0) as 0 | 1 } : it));
}

export type RowActionStyle = 'menu' | 'strip' | 'flyout';

/** Width of the sticky actions column for a given presentation. */
export function actColWidth(mode: RowActionStyle): number {
  return mode === 'strip' ? 140 : 34;
}

/** Content-based default column width: a time is ~5ch of mono (the floor); the
 *  header ellipsizes; the cap keeps a long stop name from eating the viewport.
 *  Widens to fit two stacked inputs when the column authors arr/dep. */
export function defaultColWidth(name: string, isTimepoint: boolean, arrDep: boolean): number {
  const label = 22 + name.length * 5.9 + (isTimepoint ? 13 : 0);
  return Math.round(Math.max(arrDep ? 74 : 64, Math.min(136, label)));
}

/* ============================================================================
   Row-order validation (HANDOFF §8 — computeBad)
   ========================================================================== */

function hmsToSec(hms: string): number {
  const [h = 0, m = 0, s = 0] = hms.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

/** Mark a cell red when its time is unparseable or earlier than the previous
 *  non-blank time in the row (typo / inversion catch). Equal consecutive times
 *  are legal (GTFS times are non-decreasing along a trip; a zero dwell or two
 *  stops in the same minute is fine). Arr/dep pairs (`arr/dep`) are checked in
 *  order. */
export function computeRowErrors(times: (string | null)[]): boolean[] {
  let prev = -1;
  return times.map((t) => {
    if (t == null || t === '') return false; // blank / skipped — no error
    let bad = false;
    for (const part of String(t).split('/')) {
      if (part === '') continue;
      const norm = normalizeTimeInput(part);
      if (!norm) { bad = true; continue; }
      const sec = hmsToSec(norm);
      if (sec < prev) bad = true;
      else prev = sec;
    }
    return bad;
  });
}

/** The value a row-order check sees for one stop_time: the arr/dep pair when
 *  they differ (so a departure before its arrival, or a next arrival before this
 *  departure, is caught), else the single time. null = no stop_time (skipped). */
export function rowTimeValue(st: { arrival_time?: string; departure_time?: string } | undefined): string | null {
  if (!st) return null;
  const a = st.arrival_time || '';
  const d = st.departure_time || '';
  if (a && d && a !== d) return `${a}/${d}`;
  return a || d;
}

/* ============================================================================
   Cell commit decision (pure)
   ========================================================================== */

export type CellCommitDecision =
  | { kind: 'skip' }
  | { kind: 'commit'; value: string }
  | { kind: 'invalid' };

/** What leaving a time cell should do. `focusDisplay` is the text the cell
 *  showed when it took focus. Leaving it unchanged is navigation, not an edit:
 *  the display is lossy (HH:MM drops seconds, single mode hides the dwell,
 *  unpadded times get padded), so committing it would rewrite the stop_time.
 *  Otherwise: '' clears, a parseable time commits normalized, else invalid. */
export function cellCommitDecision(raw: string, focusDisplay: string | null): CellCommitDecision {
  const trimmed = raw.trim();
  if (focusDisplay !== null && trimmed === focusDisplay.trim()) return { kind: 'skip' };
  if (!trimmed) return { kind: 'commit', value: '' };
  const normalized = normalizeTimeInput(trimmed);
  return normalized ? { kind: 'commit', value: normalized } : { kind: 'invalid' };
}

/* ============================================================================
   Service selection (pure)
   ========================================================================== */

/** The service a pane shows: the requested one if it exists (calendar.txt or
 *  calendar_dates.txt), else the first service, else null. */
export function resolveActiveServiceId(requested: string | null, serviceIds: readonly string[]): string | null {
  if (requested && serviceIds.includes(requested)) return requested;
  return serviceIds[0] ?? null;
}

/** A default calendar is only materialized for a feed with no service at all.
 *  A calendar_dates-only feed already has services. */
export function needsDefaultCalendar(state: { calendars: readonly unknown[]; calendarDates: readonly unknown[] }): boolean {
  return state.calendars.length === 0 && state.calendarDates.length === 0;
}

/* ============================================================================
   Cell edit → stop_time update (pure)
   ========================================================================== */

export type CellField = 'both' | 'arrival_time' | 'departure_time';

/** The arrival/departure pair to store after a cell edit. `normalized` is a
 *  GTFS time, or '' for an explicit clear.
 *  - 'both' (single-time column): the shown time is the arrival, so the arrival
 *    becomes the new time and the departure moves by the same delta, keeping
 *    any existing dwell. A clear empties both.
 *  - one half (arr/dep column): set that half. Clearing one half collapses the
 *    stop to the other half's time (a stop_time with only one of the two is not
 *    valid GTFS); clearing it when the other half is blank empties both. */
export function cellEditUpdate(
  st: { arrival_time?: string; departure_time?: string } | undefined,
  field: CellField,
  normalized: string,
): { arrival_time: string; departure_time: string } {
  const a = st?.arrival_time || '';
  const d = st?.departure_time || '';
  if (field === 'both') {
    if (!normalized) return { arrival_time: '', departure_time: '' };
    if (a && d && a !== d) {
      const dwell = gtfsTimeToSeconds(d) - gtfsTimeToSeconds(a);
      return { arrival_time: normalized, departure_time: secondsToGtfsTime(gtfsTimeToSeconds(normalized) + dwell) };
    }
    return { arrival_time: normalized, departure_time: normalized };
  }
  if (field === 'arrival_time') {
    if (!normalized) return { arrival_time: d, departure_time: d };
    return { arrival_time: normalized, departure_time: d || normalized };
  }
  if (!normalized) return { arrival_time: a, departure_time: a };
  return { arrival_time: a || normalized, departure_time: normalized };
}

/** The pre-edit time a cascade delta is measured from: the edited half (falling
 *  back to the other half when it was blank). */
export function cascadePrevTime(
  st: { arrival_time?: string; departure_time?: string } | undefined,
  field: CellField,
): string {
  if (field === 'departure_time') return st?.departure_time || st?.arrival_time || '';
  return st?.arrival_time || st?.departure_time || '';
}

/* ============================================================================
   Trip ordering (numeric — GTFS times may be unpadded, e.g. 8:05:00)
   ========================================================================== */

/** Start second of a trip: the departure (else arrival) of its lowest-sequence
 *  timed stop_time, or null when it has no times. */
export function tripStartSec(stopTimes: readonly { stop_sequence: number; arrival_time?: string; departure_time?: string }[] | undefined): number | null {
  let best: { seq: number; t: string } | null = null;
  for (const st of stopTimes ?? []) {
    const t = st.departure_time || st.arrival_time;
    if (!t) continue;
    if (!best || st.stop_sequence < best.seq) best = { seq: st.stop_sequence, t };
  }
  return best ? gtfsTimeToSeconds(best.t) : null;
}

/** Sort trips by numeric start second; untimed trips go last (stable). */
export function sortTripsByStart<T extends { trip_id: string }>(trips: readonly T[], startSecOf: (tripId: string) => number | null): T[] {
  const keyed = trips.map((t, i) => ({ t, i, s: startSecOf(t.trip_id) }));
  keyed.sort((x, y) => {
    if (x.s == null || y.s == null) return (x.s == null ? 1 : 0) - (y.s == null ? 1 : 0) || x.i - y.i;
    return x.s - y.s || x.i - y.i;
  });
  return keyed.map((k) => k.t);
}

/** Repeat-last's source: the last trip (in display order) that has a start
 *  time, skipping trailing blank trips. null when none is timed. */
export function lastTimedTrip<T extends { trip_id: string }>(trips: readonly T[], startSecOf: (tripId: string) => number | null): { trip: T; startSec: number } | null {
  for (let i = trips.length - 1; i >= 0; i--) {
    const s = startSecOf(trips[i].trip_id);
    if (s != null) return { trip: trips[i], startSec: s };
  }
  return null;
}

/* ============================================================================
   Timepoint columns (per pane, keyed by stop_sequence)
   ========================================================================== */

/** Which pane columns (by stop_sequence) are timepoints. A column is on when any
 *  of the pane's trips has timepoint=1 there. When none of the pane's trips sets
 *  timepoint explicitly at a column (no 0/1 value), the first and last columns
 *  default on — so marking a middle stop keeps the endpoints flagged. */
export function timepointSeqs(
  columnSeqs: readonly number[],
  tripIds: readonly string[],
  stopTimesOf: (tripId: string) => readonly { stop_sequence: number; timepoint?: number }[] | undefined,
): Set<number> {
  const on = new Set<number>();
  const explicit = new Set<number>();
  const cols = new Set(columnSeqs);
  for (const id of tripIds) {
    for (const st of stopTimesOf(id) ?? []) {
      if (!cols.has(st.stop_sequence)) continue;
      if (st.timepoint === 1) { on.add(st.stop_sequence); explicit.add(st.stop_sequence); }
      else if (st.timepoint === 0) explicit.add(st.stop_sequence);
    }
  }
  if (columnSeqs.length >= 2) {
    const first = columnSeqs[0];
    const last = columnSeqs[columnSeqs.length - 1];
    if (!explicit.has(first)) on.add(first);
    if (!explicit.has(last)) on.add(last);
  }
  return on;
}

/* ============================================================================
   Edit-frequency drawer (pure)
   ========================================================================== */

/** A stored frequency time as the drawer's text input shows it: HH:MM (with the
 *  "+1d" suffix past midnight), or full HH:MM:SS when the seconds aren't zero. */
export function frequencyTimeLabel(t: string): string {
  const n = normalizeTimeInput(t);
  if (!n) return t;
  return n.endsWith(':00') ? formatTimeShort(n) : n;
}

export interface FrequencyDrawerCheck {
  /** Windows with start/end normalized to HH:MM:SS ('' when unparseable). */
  normalized: FrequencyWindow[];
  errors: { badRange: boolean; badHeadway: boolean; badTime: boolean }[];
  overlaps: number[];
  /** Apply is allowed: zero windows (remove), or every window well-formed and
   *  none overlapping (the validator errors on overlapping windows). */
  canApply: boolean;
}

/** Parse the drawer's typed windows through normalizeTimeInput and validate.
 *  Garbage ("abc", "630") is a bad time and blocks Apply instead of being
 *  stored verbatim. */
export function checkFrequencyDrawer(windows: readonly FrequencyWindow[]): FrequencyDrawerCheck {
  const normalized = windows.map((w) => ({ ...w, start_time: normalizeTimeInput(w.start_time), end_time: normalizeTimeInput(w.end_time) }));
  const badTimes = normalized.map((w) => !w.start_time || !w.end_time);
  // Only parseable windows take part in the overlap sweep.
  const parseable = normalized.map((w, i) => (badTimes[i] ? { ...w, start_time: '00:00:00', end_time: '00:00:00' } : w));
  const base = validateFrequencyWindows(parseable);
  const errors = base.errors.map((e, i) => ({ ...e, badTime: badTimes[i] }));
  const ok = errors.every((e) => !e.badRange && !e.badHeadway && !e.badTime);
  return { normalized, errors, overlaps: base.overlaps, canApply: windows.length === 0 || (ok && base.overlaps.length === 0) };
}

/* ============================================================================
   Spreadsheet keyboard navigation (HANDOFF §5 — navFrom / Tab)
   ========================================================================== */

/** A grid coordinate (trip row index, stop column index). */
export interface CellCoord { t: number; s: number }

/** Predicates over the live grid: does an input exist at (t, s)? does trip row t
 *  have any input at all? Pulled out so the navigation MATH (skip-hopping, row
 *  wrapping) is pure and unit-testable, independent of the DOM. */
export interface GridProbe {
  hasInput: (t: number, s: number) => boolean;
  rowExists: (t: number) => boolean;
}

/** Single-axis move (↑/↓ within a stop column, ←/→ across stops). A cell with no
 *  input is a SKIP — hop over it. Returns the next focusable coord, or null off
 *  the grid. Pure. */
export function nextCell(probe: GridProbe, from: CellCoord, dTrip: number, dStop: number): CellCoord | null {
  let { t, s } = from;
  for (let guard = 0; guard < 4000; guard++) {
    t += dTrip;
    s += dStop;
    if (t < 0 || s < 0) return null;
    if (probe.hasInput(t, s)) return { t, s };
    if (dTrip && !probe.rowExists(t)) return null;
    if (dStop && s > 400) return null;
    if (dTrip && t > 4000) return null;
  }
  return null;
}

/** Tab / Shift-Tab in reading order: next/prev stop, wrapping to the next/prev
 *  trip row at the grid edge, skipping SKIP cells. Returns the next focusable
 *  coord, or null off the grid. Pure. */
export function nextTabCell(probe: GridProbe, from: CellCoord, step: number, totalStops: number): CellCoord | null {
  let { t, s } = from;
  for (let guard = 0; guard < 8000; guard++) {
    s += step;
    if (s >= totalStops) { s = 0; t++; }
    else if (s < 0) { s = totalStops - 1; t--; }
    if (t < 0) return null;
    if (!probe.rowExists(t)) return null; // past the last / first trip row
    if (probe.hasInput(t, s)) return { t, s };
  }
  return null;
}

// Focus lands on the input at (t, s[, part]) after React has committed the
// current edit's re-render. A commit can rename a `_new` trip (row key changes →
// remount), so the element is re-queried on the next frame rather than captured.
function focusCell(table: HTMLTableElement, t: number, s: number, part?: string) {
  const sel = `input[data-ti="${t}"][data-si="${s}"]` + (part ? `[data-part="${part}"]` : '');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const el = table.querySelector<HTMLInputElement>(sel);
      if (el) { el.focus(); el.select(); }
    });
  });
}

function domProbe(table: HTMLTableElement, part?: string): GridProbe {
  return {
    hasInput: (t, s) => !!table.querySelector(`input[data-ti="${t}"][data-si="${s}"]` + (part ? `[data-part="${part}"]` : '')),
    // Match the row element (tr[data-ti]), not just inputs, so a read-only
    // frequency build-out row (item #8) counts as an existing row: keyboard nav
    // then hops OVER it (no input to land on) instead of halting at it.
    rowExists: (t) => !!table.querySelector(`[data-ti="${t}"]`),
  };
}

/** DOM wrapper for {@link nextCell}: ↑↓ within a column, ←→ across stops. */
export function navFrom(el: HTMLInputElement, dTrip: number, dStop: number): boolean {
  const table = el.closest('table');
  if (!table) return false;
  const part = el.dataset.part || undefined;
  const to = nextCell(domProbe(table, part), { t: Number(el.dataset.ti), s: Number(el.dataset.si) }, dTrip, dStop);
  if (!to) return false;
  focusCell(table, to.t, to.s, part);
  return true;
}

/** DOM wrapper for {@link nextTabCell}: Tab / Shift-Tab in reading order. */
export function navTab(el: HTMLInputElement, step: number, totalStops: number): boolean {
  const table = el.closest('table');
  if (!table) return false;
  const to = nextTabCell(domProbe(table), { t: Number(el.dataset.ti), s: Number(el.dataset.si) }, step, totalStops);
  if (!to) return false;
  focusCell(table, to.t, to.s);
  return true;
}

/* ============================================================================
   Anchored menu positioning — flip up / clamp so a fixed dropdown stays on-screen
   ========================================================================== */

/** Position a fixed-position dropdown anchored to a trigger's rect. Opens below
 *  by default, but flips above when it would overflow the viewport bottom (the
 *  bottom panel is often short), and clamps horizontally. Measured in a layout
 *  effect so the flip lands before paint (no flash). */
export function useAnchoredMenuPosition(
  ref: RefObject<HTMLElement | null>,
  rect: DOMRect,
  gap = 6,
): { top: number; left: number } {
  const [style, setStyle] = useState<{ top: number; left: number }>({ top: rect.bottom + gap, left: rect.left });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = el.offsetHeight;
    const w = el.offsetWidth;
    let top = rect.bottom + gap;
    if (top + h > window.innerHeight - 8) top = Math.max(8, rect.top - gap - h);
    let left = rect.left;
    if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - w);
    setStyle({ top, left });
  }, [ref, rect, gap]);
  return style;
}

/* ============================================================================
   Cascade planning (HANDOFF §5) — pure decision for the "shift later trips" pill
   ========================================================================== */

export interface CascadePlan {
  /** Change to the edited time, in whole minutes (may be negative). */
  deltaMin: number;
  /** Trip ids after the edited one that have a time in the edited column. */
  laterIds: string[];
}

/** After a cell edit changed a previously-set time by Δ, decide whether to offer
 *  shifting the later trips that also have a time in that column. Returns null
 *  when there's nothing to offer (no prior time, Δ = 0, or no later trips with a
 *  time there). Pure — the orchestrator does the store writes. */
export function planCascade(params: {
  orderedTripIds: string[];
  editedTripId: string;
  prevSec: number | null;
  newSec: number;
  hasTimeAt: (tripId: string) => boolean;
}): CascadePlan | null {
  const { orderedTripIds, editedTripId, prevSec, newSec } = params;
  if (prevSec == null) return null;
  const deltaMin = Math.round((newSec - prevSec) / 60);
  if (deltaMin === 0) return null;
  const idx = orderedTripIds.indexOf(editedTripId);
  if (idx < 0) return null;
  const laterIds = orderedTripIds.slice(idx + 1).filter((id) => params.hasTimeAt(id));
  if (laterIds.length === 0) return null;
  return { deltaMin, laterIds };
}

/** Resolve the companion (right) pane's pattern after the main (left) pane's
 *  pattern changes in Both view: keep the user's EXPLICIT right choice unless it
 *  now collides with the new left pattern or is no longer a valid pattern — then
 *  fall back to derived-opposite (null). `prev === null` means already derived.
 *  Pure state-machine step for the pane direction control (item #7). */
export function nextCompanionShapeId(
  prev: string | null,
  leftShapeId: string | null,
  patternShapeIds: readonly string[],
): string | null {
  if (prev && prev !== leftShapeId && patternShapeIds.includes(prev)) return prev;
  return null;
}

/** Trip ids a freshly generated batch must avoid colliding with, for minting
 *  pithy names (item #9). "Add alongside" keeps every existing trip, so new
 *  names take the next-highest numbers. "Replace" first drops the scope's own
 *  trips, freeing their numbers for reuse while still dodging trips kept in
 *  other directions/services. Pure. */
export function generateExistingIds(
  allTripIds: readonly string[],
  scopeTripIds: readonly string[],
  replace: boolean,
): Set<string> {
  if (!replace) return new Set(allTripIds);
  const doomed = new Set(scopeTripIds);
  return new Set(allTripIds.filter((id) => !doomed.has(id)));
}

/* ============================================================================
   Dismiss-on-outside hook for menus / popovers (HANDOFF §5, §6)
   ========================================================================== */

/** Close on Escape, on a mousedown outside `ref` (unless the target matches
 *  `ignoreSelector`, e.g. the trigger button), and on any scroll — a
 *  fixed-position menu would otherwise go stale when the grid scrolls under it. */
export function useDismiss(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  ignoreSelector?: string,
) {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (ref.current && ref.current.contains(target)) return;
      if (ignoreSelector && target.closest(ignoreSelector)) return;
      onClose();
    };
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onScroll = () => onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [ref, onClose, ignoreSelector]);
}
