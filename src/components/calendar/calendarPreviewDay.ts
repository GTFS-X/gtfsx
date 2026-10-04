import type { Calendar, CalendarDate } from '../../types/gtfs';

export type PreviewDayKind = 'added' | 'removed' | 'weekday' | 'weekend' | 'none' | 'outside';

/** Tailwind classes per preview cell kind. */
export const PREVIEW_DAY_CLASS: Record<PreviewDayKind, string> = {
  // exception_type 1: service added on this date (also outside the range).
  added: 'bg-teal text-white border-2 border-teal',
  // exception_type 2: service removed on this date.
  removed: 'bg-gold-light text-brown border-2 border-gold',
  weekday: 'bg-coral-light text-coral',
  weekend: 'bg-teal-light text-teal',
  none: 'bg-sand/40 text-warm-gray',
  outside: 'bg-sand/50 text-warm-gray/50',
};

function gtfsDateToDate(d: string): Date {
  return new Date(parseInt(d.slice(0, 4)), parseInt(d.slice(4, 6)) - 1, parseInt(d.slice(6, 8)));
}

/**
 * What a preview cell shows for one date. Exceptions are looked up BEFORE the
 * start/end range check: an "added" date outside the range is still a service
 * day (spec-valid, and how calendar_dates-only services work), so it must not
 * render as out of range (C2-17).
 */
export function previewDayKind(
  calendar: Pick<Calendar, 'start_date' | 'end_date' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday'>,
  exception: Pick<CalendarDate, 'exception_type'> | undefined,
  gtfsDate: string,
): PreviewDayKind {
  if (exception) return exception.exception_type === 1 ? 'added' : 'removed';
  const date = gtfsDateToDate(gtfsDate);
  if (date < gtfsDateToDate(calendar.start_date) || date > gtfsDateToDate(calendar.end_date)) {
    return 'outside';
  }
  const flags = [
    calendar.monday, calendar.tuesday, calendar.wednesday, calendar.thursday,
    calendar.friday, calendar.saturday, calendar.sunday,
  ];
  const jsDay = date.getDay();
  const mondayBased = jsDay === 0 ? 6 : jsDay - 1;
  if (!flags[mondayBased]) return 'none';
  return mondayBased >= 5 ? 'weekend' : 'weekday';
}

/**
 * A weekday-less stand-in calendar for a calendar_dates-only service, so the
 * month preview can show its added / removed dates. The range spans its
 * exception dates; every non-exception day reads as "no service".
 */
export function datesOnlyPreviewCalendar(serviceId: string, dates: readonly CalendarDate[]): Calendar {
  const sorted = dates.map((d) => d.date).filter((d) => /^\d{8}$/.test(d)).sort();
  const first = sorted[0] ?? '20000101';
  const last = sorted[sorted.length - 1] ?? first;
  return {
    service_id: serviceId,
    monday: 0, tuesday: 0, wednesday: 0, thursday: 0, friday: 0, saturday: 0, sunday: 0,
    start_date: first,
    end_date: last,
  };
}
