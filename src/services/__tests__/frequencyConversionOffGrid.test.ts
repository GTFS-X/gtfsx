// S2-02: a template whose own time is not on its windows' grid takes over the
// first departure instead of surviving as an extra (phantom) trip.
import { describe, expect, it } from 'vitest';
import { computeFrequencyConversion } from '../frequencyConversion';
import type { StopTime } from '../../types/gtfs';

const st = (seq: number, hms: string): StopTime =>
  ({ trip_id: 'FQ', stop_id: `s${seq}`, stop_sequence: seq, arrival_time: hms, departure_time: hms });
const input = (t0: string, t1: string) => ({
  templateTripIds: ['FQ'],
  trips: [{ trip_id: 'FQ', route_id: 'R1', service_id: 'wk', direction_id: 0 as const }],
  stopTimes: [st(1, t0), st(2, t1)],
  frequencies: [{ trip_id: 'FQ', start_time: '06:00:00', end_time: '07:00:00', headway_secs: 1200 }],
  routes: [{ route_id: 'R1', agency_id: 'A', route_short_name: 'B', route_long_name: '', route_type: 3, route_color: 'FFFFFF', route_text_color: '000000' }],
});

describe('frequency conversion with an off-grid template', () => {
  it('a 00:00 template under a 06:00–07:00 / 20-min window → exactly 3 trips, all in the window', () => {
    const r = computeFrequencyConversion(input('00:00:00', '00:10:00'));
    expect(r.totalResultTrips).toBe(3);
    expect(r.newTrips).toHaveLength(2);
    expect(r.perTemplate[0].retimed).toBe(true);
    expect(r.retimedTemplateStopTimes.map((x) => [x.trip_id, x.stop_sequence, x.departure_time]))
      .toEqual([['FQ', 1, '06:00:00'], ['FQ', 2, '06:10:00']]);
    const starts = [
      ...r.newStopTimes.filter((x) => x.stop_sequence === 1).map((x) => x.departure_time),
      r.retimedTemplateStopTimes[0].departure_time,
    ].sort();
    expect(starts).toEqual(['06:00:00', '06:20:00', '06:40:00']);
  });

  it('an on-grid template (06:00) still yields 3 trips and is not re-timed', () => {
    const r = computeFrequencyConversion(input('06:00:00', '06:10:00'));
    expect(r.totalResultTrips).toBe(3);
    expect(r.newTrips).toHaveLength(2);
    expect(r.retimedTemplateStopTimes).toEqual([]);
  });
});
