// @vitest-environment jsdom
// Rendered "Shift trips…" flow: tick trips (row checkbox, shift-click range,
// header select-all), open the drawer, apply, and undo in ONE step via both the
// toast's Undo and Ctrl+Z history. The pure plan is pinned in shiftTrips.test.ts.
import '../../../test-utils/dom';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { resetStore, store } from '../../../test-utils/store';
import { historyDepths, undo } from '../../../store/history';
import type { Calendar, Route, RouteStop, Stop, StopTime, Trip } from '../../../types/gtfs';
import { TimetableGrid } from '../TimetableGrid';

beforeAll(() => {
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
const st = (trip_id: string, stop_id: string, seq: number, t: string): StopTime =>
  ({ trip_id, stop_id, stop_sequence: seq, arrival_time: t, departure_time: t }) as StopTime;
const wk: Calendar = {
  service_id: 'WK', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1,
  saturday: 0, sunday: 0, start_date: '20260101', end_date: '20261231',
} as Calendar;
const trip = (id: string, block_id?: string): Trip =>
  ({ trip_id: id, route_id: 'R', service_id: 'WK', direction_id: 0, block_id }) as Trip;

function seed() {
  resetStore({
    routes: [route],
    stops: [stop('A', 45), stop('B', 45.01)],
    routeStops: [rs('A', 1), rs('B', 2)],
    // t1/t2 share block X with a 10-minute layover; t3/t4 are unblocked.
    trips: [trip('t1', 'X'), trip('t2', 'X'), trip('t3'), trip('t4')],
    stopTimes: [
      st('t1', 'A', 1, '06:00:00'), st('t1', 'B', 2, '06:20:00'),
      st('t2', 'A', 1, '06:30:00'), st('t2', 'B', 2, '06:50:00'),
      st('t3', 'A', 1, '07:00:00'), st('t3', 'B', 2, '07:20:00'),
      st('t4', 'A', 1, '07:30:00'), st('t4', 'B', 2, '07:50:00'),
    ],
    calendars: [wk],
    selectedRouteId: 'R',
  });
}
const starts = () => ['t1', 't2', 't3', 't4'].map((id) =>
  store().stopTimes.find((s) => s.trip_id === id && s.stop_sequence === 1)?.arrival_time);

describe('TimetableGrid Shift trips…', () => {
  beforeEach(seed);

  it('is disabled until a trip is ticked', () => {
    render(<TimetableGrid />);
    expect(screen.getByRole('button', { name: /Shift trips/ })).toBeDisabled();
  });

  it('shift-click range selects, shifts +10 as one step, and the toast Undo restores it', async () => {
    const user = userEvent.setup();
    render(<TimetableGrid />);
    await user.click(screen.getByRole('checkbox', { name: /Select t2/ }));
    await user.keyboard('{Shift>}');
    await user.click(screen.getByRole('checkbox', { name: /Select t4/ }));
    await user.keyboard('{/Shift}');
    await user.click(screen.getByRole('button', { name: 'Shift 3 trips…' }));
    await user.click(screen.getByRole('button', { name: 'Shift 3 trips +10 min' }));

    expect(starts()).toEqual(['06:00:00', '06:40:00', '07:10:00', '07:40:00']);
    expect(historyDepths().undo).toBe(1);
    expect(screen.getByRole('status')).toHaveTextContent('Shifted 3 trips by +10 min');
    // Blocks are never reassigned.
    expect(store().trips.map((t) => t.block_id)).toEqual(['X', 'X', undefined, undefined]);

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(starts()).toEqual(['06:00:00', '06:30:00', '07:00:00', '07:30:00']);
  });

  it('header box selects the whole pane; Ctrl+Z history undoes the shift in one step', async () => {
    const user = userEvent.setup();
    render(<TimetableGrid />);
    await user.click(screen.getByRole('checkbox', { name: /Select all trips in this pane/ }));
    await user.click(screen.getByRole('button', { name: 'Shift 4 trips…' }));
    const input = screen.getByLabelText('Shift by');
    await user.clear(input);
    await user.type(input, '-5');
    await user.click(screen.getByRole('button', { name: 'Shift 4 trips −5 min' }));
    expect(starts()).toEqual(['05:55:00', '06:25:00', '06:55:00', '07:25:00']);
    expect(historyDepths().undo).toBe(1);
    act(() => { undo(); });
    expect(starts()).toEqual(['06:00:00', '06:30:00', '07:00:00', '07:30:00']);
  });

  it('warns about a block conflict it would create, and rejects going before midnight', async () => {
    const user = userEvent.setup();
    render(<TimetableGrid />);
    await user.click(screen.getByRole('checkbox', { name: /Select t1/ }));
    await user.click(screen.getByRole('button', { name: 'Shift 1 trip…' }));
    const input = screen.getByLabelText('Shift by');
    await user.clear(input);
    await user.type(input, '15'); // t1 would end 06:35, after t2 starts 06:30 on block X
    expect(screen.getByText(/Creates 1 block conflict/)).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, '-400');
    expect(screen.getByText(/before 00:00/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Shift trips' })).toBeDisabled();
  });
});
