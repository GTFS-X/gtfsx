// S1-27: recalcShapeDistances is a single O(n) pass (shared fillShapeDistances)
// and matches the old per-prefix turf measurement.
import { describe, expect, it } from 'vitest';
import length from '@turf/length';
import { lineString } from '@turf/helpers';
import { useStore } from '../../store';
import type { Shape } from '../../types/gtfs';

const pts = (n: number): Shape['points'] =>
  Array.from({ length: n }, (_, i) => ({
    shape_pt_lat: 45 + i * 0.0003 + (i % 7) * 0.00005,
    shape_pt_lon: -111 + i * 0.0002,
    shape_pt_sequence: i + 1,
    shape_dist_traveled: 0,
  }));

describe('recalcShapeDistances (S1-27)', () => {
  it('matches the per-prefix measure', () => {
    const points = pts(200);
    useStore.getState().setShapes([{ shape_id: 'S', points }]);
    useStore.getState().recalcShapeDistances('S');
    const got = useStore.getState().shapes[0].points.map((p) => p.shape_dist_traveled);
    const coords = points.map((p) => [p.shape_pt_lon, p.shape_pt_lat] as [number, number]);
    expect(got[0]).toBe(0);
    for (const i of [1, 50, 199]) {
      const expected = length(lineString(coords.slice(0, i + 1)), { units: 'meters' });
      expect(got[i]).toBeCloseTo(expected, 6);
    }
    for (let i = 1; i < got.length; i++) expect(got[i]).toBeGreaterThan(got[i - 1]);
  });

  it('handles a 20k-point shape quickly', () => {
    useStore.getState().setShapes([{ shape_id: 'BIG', points: pts(20000) }]);
    const t0 = performance.now();
    useStore.getState().recalcShapeDistances('BIG');
    expect(performance.now() - t0).toBeLessThan(2000);
    const last = useStore.getState().shapes[0].points[19999].shape_dist_traveled;
    expect(last).toBeGreaterThan(0);
  });
});
