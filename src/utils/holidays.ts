// US federal-holiday date math, shared by the calendar editor's "bulk-add
// holiday exceptions" feature and the #17 validation nudge. All public helpers
// speak GTFS YYYYMMDD date strings. The holiday-date generators read components
// in LOCAL time (new Date(y, m, d) + getDate()/getDay()); the day-of-week
// helpers below (gtfsWeekday / serviceRunsOnDate) parse the YYYYMMDD string in
// UTC (Date.UTC + getUTCDay) so an arbitrary date never drifts across the
// timezone boundary. Both approaches agree on the weekday of a given civil date.

/**
 * Date for the Nth occurrence of a given weekday in a month.
 * @param year   Full year
 * @param month  0-based month
 * @param weekday 0=Sunday … 6=Saturday
 * @param n      Which occurrence (1=first, 2=second, …)
 */
export function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): Date {
  const first = new Date(year, month, 1);
  const dayOfWeek = first.getDay();
  const diff = (weekday - dayOfWeek + 7) % 7;
  const date = 1 + diff + (n - 1) * 7;
  return new Date(year, month, date);
}

/** Last Monday of the given (0-based) month. */
export function lastMondayOfMonth(year: number, month: number): Date {
  const lastDay = new Date(year, month + 1, 0);
  const dayOfWeek = lastDay.getDay();
  const diff = (dayOfWeek - 1 + 7) % 7;
  return new Date(year, month, lastDay.getDate() - diff);
}

/** JS Date → GTFS YYYYMMDD (local components). */
export function dateToGtfs(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

export interface USHoliday {
  name: string;
  getDate: (year: number) => Date;
}

/**
 * Major US federal holidays. Fixed-date and nth-weekday rules. Juneteenth
 * became a federal holiday in 2021. Columbus Day is also observed as
 * Indigenous Peoples' Day. This list drives both the calendar editor's
 * bulk-add UI and the #17 missing-exception validation nudge.
 */
export const US_HOLIDAYS: USHoliday[] = [
  { name: "New Year's Day", getDate: (y) => new Date(y, 0, 1) },
  { name: 'MLK Day', getDate: (y) => nthWeekdayOfMonth(y, 0, 1, 3) },        // 3rd Monday of January
  { name: "Presidents' Day", getDate: (y) => nthWeekdayOfMonth(y, 1, 1, 3) }, // 3rd Monday of February
  { name: 'Memorial Day', getDate: (y) => lastMondayOfMonth(y, 4) },          // last Monday of May
  { name: 'Juneteenth', getDate: (y) => new Date(y, 5, 19) },                 // June 19
  { name: 'Independence Day', getDate: (y) => new Date(y, 6, 4) },            // July 4
  { name: 'Labor Day', getDate: (y) => nthWeekdayOfMonth(y, 8, 1, 1) },       // 1st Monday of September
  { name: 'Columbus Day', getDate: (y) => nthWeekdayOfMonth(y, 9, 1, 2) },    // 2nd Monday of October
  { name: 'Veterans Day', getDate: (y) => new Date(y, 10, 11) },              // November 11
  { name: 'Thanksgiving', getDate: (y) => nthWeekdayOfMonth(y, 10, 4, 4) },   // 4th Thursday of November
  { name: 'Christmas Day', getDate: (y) => new Date(y, 11, 25) },             // December 25
];

export interface USHolidayDate {
  name: string;
  gtfsDate: string;   // YYYYMMDD
  dayOfWeek: number;  // 0=Sunday … 6=Saturday
}

/** Every US holiday in a single calendar year, as GTFS dates. */
export function getUSHolidaysForYear(year: number): USHolidayDate[] {
  return US_HOLIDAYS.map((h) => {
    const d = h.getDate(year);
    return { name: h.name, gtfsDate: dateToGtfs(d), dayOfWeek: d.getDay() };
  });
}

/**
 * Every US holiday whose date falls within [startDate, endDate] inclusive
 * (GTFS YYYYMMDD strings), spanning every year the range touches. Handles
 * multi-year ranges and leap years (date math is real-calendar based).
 */
export function getUSHolidaysInRange(startDate: string, endDate: string): USHolidayDate[] {
  const startYear = parseInt(startDate.slice(0, 4), 10);
  const endYear = parseInt(endDate.slice(0, 4), 10);
  if (!Number.isFinite(startYear) || !Number.isFinite(endYear) || endYear < startYear) return [];
  const out: USHolidayDate[] = [];
  for (let y = startYear; y <= endYear; y++) {
    for (const h of getUSHolidaysForYear(y)) {
      if (h.gtfsDate >= startDate && h.gtfsDate <= endDate) out.push(h);
    }
  }
  return out;
}

// ── Service-day helpers ────────────────────────────────────────────────────
// "Does this calendar's weekly pattern run on this date's weekday?" — shared by
// the calendar editor (so bulk-add only creates exceptions on running days) and
// the validator (so it can flag redundant / off-service-day exceptions). Kept
// pure and structural (just the seven day flags) so both can reuse it.

/** The seven calendar.txt day columns, indexed by JS weekday (0=Sunday … 6=Saturday). */
const DAY_FIELDS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

/** A calendar's seven weekly service flags (1 = runs that weekday). */
export interface ServiceWeekdays {
  monday: number;
  tuesday: number;
  wednesday: number;
  thursday: number;
  friday: number;
  saturday: number;
  sunday: number;
}

/**
 * Weekday (0=Sunday … 6=Saturday) of a GTFS YYYYMMDD date string. Parses the
 * components into a UTC date and reads getUTCDay() so the result never drifts
 * with the host timezone (the classic `new Date('2026-07-04').getDay()` bug).
 */
export function gtfsWeekday(gtfsDate: string): number {
  const y = Number(gtfsDate.slice(0, 4));
  const m = Number(gtfsDate.slice(4, 6));
  const d = Number(gtfsDate.slice(6, 8));
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * Whether a calendar's weekly pattern runs on the weekday of the given GTFS
 * date. Looks ONLY at the seven day flags (not the start/end range) — callers
 * that care about the active window check it separately.
 */
export function serviceRunsOnDate(cal: ServiceWeekdays, gtfsDate: string): boolean {
  if (!gtfsDate || gtfsDate.length !== 8) return false;
  return cal[DAY_FIELDS[gtfsWeekday(gtfsDate)]] === 1;
}

/**
 * US holidays a bulk "add holiday exceptions" action should create for a
 * calendar: in the calendar's date range, selected by name, AND falling on a
 * weekday the pattern actually runs. The day-of-week filter is what keeps us
 * from adding a spurious "no service" exception on a day the service is already
 * off (e.g. a Sat/Sun holiday on a Mon–Fri pattern — a phantom calendar_dates
 * row that trips validators). The returned list drives both the add loop and
 * the button's "(N)" count, so the two stay in lockstep.
 */
export function getEligibleHolidayExceptions(
  cal: ServiceWeekdays & { start_date: string; end_date: string },
  selectedNames: ReadonlySet<string>,
): USHolidayDate[] {
  return getUSHolidaysInRange(cal.start_date, cal.end_date).filter(
    (h) => selectedNames.has(h.name) && serviceRunsOnDate(cal, h.gtfsDate),
  );
}
