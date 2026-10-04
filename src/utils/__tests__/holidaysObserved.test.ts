// S2-16: fixed-date holidays on a weekend are also offered on their observed
// weekday (Sat → Fri, Sun → Mon), including New Year's observed on Dec 31.
import { describe, expect, it } from 'vitest';
import { US_HOLIDAYS, getEligibleHolidayExceptions, getUSHolidaysForYear, getUSHolidaysInRange } from '../holidays';

describe('observed holidays', () => {
  it('2026 includes Fri 20260703 as Independence Day (observed)', () => {
    const h = getUSHolidaysForYear(2026).find((x) => x.gtfsDate === '20260703');
    expect(h?.name).toBe('Independence Day (observed)');
    expect(h?.observedOf).toBe('Independence Day');
  });

  it("New Year's 2028 (a Saturday) is observed Fri 2027-12-31, inside a 2027 range", () => {
    const inRange = getUSHolidaysInRange('20270101', '20271231');
    expect(inRange.some((x) => x.gtfsDate === '20271231' && x.observedOf === "New Year's Day")).toBe(true);
  });

  it('a Mon–Fri calendar offered by holiday name gets the observed weekdays', () => {
    const cal = {
      monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0,
      start_date: '20260101', end_date: '20281231',
    };
    const names = new Set(["New Year's Day", 'Independence Day', 'Christmas Day']);
    const dates = getEligibleHolidayExceptions(cal, names).map((x) => x.gtfsDate);
    for (const d of ['20260703', '20270705', '20271224', '20271231']) expect(dates).toContain(d);
    expect(US_HOLIDAYS.some((h) => h.name.includes('observed'))).toBe(false);
  });
});
