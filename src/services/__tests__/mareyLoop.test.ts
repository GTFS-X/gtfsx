// S2-03: a loop route (first stop repeated at the end) plots by occurrence, so
// the line starts at the origin departure and ends at the full loop distance.
import { describe, expect, it } from 'vitest';
import { buildMareyData } from '../marey';
import type { Stop, StopTime } from '../../types/gtfs';

const stop = (id: string, lon: number): Stop =>
  ({ stop_id: id, stop_name: id, stop_lat: 0, stop_lon: lon, location_type: 0, wheelchair_boarding: 0 });
const st = (stop_id: string, seq: number, t: string): StopTime =>
  ({ trip_id: 'L', stop_id, stop_sequence: seq, arrival_time: t, departure_time: t });

describe('buildMareyData on a loop', () => {
  it('points are strictly increasing in time, from (08:00, 0 km) to (08:20, ~2.22 km)', () => {
    const A = stop('A', 0);
    const B = stop('B', 0.01);
    const data = buildMareyData({
      orderedStops: [A, B, A],
      trips: [{ trip_id: 'L' }],
      stopTimesByTrip: new Map([['L', [st('A', 1, '08:00:00'), st('B', 2, '08:10:00'), st('A', 3, '08:20:00')]]]),
    });
    const pts = data.trips[0].points;
    expect(pts.map((p) => p.timeSec)).toEqual([8 * 3600, 8 * 3600 + 600, 8 * 3600 + 1200]);
    expect(pts[0].distanceKm).toBe(0);
    expect(pts[2].distanceKm).toBeCloseTo(2.22, 2);
    expect(pts[1].distanceKm).toBeCloseTo(1.11, 2);
  });
});
