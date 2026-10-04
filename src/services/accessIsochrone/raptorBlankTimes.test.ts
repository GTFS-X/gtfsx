// S2-01: untimed (blank) stop_times are interpolated by index, never read as
// 00:00 — otherwise every timepoint-only feed marks its untimed stops reachable
// at midnight.
import { describe, expect, it } from 'vitest';
import type { RaptorFeedInput } from './types';
import { buildRaptorIndex, interpolateBlankTimes, runRaptor } from './raptor';

const hms = (s: number) =>
  `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
const st = (stop_id: string, seq: number, sec: number | null) => ({
  trip_id: 'T1', stop_id, stop_sequence: seq,
  arrival_time: sec === null ? '' : hms(sec), departure_time: sec === null ? '' : hms(sec),
});
const H8 = 8 * 3600;
const stops = ['A', 'B', 'C'].map((id, i) => ({ stop_id: id, stop_lat: 0, stop_lon: i * 0.01, parent_station: undefined }));
const feed = (times: (number | null)[]): RaptorFeedInput => ({
  stops,
  trips: [{ trip_id: 'T1', route_id: 'R1', service_id: 'SVC' }],
  stopTimes: times.map((t, i) => st(stops[i].stop_id, i + 1, t)),
});
const seed = [{ stopId: 'A', arrivalSec: H8 - 6 * 60 }];

describe('RAPTOR with blank intermediate times', () => {
  const idx = buildRaptorIndex(feed([H8, null, H8 + 1800]), new Set(['SVC']));

  it('B is not reached before the bus could get there', () => {
    expect(runRaptor(idx, seed, { cutoffSec: H8 + 600 }).get('B')).toBeUndefined();
  });

  it('B is reached at the interpolated time (08:15)', () => {
    expect(runRaptor(idx, seed, { cutoffSec: H8 + 1200 }).get('B')).toBe(H8 + 900);
  });

  it('a trailing untimed stop is never reached', () => {
    const tail = buildRaptorIndex(feed([H8, H8 + 600, null]), new Set(['SVC']));
    expect(runRaptor(tail, seed).get('C')).toBeUndefined();
  });

  it('interpolateBlankTimes fills by index and leaves the ends NaN', () => {
    const a = [Number.NaN, 100, Number.NaN, Number.NaN, 400, Number.NaN];
    const d = [...a];
    interpolateBlankTimes(a, d);
    expect(a.slice(1, 5)).toEqual([100, 200, 300, 400]);
    expect(Number.isNaN(a[0]) && Number.isNaN(a[5])).toBe(true);
  });
});
