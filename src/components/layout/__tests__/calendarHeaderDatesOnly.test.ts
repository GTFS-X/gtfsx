// B6 -> B7 cross-batch: the calendar detail header resolves the service through
// serviceOptions, so a calendar_dates-only service gets its title, Duplicate
// and Delete, and Delete still refuses while the service is in use (S1-14).
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../db/dexie', () => {
  const table = () => ({
    clear: async () => undefined,
    put: async () => undefined,
    get: async () => undefined,
    delete: async () => undefined,
    toArray: async () => [],
    where: () => ({ notEqual: () => ({ delete: async () => undefined }) }),
  });
  return {
    db: {
      projects: table(),
      projectData: table(),
      projectBulk: table(),
      transaction: async (...args: unknown[]) => (args[args.length - 1] as () => Promise<unknown>)(),
    },
  };
});

const { useStore } = await import('../../../store');
const { calendarReferences } = await import('../../../store/calendarSlice');
const { calendarDeleteBlockedMessage, resolveCalendarHeaderService } = await import('../calendarDeleteMessage');
import type { Calendar, CalendarDate, Trip } from '../../../types/gtfs';

const s = () => useStore.getState();
const cal = (id: string, description?: string): Calendar =>
  ({
    service_id: id, monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1,
    saturday: 0, sunday: 0, start_date: '20260101', end_date: '20261231',
    ...(description ? { _description: description } : {}),
  }) as Calendar;
const added = (id: string, date: string): CalendarDate => ({ service_id: id, date, exception_type: 1 });
const trip = (id: string, serviceId: string): Trip =>
  ({ trip_id: id, route_id: 'R1', service_id: serviceId }) as Trip;

beforeEach(() => {
  useStore.setState({
    calendars: [cal('WK', 'Weekday')],
    calendarDates: [added('HOL', '20260704'), added('HOL', '20261225')],
    trips: [],
    flexZones: [],
    timeframes: [],
  });
});

describe('resolveCalendarHeaderService', () => {
  it('resolves a calendar.txt service with its description as the title', () => {
    expect(resolveCalendarHeaderService(s(), 'WK')).toEqual({ serviceId: 'WK', title: 'Weekday', datesOnly: false });
  });

  it('resolves a calendar_dates-only service (the old header returned nothing)', () => {
    expect(resolveCalendarHeaderService(s(), 'HOL')).toEqual({ serviceId: 'HOL', title: 'HOL', datesOnly: true });
  });

  it('returns null for an unset or unknown id', () => {
    expect(resolveCalendarHeaderService(s(), null)).toBeNull();
    expect(resolveCalendarHeaderService(s(), 'NOPE')).toBeNull();
  });
});

describe('dates-only Duplicate and Delete', () => {
  it('duplicates a dates-only service as its dates alone, under a fresh id', () => {
    const newId = s().duplicateCalendar('HOL');
    expect(newId).toBe('HOL_copy');
    expect(s().calendars.map((c) => c.service_id)).toEqual(['WK']);
    expect(s().calendarDates.filter((d) => d.service_id === 'HOL_copy').map((d) => d.date))
      .toEqual(['20260704', '20261225']);
    expect(resolveCalendarHeaderService(s(), newId)?.datesOnly).toBe(true);
  });

  it('picks a new id that does not collide with an existing dates-only id', () => {
    useStore.setState({ calendarDates: [...s().calendarDates, added('WK_copy', '20260101')] });
    expect(s().duplicateCalendar('WK')).toBe('WK_copy2');
  });

  it('refuses to delete a dates-only service that trips use, and says why', () => {
    useStore.setState({ trips: [trip('T1', 'HOL'), trip('T2', 'HOL')] });
    expect(s().removeCalendar('HOL')).toBe(false);
    expect(s().calendarDates).toHaveLength(2);
    expect(calendarDeleteBlockedMessage(calendarReferences(s(), 'HOL'))).toMatch(/used by 2 trips/);
  });

  it('deletes an unused dates-only service (all of its dates)', () => {
    expect(s().removeCalendar('HOL')).toBe(true);
    expect(s().calendarDates).toHaveLength(0);
    expect(resolveCalendarHeaderService(s(), 'HOL')).toBeNull();
  });
});
