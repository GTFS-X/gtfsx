// @vitest-environment jsdom
// S2-06: BlockGantt must hand calendarDates to the cost engine. For a
// calendar_dates-only service the service days come entirely from the dated
// exceptions. With the pre-fix `calendarDates: []` the engine could not see the
// service at all and priced it at the unknown-service default (365 days/year);
// before B6 the dates-only service was not even selectable (no cost header).
import '../../../test-utils/dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { resetStore } from '../../../test-utils/store';
import type { CalendarDate, Route, Stop, StopTime, Trip } from '../../../types/gtfs';
import { BlockGantt } from '../BlockGantt';

const stop = (id: string, lat: number): Stop =>
  ({ stop_id: id, stop_name: id, stop_lat: lat, stop_lon: -111, location_type: 0 }) as Stop;
const trip = (id: string): Trip =>
  ({ trip_id: id, route_id: 'R', service_id: 'EVENT', direction_id: 0, block_id: 'B1' }) as Trip;
const st = (trip_id: string, stop_id: string, seq: number, t: string): StopTime =>
  ({ trip_id, stop_id, stop_sequence: seq, arrival_time: t, departure_time: t }) as StopTime;
const dated = (date: string): CalendarDate => ({ service_id: 'EVENT', date, exception_type: 1 }) as CalendarDate;

describe('BlockGantt cost header (S2-06)', () => {
  beforeEach(() => {
    resetStore({
      routes: [{ route_id: 'R', route_short_name: 'R', route_long_name: 'R', route_type: 3 } as Route],
      stops: [stop('A', 45), stop('B', 45.05)],
      trips: [trip('t1'), trip('t2')],
      stopTimes: [
        st('t1', 'A', 1, '08:00:00'), st('t1', 'B', 2, '09:00:00'),
        st('t2', 'B', 1, '09:30:00'), st('t2', 'A', 2, '10:30:00'),
      ],
      calendars: [],
      calendarDates: [dated('20260101'), dated('20260701'), dated('20261231')],
    });
  });

  it('prices a calendar_dates-only service from its three dated days (spread over one year)', () => {
    render(<BlockGantt />);
    const dollars = (label: RegExp) =>
      Number((screen.getByText(label).nextElementSibling as HTMLElement).textContent!.replace(/[^0-9]/g, ''));
    const daily = dollars(/^Daily/);
    const annual = dollars(/Annual/);
    expect(daily).toBeGreaterThan(0);
    // Three service days a year: annual = 3 × daily (± rounding of the display).
    expect(Math.abs(annual - 3 * daily)).toBeLessThanOrEqual(3);
  });
});
