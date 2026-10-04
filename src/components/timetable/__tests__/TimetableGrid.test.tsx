// @vitest-environment jsdom
// Rendered TimetableGrid tests for the timetable rows of the bug review:
//   C2-01  focusing / tabbing through cells is navigation, not an edit: the
//          stop_times stay byte-identical, Undo stays empty, Save stays clean;
//          retyping a dwell stop's arrival keeps the dwell.
//   C2-03  a calendar_dates-only service is listed in the service picker and
//          no "Default Calendar" is materialized for it.
//   C2-06  the frequency drawer applies normalized times ("6:00" -> 06:00:00).
//   C2-10  a bulk op run through TimetableGrid's withUndo is ONE history step.
// The helpers (cellCommitDecision, cellEditUpdate, needsDefaultCalendar) are
// pinned in timetableEditFixes; these pin the component call sites.
import '../../../test-utils/dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { resetStore, store } from '../../../test-utils/store';
import { historyDepths, undo } from '../../../store/history';
import type { Calendar, CalendarDate, Route, RouteStop, Stop, StopTime, Trip } from '../../../types/gtfs';
import { TimetableGrid } from '../TimetableGrid';
import { FrequencyDrawer } from '../TimetableDrawers';
import type { FrequencyWindow } from '../../../services/frequencyExpansion';

beforeAll(() => {
  // jsdom has no ResizeObserver; the split-view divider measures with one.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const route: Route = { route_id: 'R', route_short_name: '10', route_long_name: 'Ten', route_type: 3 } as Route;
const stop = (id: string, lat: number): Stop =>
  ({ stop_id: id, stop_name: `Stop ${id}`, stop_lat: lat, stop_lon: -111, location_type: 0 }) as Stop;
const rs = (stop_id: string, seq: number): RouteStop =>
  ({ route_id: 'R', stop_id, direction_id: 0, stop_sequence: seq }) as RouteStop;
const st = (stop_id: string, seq: number, arr: string, dep = arr): StopTime =>
  ({ trip_id: 't1', stop_id, stop_sequence: seq, arrival_time: arr, departure_time: dep }) as StopTime;
const wk: Calendar = {
  service_id: 'WK', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1,
  saturday: 0, sunday: 0, start_date: '20260101', end_date: '20261231',
} as Calendar;

function seed(opts: { calendars: Calendar[]; calendarDates?: CalendarDate[]; serviceId: string }) {
  resetStore({
    routes: [route],
    stops: [stop('A', 45), stop('B', 45.01), stop('C', 45.02)],
    routeStops: [rs('A', 1), rs('B', 2), rs('C', 3)],
    trips: [{ trip_id: 't1', route_id: 'R', service_id: opts.serviceId, direction_id: 0 } as Trip],
    // A: seconds (display drops them) · B: a 2-minute dwell (single mode shows
    // only the arrival) · C: unpadded hour (display pads it).
    stopTimes: [st('A', 1, '08:00:30'), st('B', 2, '08:10:00', '08:12:00'), st('C', 3, '8:20:00')],
    calendars: opts.calendars,
    calendarDates: opts.calendarDates ?? [],
    selectedRouteId: 'R',
  });
  store().markSaved();
}

const cell = (si: number) =>
  document.querySelector<HTMLInputElement>(`input[data-ti="0"][data-si="${si}"]:not([data-part="d"])`)!;

describe('TimetableGrid cell commits (C2-01)', () => {
  beforeEach(() => seed({ calendars: [wk], serviceId: 'WK' }));

  it('tabbing through every cell and clicking in and out rewrites nothing', async () => {
    const user = userEvent.setup();
    render(<TimetableGrid />);
    const before = store().stopTimes;
    expect(cell(0)).toHaveValue('08:00');

    await user.click(cell(0));
    await user.tab();
    await user.tab();
    await user.tab();
    await user.click(cell(1));
    await user.click(cell(2));
    await user.click(document.body);
    await act(async () => {});

    expect(store().stopTimes).toEqual(before);
    expect(historyDepths().undo).toBe(0);
    expect(store().isDirty).toBe(false);
  });

  it('retyping a dwell stop keeps the dwell (departure moves with the arrival)', async () => {
    const user = userEvent.setup();
    render(<TimetableGrid />);
    await user.click(cell(1));
    expect(cell(1)).toHaveValue('08:10');
    await user.clear(cell(1));
    await user.type(cell(1), '08:15');
    await user.click(document.body);

    const b = store().stopTimes.find((s) => s.stop_id === 'B')!;
    expect(b.arrival_time).toBe('08:15:00');
    expect(b.departure_time).toBe('08:17:00');
    expect(historyDepths().undo).toBe(1);
  });
});

describe('TimetableGrid dates-only service (C2-03)', () => {
  beforeEach(() =>
    seed({
      calendars: [],
      calendarDates: [{ service_id: 'EVENT', date: '20260704', exception_type: 1 } as CalendarDate],
      serviceId: 'EVENT',
    }));

  it('lists the dates-only service, shows its trip, and creates no Default Calendar', async () => {
    render(<TimetableGrid />);
    await act(async () => {});
    const picker = screen.getByRole('combobox', { name: 'Service pattern' });
    expect(within(picker).getAllByRole('option').map((o) => o.textContent)).toEqual(['EVENT (dates only)']);
    expect(cell(0)).toHaveValue('08:00');
    expect(store().calendars).toEqual([]);
    expect(store().isDirty).toBe(false);
  });
});

describe('TimetableGrid with calendar + dates-only services (C2-03)', () => {
  beforeEach(() => {
    seed({
      calendars: [wk],
      calendarDates: [{ service_id: 'EVENT', date: '20260704', exception_type: 1 } as CalendarDate],
      serviceId: 'WK',
    });
    const s = store();
    s.setTrips([...s.trips, { trip_id: 'ev1', route_id: 'R', service_id: 'EVENT', direction_id: 0 } as Trip]);
    s.setStopTimes([
      ...s.stopTimes,
      { trip_id: 'ev1', stop_id: 'A', stop_sequence: 1, arrival_time: '18:00:00', departure_time: '18:00:00' } as StopTime,
    ]);
    s.markSaved();
  });

  it('picking the dates-only service shows its trips, not the calendar service\'s', async () => {
    const user = userEvent.setup();
    render(<TimetableGrid />);
    const picker = screen.getByRole('combobox', { name: 'Service pattern' });
    expect(within(picker).getAllByRole('option').map((o) => o.textContent)).toEqual(['WK', 'EVENT (dates only)']);
    expect(screen.getByText('t1')).toBeInTheDocument();

    await user.selectOptions(picker, 'EVENT');
    expect(screen.getByRole('combobox', { name: 'Service pattern' })).toHaveValue('EVENT');
    expect(screen.getByText('ev1')).toBeInTheDocument();
    expect(screen.queryByText('t1')).not.toBeInTheDocument();
    expect(store().calendars.map((c) => c.service_id)).toEqual(['WK']);
  });
});

describe('TimetableGrid bulk ops undo in one step (C2-10)', () => {
  beforeEach(() => seed({ calendars: [wk], serviceId: 'WK' }));

  it('Repeat last trip adds N trips and one Ctrl+Z removes them all', async () => {
    const user = userEvent.setup();
    render(<TimetableGrid />);
    await user.click(screen.getByRole('button', { name: /Repeat last trip/ }));
    await user.click(screen.getByRole('button', { name: 'Add 4 trips' }));

    expect(store().trips).toHaveLength(5);
    expect(historyDepths().undo).toBe(1);
    act(() => { undo(); });
    expect(store().trips.map((t) => t.trip_id)).toEqual(['t1']);
  });
});

describe('FrequencyDrawer Apply (C2-06)', () => {
  it('hands the grid normalized HH:MM:SS windows, not the typed text', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn<(w: FrequencyWindow[]) => void>();
    render(<FrequencyDrawer ctx="10" tripId="t1" initialWindows={[]} onApply={onApply} onCancel={() => {}} />);
    const start = screen.getByLabelText('Window 1 start');
    const end = screen.getByLabelText('Window 1 end');
    await user.clear(start);
    await user.type(start, ' 6:00');
    await user.clear(end);
    await user.type(end, '9:15');
    await user.click(screen.getByRole('button', { name: 'Apply windows' }));

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toEqual([
      expect.objectContaining({ start_time: '06:00:00', end_time: '09:15:00' }),
    ]);
  });

  it('Apply is disabled while a time is garbage', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<FrequencyDrawer ctx="10" tripId="t1" initialWindows={[]} onApply={onApply} onCancel={() => {}} />);
    const start = screen.getByLabelText('Window 1 start');
    await user.clear(start);
    await user.type(start, 'abc');
    expect(screen.getByRole('button', { name: 'Apply windows' })).toBeDisabled();
  });
});
