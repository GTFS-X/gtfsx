import type { StateCreator } from 'zustand';
import type { Calendar, CalendarDate } from '../types/gtfs';

export interface CalendarSlice {
  calendars: Calendar[];
  calendarDates: CalendarDate[];
  addCalendar: (calendar: Calendar) => void;
  updateCalendar: (service_id: string, updates: Partial<Calendar>) => void;
  removeCalendar: (service_id: string) => void;
  setCalendars: (calendars: Calendar[]) => void;
  addCalendarDate: (cd: CalendarDate) => void;
  removeCalendarDate: (service_id: string, date: string) => void;
  setCalendarDates: (dates: CalendarDate[]) => void;
}

export const createCalendarSlice: StateCreator<CalendarSlice, [['zustand/immer', never]], [], CalendarSlice> = (set) => ({
  calendars: [],
  calendarDates: [],
  addCalendar: (calendar) => set((state) => { state.calendars.push(calendar); }),
  updateCalendar: (service_id, updates) => set((state) => {
    const idx = state.calendars.findIndex((c) => c.service_id === service_id);
    if (idx !== -1) Object.assign(state.calendars[idx], updates);
  }),
  removeCalendar: (service_id) => set((state) => {
    state.calendars = state.calendars.filter((c) => c.service_id !== service_id);
    state.calendarDates = state.calendarDates.filter((cd) => cd.service_id !== service_id);
  }),
  setCalendars: (calendars) => set((state) => { state.calendars = calendars; }),
  addCalendarDate: (cd) => set((state) => { state.calendarDates.push(cd); }),
  removeCalendarDate: (service_id, date) => set((state) => {
    state.calendarDates = state.calendarDates.filter(
      (cd) => !(cd.service_id === service_id && cd.date === date)
    );
  }),
  setCalendarDates: (dates) => set((state) => { state.calendarDates = dates; }),
});
