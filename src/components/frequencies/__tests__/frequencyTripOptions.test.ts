// FrequenciesEditor trip options: linear build, same labels as before (C2-18).
import { describe, expect, it } from 'vitest';
import { buildTripOptions } from '../frequencyTripOptions';
import type { Route, Trip } from '../../../types/gtfs';

describe('buildTripOptions', () => {
  it('labels trips "route · headsign" and sorts by label', () => {
    const routes = [{ route_id: 'R1', route_short_name: '10' }, { route_id: 'R2', route_long_name: 'Main' }] as unknown as Route[];
    const trips = [
      { trip_id: 'b', route_id: 'R2', service_id: 'WK', trip_headsign: 'Downtown' },
      { trip_id: 'a', route_id: 'R1', service_id: 'WK' },
      { trip_id: 'c', route_id: 'GONE', service_id: 'WK' },
    ] as Trip[];
    const { labelById, options } = buildTripOptions(trips, routes);
    expect(labelById.get('a')).toBe('10 · a');
    expect(labelById.get('b')).toBe('Main · Downtown');
    expect(labelById.get('c')).toBe('GONE · c');
    expect(options.map((o) => o.value)).toEqual(['a', 'c', 'b']);
  });

  it('builds 20k trip options quickly (no per-option linear scans)', () => {
    const routes = Array.from({ length: 200 }, (_, i) => ({ route_id: `R${i}`, route_short_name: `${i}` })) as Route[];
    const trips = Array.from({ length: 20000 }, (_, i) => ({
      trip_id: `T${i}`, route_id: `R${i % 200}`, service_id: 'WK',
    })) as Trip[];
    const t0 = performance.now();
    const { options } = buildTripOptions(trips, routes);
    expect(options).toHaveLength(20000);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
