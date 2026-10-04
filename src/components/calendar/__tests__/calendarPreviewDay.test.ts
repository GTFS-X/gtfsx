// Calendar preview cell classification (C2-17) and the calendar_dates-only
// stand-in calendar (C2-03).
import { describe, expect, it } from 'vitest';
import { previewDayKind, datesOnlyPreviewCalendar, PREVIEW_DAY_CLASS } from '../calendarPreviewDay';
import type { Calendar } from '../../../types/gtfs';

const weekdays: Calendar = {
  service_id: 'WK',
  monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0,
  start_date: '20260101', end_date: '20260630',
};

describe('previewDayKind', () => {
  it('shows an added (type 1) date outside start/end as added, not out of range', () => {
    expect(previewDayKind(weekdays, { exception_type: 1 }, '20260704')).toBe('added');
    expect(previewDayKind(weekdays, undefined, '20260704')).toBe('outside');
  });

  it('gives added and removed dates distinct classes from regular service', () => {
    expect(previewDayKind(weekdays, { exception_type: 1 }, '20260103')).toBe('added'); // a Saturday
    expect(previewDayKind(weekdays, { exception_type: 2 }, '20260105')).toBe('removed');
    const classes = new Set([PREVIEW_DAY_CLASS.added, PREVIEW_DAY_CLASS.removed, PREVIEW_DAY_CLASS.weekday, PREVIEW_DAY_CLASS.weekend]);
    expect(classes.size).toBe(4);
  });

  it('falls back to the weekly pattern', () => {
    expect(previewDayKind(weekdays, undefined, '20260105')).toBe('weekday'); // Monday
    expect(previewDayKind(weekdays, undefined, '20260103')).toBe('none'); // Saturday
  });
});

describe('datesOnlyPreviewCalendar', () => {
  it('spans the exception dates with no weekly service', () => {
    const cal = datesOnlyPreviewCalendar('HOL', [
      { service_id: 'HOL', date: '20261225', exception_type: 1 },
      { service_id: 'HOL', date: '20260704', exception_type: 1 },
    ]);
    expect(cal.start_date).toBe('20260704');
    expect(cal.end_date).toBe('20261225');
    expect(previewDayKind(cal, undefined, '20260801')).toBe('none');
    expect(previewDayKind(cal, { exception_type: 1 }, '20260704')).toBe('added');
  });
});
