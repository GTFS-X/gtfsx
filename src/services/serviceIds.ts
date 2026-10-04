/**
 * One place that answers "which service_ids exist, and on which dates does each
 * run?" for the whole app.
 *
 * GTFS lets a service be defined by calendar.txt, by calendar_dates.txt, or by
 * both. A feed that uses calendar_dates.txt only (one exception_type=1 row per
 * service day) is fully spec-valid and common, so anything that builds a set of
 * service ids from `calendars` alone misreads it: the validator calls its trips
 * orphans, pickers can't select its services, and cost / Title VI figures count
 * the wrong days. Every such site should go through these helpers.
 *
 * Pure module: no store import, safe under plain Node (tsx editor tests).
 */
import type { Calendar, CalendarDate } from '../types/gtfs';

export interface ServiceSource {
  calendars: readonly Calendar[];
  calendarDates: readonly CalendarDate[];
}

/** Every service_id defined by calendar.txt or calendar_dates.txt. */
export function allServiceIds(state: ServiceSource): Set<string> {
  const ids = new Set<string>();
  for (const c of state.calendars) ids.add(c.service_id);
  for (const d of state.calendarDates) ids.add(d.service_id);
  return ids;
}

export interface ServiceOption {
  serviceId: string;
  /** Human label: the calendar's description, else its id; dates-only ids are marked. */
  label: string;
  /** True when the service has no calendar.txt row (calendar_dates only). */
  datesOnly: boolean;
  /** The calendar.txt row, when there is one. */
  calendar?: Calendar;
}

/**
 * Picker options: calendar rows first (in store order), then calendar_dates-only
 * ids (in first-seen order).
 */
export function serviceOptions(state: ServiceSource): ServiceOption[] {
  const out: ServiceOption[] = [];
  const seen = new Set<string>();
  for (const c of state.calendars) {
    if (seen.has(c.service_id)) continue;
    seen.add(c.service_id);
    out.push({
      serviceId: c.service_id,
      label: c._description || c.service_id,
      datesOnly: false,
      calendar: c,
    });
  }
  for (const d of state.calendarDates) {
    if (seen.has(d.service_id)) continue;
    seen.add(d.service_id);
    out.push({ serviceId: d.service_id, label: `${d.service_id} (dates only)`, datesOnly: true });
  }
  return out;
}

/* ───────────────────────────── date math ───────────────────────────── */

const MS_PER_DAY = 86_400_000;
const DAY_FIELDS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

/** GTFS YYYYMMDD → days since the Unix epoch (UTC), or NaN when malformed. */
export function gtfsDateToDayNumber(d: string): number {
  if (!/^\d{8}$/.test(d)) return Number.NaN;
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(4, 6));
  const day = Number(d.slice(6, 8));
  if (m < 1 || m > 12 || day < 1 || day > 31) return Number.NaN;
  return Math.floor(Date.UTC(y, m - 1, day) / MS_PER_DAY);
}

/** Days since the Unix epoch → GTFS YYYYMMDD (UTC). */
export function dayNumberToGtfsDate(n: number): string {
  const dt = new Date(n * MS_PER_DAY);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const day = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/** Today's civil date (local) as GTFS YYYYMMDD. */
export function todayGtfsDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/**
 * Hard cap on how many days a single calendar row is expanded over. A row
 * spanning more than this (e.g. 2000-01-01..2099-12-31) is expanded over its
 * first MAX_EXPANSION_DAYS only; callers that annualize use the same capped
 * span, so the per-year rate stays right.
 */
export const MAX_EXPANSION_DAYS = 3660;

export interface DateWindow {
  /** Inclusive YYYYMMDD. */
  start: string;
  /** Inclusive YYYYMMDD. */
  end: string;
}

/**
 * The dates (YYYYMMDD, ascending) on which `serviceId` runs: the calendar row's
 * weekdays within [start_date, end_date], plus every exception_type=1 date
 * (in range or not, as the spec allows), minus every exception_type=2 date.
 * With `window`, only dates inside it are returned.
 */
export function activeServiceDates(
  serviceId: string,
  calendars: readonly Calendar[],
  calendarDates: readonly CalendarDate[],
  window?: DateWindow,
): string[] {
  const lo = window ? gtfsDateToDayNumber(window.start) : Number.NEGATIVE_INFINITY;
  const hi = window ? gtfsDateToDayNumber(window.end) : Number.POSITIVE_INFINITY;
  const days = new Set<number>();

  const cal = calendars.find((c) => c.service_id === serviceId);
  if (cal) {
    const s = gtfsDateToDayNumber(cal.start_date);
    const e = gtfsDateToDayNumber(cal.end_date);
    if (Number.isFinite(s) && Number.isFinite(e) && e >= s) {
      const from = Math.max(s, lo);
      const to = Math.min(e, hi, s + MAX_EXPANSION_DAYS - 1);
      for (let n = from; n <= to; n++) {
        // Day 0 (1970-01-01) was a Thursday → (n + 4) % 7 is the JS weekday.
        const wd = (((n + 4) % 7) + 7) % 7;
        if (cal[DAY_FIELDS[wd]] === 1) days.add(n);
      }
    }
  }
  for (const cd of calendarDates) {
    if (cd.service_id !== serviceId) continue;
    const n = gtfsDateToDayNumber(cd.date);
    if (!Number.isFinite(n) || n < lo || n > hi) continue;
    if (Number(cd.exception_type) === 1) days.add(n);
  }
  for (const cd of calendarDates) {
    if (cd.service_id !== serviceId || Number(cd.exception_type) !== 2) continue;
    days.delete(gtfsDateToDayNumber(cd.date));
  }
  return [...days].sort((a, b) => a - b).map(dayNumberToGtfsDate);
}

/**
 * Map every service to its active dates (as day numbers), in one pass over
 * calendar_dates. Use this instead of calling activeServiceDates per service on
 * large feeds.
 */
export function activeDayNumbersByService(
  state: ServiceSource,
  window?: DateWindow,
): Map<string, Set<number>> {
  const lo = window ? gtfsDateToDayNumber(window.start) : Number.NEGATIVE_INFINITY;
  const hi = window ? gtfsDateToDayNumber(window.end) : Number.POSITIVE_INFINITY;
  const out = new Map<string, Set<number>>();
  const get = (id: string) => {
    let s = out.get(id);
    if (!s) { s = new Set(); out.set(id, s); }
    return s;
  };
  for (const cal of state.calendars) {
    const set = get(cal.service_id);
    const s = gtfsDateToDayNumber(cal.start_date);
    const e = gtfsDateToDayNumber(cal.end_date);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) continue;
    const from = Math.max(s, lo);
    const to = Math.min(e, hi, s + MAX_EXPANSION_DAYS - 1);
    for (let n = from; n <= to; n++) {
      const wd = (((n + 4) % 7) + 7) % 7;
      if (cal[DAY_FIELDS[wd]] === 1) set.add(n);
    }
  }
  for (const cd of state.calendarDates) {
    const set = get(cd.service_id);
    if (Number(cd.exception_type) !== 1) continue;
    const n = gtfsDateToDayNumber(cd.date);
    if (Number.isFinite(n) && n >= lo && n <= hi) set.add(n);
  }
  for (const cd of state.calendarDates) {
    if (Number(cd.exception_type) !== 2) continue;
    out.get(cd.service_id)?.delete(gtfsDateToDayNumber(cd.date));
  }
  return out;
}

/** The service_ids running on one date. */
export function servicesActiveOn(date: string, state: ServiceSource): Set<string> {
  const out = new Set<string>();
  for (const [id, days] of activeDayNumbersByService(state, { start: date, end: date })) {
    if (days.size > 0) out.add(id);
  }
  return out;
}

/* ─────────────────────── representative service date ─────────────────────── */

export interface RepresentativeServiceDate {
  /** YYYYMMDD of the chosen date, or null when no service is active on any date. */
  date: string | null;
  /** JS weekday of `date` (0=Sunday … 6=Saturday), or null. */
  weekday: number | null;
  /** e.g. "Mon, Oct 5, 2026", or "All services" when date is null. */
  label: string;
  /** service_ids running on `date` (empty when date is null). */
  serviceIds: Set<string>;
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Mon, Oct 5, 2026" for a YYYYMMDD date. */
export function formatServiceDate(date: string): string {
  const n = gtfsDateToDayNumber(date);
  if (!Number.isFinite(n)) return date;
  const dt = new Date(n * MS_PER_DAY);
  return `${WEEKDAY_SHORT[dt.getUTCDay()]}, ${MONTH_SHORT[dt.getUTCMonth()]} ${dt.getUTCDate()}, ${dt.getUTCFullYear()}`;
}

/**
 * The busiest service DATE (by scheduled trip count) within the next
 * `horizonDays` days from `today`. When nothing runs in that window (an expired
 * or not-yet-started feed), the first `horizonDays` days of the feed's own
 * service are used instead. Ties go to the earliest date. Disjoint seasonal
 * calendars are never unioned (each date has its own active set), and
 * calendar_dates-only services count like any other.
 */
export function representativeServiceDate(
  feed: ServiceSource & { trips: readonly { service_id: string }[] },
  opts: { today?: string; horizonDays?: number } = {},
): RepresentativeServiceDate {
  const horizon = Math.max(1, opts.horizonDays ?? 90);
  const tripsPerService = new Map<string, number>();
  for (const t of feed.trips) tripsPerService.set(t.service_id, (tripsPerService.get(t.service_id) ?? 0) + 1);

  const pick = (window: DateWindow): RepresentativeServiceDate | null => {
    const byService = activeDayNumbersByService(feed, window);
    const tripsPerDay = new Map<number, number>();
    for (const [id, days] of byService) {
      const n = tripsPerService.get(id) ?? 0;
      if (n === 0) continue;
      for (const d of days) tripsPerDay.set(d, (tripsPerDay.get(d) ?? 0) + n);
    }
    let best: number | null = null;
    let bestCount = 0;
    for (const [d, c] of tripsPerDay) {
      if (c > bestCount || (c === bestCount && best !== null && d < best)) { best = d; bestCount = c; }
    }
    if (best === null) return null;
    const ids = new Set<string>();
    for (const [id, days] of byService) if (days.has(best)) ids.add(id);
    const date = dayNumberToGtfsDate(best);
    return {
      date,
      weekday: new Date(best * MS_PER_DAY).getUTCDay(),
      label: formatServiceDate(date),
      serviceIds: ids,
    };
  };

  const today = gtfsDateToDayNumber(opts.today ?? todayGtfsDate());
  if (Number.isFinite(today)) {
    const hit = pick({ start: dayNumberToGtfsDate(today), end: dayNumberToGtfsDate(today + horizon - 1) });
    if (hit) return hit;
  }
  // Fall back to the feed's own first service days.
  let first = Number.POSITIVE_INFINITY;
  for (const [id, days] of activeDayNumbersByService(feed)) {
    if ((tripsPerService.get(id) ?? 0) === 0) continue;
    for (const d of days) if (d < first) first = d;
  }
  if (Number.isFinite(first)) {
    const hit = pick({ start: dayNumberToGtfsDate(first), end: dayNumberToGtfsDate(first + horizon - 1) });
    if (hit) return hit;
  }
  return { date: null, weekday: null, label: 'All services', serviceIds: new Set() };
}
