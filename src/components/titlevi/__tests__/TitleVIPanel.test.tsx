// @vitest-environment jsdom
// S2-09 / C5-02: TitleVIPanel must hand trips + calendars + calendarDates to
// calculateTitleVI so the analysis counts one representative service day
// instead of summing every service pattern into "daily" trips. The service is
// pinned in services tests; this pins the panel's call site.
import '../../../test-utils/dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { resetStore } from '../../../test-utils/store';
import type { Calendar, CalendarDate, Stop, StopTime, Trip } from '../../../types/gtfs';

vi.mock('../../coverage/serviceAreaCensus', () => ({
  fetchServiceAreaBlockGroups: vi.fn(async () => []),
}));

const calcSpy = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('../../../services/titleVI', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../services/titleVI')>();
  return {
    ...mod,
    calculateTitleVI: (...args: Parameters<typeof mod.calculateTitleVI>) => {
      calcSpy.calls.push(args);
      return mod.calculateTitleVI(...args);
    },
  };
});

import { TitleVIPanel } from '../TitleVIPanel';

const stop: Stop = { stop_id: 'A', stop_name: 'A', stop_lat: 45, stop_lon: -111, location_type: 0 } as Stop;
const wk: Calendar = {
  service_id: 'WK', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1,
  saturday: 0, sunday: 0, start_date: '20260101', end_date: '20261231',
} as Calendar;
const sa: Calendar = { ...wk, service_id: 'SA', monday: 0, tuesday: 0, wednesday: 0, thursday: 0, friday: 0, saturday: 1 };
const holiday: CalendarDate = { service_id: 'HOL', date: '20260704', exception_type: 1 } as CalendarDate;
const trip = (id: string, service_id: string): Trip =>
  ({ trip_id: id, route_id: 'R', service_id, direction_id: 0 }) as Trip;
const st = (trip_id: string): StopTime =>
  ({ trip_id, stop_id: 'A', stop_sequence: 1, arrival_time: '08:00:00', departure_time: '08:00:00' }) as StopTime;

describe('TitleVIPanel (S2-09 / C5-02)', () => {
  beforeEach(() => {
    calcSpy.calls.length = 0;
    const trips = [trip('w1', 'WK'), trip('w2', 'WK'), trip('s1', 'SA'), trip('h1', 'HOL')];
    resetStore({
      routes: [{ route_id: 'R', route_short_name: 'R', route_long_name: 'R', route_type: 3 }] as never,
      stops: [stop],
      trips,
      stopTimes: trips.map((t) => st(t.trip_id)),
      calendars: [wk, sa],
      calendarDates: [holiday],
    });
  });

  it('passes trips, calendars and calendarDates and reports the representative service day', async () => {
    render(<TitleVIPanel />);
    await userEvent.click(screen.getByRole('button', { name: /Run Title VI Analysis/ }));
    await screen.findByText('Race / ethnicity');

    expect(calcSpy.calls).toHaveLength(1);
    const state = calcSpy.calls[0][2] as Record<string, unknown>;
    expect((state.trips as Trip[]).map((t) => t.trip_id)).toEqual(['w1', 'w2', 's1', 'h1']);
    expect((state.calendars as Calendar[]).map((c) => c.service_id)).toEqual(['WK', 'SA']);
    expect(state.calendarDates).toEqual([holiday]);
    // With the service inputs the result carries a basis day, which the panel
    // renders; the pre-fix call ({ stopTimes } only) produced no basis line.
    expect(screen.getByTestId('titlevi-basis')).toHaveTextContent(/^Based on /);
  });
});
