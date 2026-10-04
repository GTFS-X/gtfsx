import type { StateCreator } from 'zustand';
import type { Calendar, CalendarDate, Trip, Timeframe } from '../types/gtfs';
import type { FlexZone } from './flexSlice';

/** How many rows elsewhere in the feed name a service_id. */
export interface CalendarReferences {
  trips: number;
  /** Flex zones using it as their primary service or an additional window. */
  flexZones: number;
  /** timeframes.txt rows (Fares v2). */
  timeframes: number;
  /** Flex zones whose booking rule counts prior-notice days on it. */
  bookingRules: number;
}

/** Rows in `state` that reference `serviceId`. Exported so the delete UI can
 *  say "Used by N trips…" before (or after) a refused removeCalendar. */
export function calendarReferences(
  state: { trips?: Trip[]; flexZones?: FlexZone[]; timeframes?: Timeframe[] },
  serviceId: string,
): CalendarReferences {
  const zones = state.flexZones ?? [];
  return {
    trips: (state.trips ?? []).filter((t) => t.service_id === serviceId).length,
    flexZones: zones.filter(
      (z) => z.serviceId === serviceId || (z.additionalWindows ?? []).some((w) => w.serviceId === serviceId),
    ).length,
    timeframes: (state.timeframes ?? []).filter((tf) => tf.service_id === serviceId).length,
    bookingRules: zones.filter((z) => z.bookingRule?.priorNoticeServiceId === serviceId).length,
  };
}

/** Total of a CalendarReferences. */
export function calendarReferenceCount(refs: CalendarReferences): number {
  return refs.trips + refs.flexZones + refs.timeframes + refs.bookingRules;
}

export interface CalendarSlice {
  calendars: Calendar[];
  calendarDates: CalendarDate[];
  addCalendar: (calendar: Calendar) => void;
  updateCalendar: (service_id: string, updates: Partial<Calendar>) => void;
  /** Delete a service (its calendar.txt row and its calendar_dates.txt
   *  exceptions). REFUSED (returns false, nothing changes) while trips, flex
   *  zones, timeframes or booking rules still use the service — deleting it
   *  would orphan them, and the orphan-trip validator fix then offers to delete
   *  the trips. Use calendarReferences() to tell the user what is in the way. */
  removeCalendar: (service_id: string) => boolean;
  /** Clone a calendar (and its exception dates) under a new unique service_id.
   * A calendar_dates-only service is cloned as its dates alone.
   * Returns the new service_id, or null if the source doesn't exist. */
  duplicateCalendar: (service_id: string) => string | null;
  setCalendars: (calendars: Calendar[]) => void;
  /** Add an exception date. (service_id, date) is calendar_dates.txt's
   *  primary key, so an existing row for that pair is REPLACED (e.g. adding
   *  "removed" over "added" flips it) rather than duplicated. */
  addCalendarDate: (cd: CalendarDate) => void;
  removeCalendarDate: (service_id: string, date: string) => void;
  /** Remove every calendar_dates exception for a single service_id. */
  clearCalendarDates: (service_id: string) => void;
  setCalendarDates: (dates: CalendarDate[]) => void;
}

export const createCalendarSlice: StateCreator<CalendarSlice, [['zustand/immer', never]], [], CalendarSlice> = (set, get) => ({
  calendars: [],
  calendarDates: [],
  addCalendar: (calendar) => set((state) => { state.calendars.push(calendar); }),
  updateCalendar: (service_id, updates) => set((state) => {
    const idx = state.calendars.findIndex((c) => c.service_id === service_id);
    if (idx !== -1) Object.assign(state.calendars[idx], updates);
  }),
  removeCalendar: (service_id) => {
    const refs = calendarReferences(get() as never, service_id);
    if (calendarReferenceCount(refs) > 0) return false;
    set((state) => {
      state.calendars = state.calendars.filter((c) => c.service_id !== service_id);
      state.calendarDates = state.calendarDates.filter((cd) => cd.service_id !== service_id);
    });
    return true;
  },
  duplicateCalendar: (service_id) => {
    const s0 = get();
    const orig = s0.calendars.find((c) => c.service_id === service_id);
    // A calendar_dates-only service has no calendar.txt row: copy its dates.
    const datesOnly = !orig && s0.calendarDates.some((cd) => cd.service_id === service_id);
    if (!orig && !datesOnly) return null;
    const existing = new Set([
      ...s0.calendars.map((c) => c.service_id),
      ...s0.calendarDates.map((cd) => cd.service_id),
    ]);
    let newId = `${service_id}_copy`;
    let n = 2;
    while (existing.has(newId)) newId = `${service_id}_copy${n++}`;
    const dateCopies = s0.calendarDates
      .filter((cd) => cd.service_id === service_id)
      .map((cd) => ({ ...cd, service_id: newId }));
    set((state) => {
      if (orig) {
        state.calendars.push({
          ...orig,
          service_id: newId,
          _description: orig._description ? `${orig._description} (copy)` : orig._description,
        });
      }
      state.calendarDates.push(...dateCopies);
    });
    return newId;
  },
  setCalendars: (calendars) => set((state) => { state.calendars = calendars; }),
  addCalendarDate: (cd) => set((state) => {
    const idx = state.calendarDates.findIndex(
      (x) => x.service_id === cd.service_id && x.date === cd.date,
    );
    if (idx === -1) state.calendarDates.push(cd);
    else state.calendarDates[idx] = cd;
  }),
  removeCalendarDate: (service_id, date) => set((state) => {
    state.calendarDates = state.calendarDates.filter(
      (cd) => !(cd.service_id === service_id && cd.date === date)
    );
  }),
  clearCalendarDates: (service_id) => set((state) => {
    state.calendarDates = state.calendarDates.filter(
      (cd) => cd.service_id !== service_id
    );
  }),
  setCalendarDates: (dates) => set((state) => { state.calendarDates = dates; }),
});
