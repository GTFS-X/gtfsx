// Day-of-week helpers behind the calendar editor's "Add US holidays" bulk
// action and the validator's redundant-exception rule. gtfsWeekday must be
// timezone-proof (the classic `new Date('YYYY-MM-DD').getDay()` drift bug), and
// getEligibleHolidayExceptions must drop any holiday that lands on a weekday the
// pattern doesn't run — so a Mon–Fri service never gets a phantom "no service"
// exception on a weekend holiday, and the button "(N)" count reflects that.
import { describe, expect, it } from 'vitest';
import {
  US_HOLIDAYS,
  gtfsWeekday,
  serviceRunsOnDate,
  getEligibleHolidayExceptions,
  type ServiceWeekdays,
} from '../holidays';

const monFri: ServiceWeekdays = {
  monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0,
};
const satSun: ServiceWeekdays = {
  monday: 0, tuesday: 0, wednesday: 0, thursday: 0, friday: 0, saturday: 1, sunday: 1,
};

describe('gtfsWeekday', () => {
  it('returns 0=Sun … 6=Sat for known civil dates (UTC, no tz drift)', () => {
    expect(gtfsWeekday('20240101')).toBe(1); // Mon
    expect(gtfsWeekday('20240103')).toBe(3); // Wed
    expect(gtfsWeekday('20240106')).toBe(6); // Sat
    expect(gtfsWeekday('20260704')).toBe(6); // Independence Day 2026 = Sat
    expect(gtfsWeekday('20270704')).toBe(0); // Independence Day 2027 = Sun
    expect(gtfsWeekday('20261225')).toBe(5); // Christmas 2026 = Fri
  });
});

describe('serviceRunsOnDate', () => {
  it('matches the calendar day flag for the date weekday', () => {
    expect(serviceRunsOnDate(monFri, '20240103')).toBe(true);  // Wed
    expect(serviceRunsOnDate(monFri, '20240101')).toBe(true);  // Mon
    expect(serviceRunsOnDate(monFri, '20240106')).toBe(false); // Sat
    expect(serviceRunsOnDate(satSun, '20240106')).toBe(true);  // Sat
    expect(serviceRunsOnDate(satSun, '20240103')).toBe(false); // Wed
  });
  it('is false for malformed dates rather than throwing', () => {
    expect(serviceRunsOnDate(monFri, '')).toBe(false);
    expect(serviceRunsOnDate(monFri, '2024-01-03')).toBe(false); // not YYYYMMDD
  });
});

describe('getEligibleHolidayExceptions', () => {
  const calMonFri = { ...monFri, start_date: '20260101', end_date: '20261231' };
  const allNames = new Set(US_HOLIDAYS.map((h) => h.name));

  it('only returns selected holidays that land on a running weekday in range', () => {
    const elig = getEligibleHolidayExceptions(calMonFri, allNames);
    expect(elig.length).toBeGreaterThan(0);
    // Every eligible holiday is on a weekday this Mon–Fri pattern runs.
    expect(elig.every((h) => serviceRunsOnDate(calMonFri, h.gtfsDate))).toBe(true);
    // Independence Day 2026 is a Saturday → excluded (the phantom-exception bug).
    expect(elig.some((h) => h.name === 'Independence Day')).toBe(false);
    // Christmas 2026 is a Friday → included.
    expect(elig.some((h) => h.name === 'Christmas Day')).toBe(true);
  });

  it('honors the selected-name filter', () => {
    const onlyXmas = getEligibleHolidayExceptions(calMonFri, new Set(['Christmas Day']));
    expect(onlyXmas.map((h) => h.name)).toEqual(['Christmas Day']);
  });

  it('returns an empty list when every selected holiday is off-DOW (count = 0)', () => {
    // Independence Day 2026 falls on a Saturday — a Mon–Fri pattern runs none of
    // it, so the bulk-add button would show "(0)" / be disabled.
    const offDow = getEligibleHolidayExceptions(calMonFri, new Set(['Independence Day']));
    expect(offDow.length).toBe(0);
  });

  it('weekend pattern picks up the weekend holiday the weekday pattern skipped', () => {
    const calSatSun = { ...satSun, start_date: '20260101', end_date: '20261231' };
    const elig = getEligibleHolidayExceptions(calSatSun, new Set(['Independence Day']));
    expect(elig.map((h) => h.gtfsDate)).toEqual(['20260704']); // Sat → runs
  });
});
