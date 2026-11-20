import { describe, expect, it } from 'vitest';
import length from '@turf/length';
import { lineString } from '@turf/helpers';
import {
  cumulativeMeters, detectShapeUnit, detectUnitFromPairs, findStaleStopDistances,
  planShapeDistanceRecompute, pointAtShapeDistance, projectStopsOntoShape, snapUnit,
  toFeedDistances, DIST_UNIT_FACTORS, type LngLat,
} from '../shapeDistRecompute';
import type { ShapePoint } from '../../types/gtfs';

const LAT = 45;
/** Points along a street at LAT, from lon0 east by `n` steps of `step`°. */
const street = (lon0: number, n: number, step = 0.001, lat = LAT): LngLat[] =>
  Array.from({ length: n + 1 }, (_, i) => [lon0 + i * step, lat] as LngLat);

const toPoints = (coords: LngLat[], unitFactor = 1, withDist = true): ShapePoint[] => {
  const cum = cumulativeMeters(coords);
  return coords.map((c, i) => ({
    shape_pt_lon: c[0], shape_pt_lat: c[1], shape_pt_sequence: i + 1,
    shape_dist_traveled: withDist ? cum[i] * unitFactor : 0,
  }));
};

describe('cumulativeMeters', () => {
  it('matches turf length (what fillShapeDistances uses)', () => {
    const coords = street(-112.5, 40).map(([x, y], i) => [x, y + (i % 3) * 0.0002] as LngLat);
    const cum = cumulativeMeters(coords);
    expect(cum[0]).toBe(0);
    expect(cum[cum.length - 1]).toBeCloseTo(length(lineString(coords), { units: 'meters' }), 6);
  });
});

describe('projectStopsOntoShape', () => {
  it('places stops on a straight line at their along-distance', () => {
    const coords = street(-112.5, 10);
    const cum = cumulativeMeters(coords);
    const stops: LngLat[] = [[-112.5 + 0.0025, LAT + 0.00003], [-112.5 + 0.0061, LAT - 0.00002]];
    const r = projectStopsOntoShape(coords, stops);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.along[0]).toBeCloseTo(cum[2] + (cum[3] - cum[2]) / 2, 0);
    expect(r.along[1]).toBeCloseTo(cum[6] + (cum[7] - cum[6]) * 0.1, 0);
    expect(r.maxOffset).toBeLessThan(5);
  });

  it('puts a stop at the shape start at 0 and one at the end at the full length', () => {
    const coords = street(-112.5, 10);
    const total = cumulativeMeters(coords).at(-1)!;
    const r = projectStopsOntoShape(coords, [coords[0], [-112.495, LAT], coords[10]]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.along[0]).toBeCloseTo(0, 3);
    expect(r.along[2]).toBeCloseTo(total, 3);
  });

  it('a loop that starts and ends at the same stop gets 0 and the full length', () => {
    // Square loop: east, north, west, south back to the start.
    const d = 0.004;
    const o: LngLat = [-112.5, LAT];
    const coords: LngLat[] = [
      ...street(o[0], 4),
      ...[1, 2, 3, 4].map((i) => [o[0] + d, LAT + i * 0.001] as LngLat),
      ...[1, 2, 3, 4].map((i) => [o[0] + d - i * 0.001, LAT + d] as LngLat),
      ...[1, 2, 3, 4].map((i) => [o[0], LAT + d - i * 0.001] as LngLat),
    ];
    const total = cumulativeMeters(coords).at(-1)!;
    const stops: LngLat[] = [o, [o[0] + d, LAT + 0.002], [o[0] + 0.002, LAT + d], o];
    const r = projectStopsOntoShape(coords, stops);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.along[0]).toBeCloseTo(0, 3);
    expect(r.along[3]).toBeCloseTo(total, 3);
    for (let i = 1; i < 4; i++) expect(r.along[i]).toBeGreaterThan(r.along[i - 1]);
  });

  it('out-and-back: an outbound stop nearer the RETURN leg still gets the outbound pass', () => {
    // Outbound along LAT, return ~5.6 m north. Outbound stops sit 4.4 m north of
    // the outbound leg — 1.1 m from the return leg — so nearest-point would
    // put them on the return leg and strand every later stop.
    const out = street(-112.5, 10);
    const back = street(-112.5, 10, 0.001, LAT + 0.00005).reverse();
    const coords = [...out, ...back];
    const cum = cumulativeMeters(coords);
    const half = cum[10];
    const stops: LngLat[] = [
      [-112.498, LAT + 0.00004], // outbound, biased toward the return leg
      [-112.495, LAT + 0.00004], // outbound, biased toward the return leg
      [-112.49, LAT + 0.000025], // turnaround
      [-112.494, LAT + 0.00005], // return
      [-112.499, LAT + 0.00005], // return
    ];
    const r = projectStopsOntoShape(coords, stops, cum);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.along[0]).toBeLessThan(half);
    expect(r.along[1]).toBeLessThan(half);
    expect(r.along[3]).toBeGreaterThan(half);
    expect(r.along[4]).toBeGreaterThan(r.along[3]);
    expect(r.along[0]).toBeCloseTo(cum[2], -1);
  });

  it('a stop passed twice in one trip (figure-eight) gets each pass in order', () => {
    // East along LAT, loop north and come back west along LAT+0.002, then
    // south through the middle again and east to the end — the middle point
    // (-112.496, LAT+0.001) is passed twice.
    const coords: LngLat[] = [
      [-112.5, LAT], [-112.496, LAT], [-112.496, LAT + 0.001], [-112.496, LAT + 0.002],
      [-112.492, LAT + 0.002], [-112.492, LAT + 0.001], [-112.496, LAT + 0.001], [-112.5, LAT + 0.001],
    ];
    const cum = cumulativeMeters(coords);
    const mid: LngLat = [-112.496, LAT + 0.001];
    const r = projectStopsOntoShape(coords, [coords[0], mid, coords[4], mid, coords[7]], cum);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.along[1]).toBeCloseTo(cum[2], 0);
    expect(r.along[3]).toBeCloseTo(cum[6], 0);
  });

  it('fails when a stop has no coordinates or sits far off the shape', () => {
    const coords = street(-112.5, 10);
    expect(projectStopsOntoShape(coords, [coords[0], null]).ok).toBe(false);
    expect(projectStopsOntoShape(coords, [coords[0], [-112.495, LAT + 0.05]]).ok).toBe(false);
  });

  it('fails when no forward-only placement exists (stops listed backwards)', () => {
    // A long straight line with stops in reverse order can't be placed
    // monotonically without a huge detour — every candidate runs backwards.
    const coords = street(-112.5, 10);
    const r = projectStopsOntoShape(coords, [coords[9], coords[1]]);
    expect(r.ok).toBe(false);
  });
});

describe('toFeedDistances', () => {
  it('converts units and keeps duplicate consecutive stops strictly increasing', () => {
    const out = toFeedDistances([0, 1000, 1000, 2500], 'km');
    expect(out[0]).toBe(0);
    expect(out[1]).toBeCloseTo(1, 9);
    expect(out[2]).toBeGreaterThan(out[1]);
    expect(out[2] - out[1]).toBeLessThan(1e-5);
    expect(out[3]).toBeCloseTo(2.5, 9);
  });
});

describe('unit detection', () => {
  const coords = street(-112.5, 20);
  it('snaps ratios to m / km / ft / mi', () => {
    expect(snapUnit(1)).toBe('m');
    expect(snapUnit(1.2)).toBe('m');
    expect(snapUnit(0.001)).toBe('km');
    expect(snapUnit(3.28)).toBe('ft');
    expect(snapUnit(0.00062)).toBe('mi');
    expect(snapUnit(2)).toBeNull();
    expect(snapUnit(0)).toBeNull();
  });
  it('reads a shape\'s own unit from its stored distances', () => {
    expect(detectShapeUnit(toPoints(coords, 1))).toBe('m');
    expect(detectShapeUnit(toPoints(coords, DIST_UNIT_FACTORS.km))).toBe('km');
    expect(detectShapeUnit(toPoints(coords, DIST_UNIT_FACTORS.ft))).toBe('ft');
    expect(detectShapeUnit(toPoints(coords, 1, false))).toBeNull();
  });
  it('uses the median ratio and ignores tiny lengths', () => {
    expect(detectUnitFromPairs([[1, 1000], [1.1, 1000], [5000, 1000], [0.9, 1000]])).toBe('km');
    expect(detectUnitFromPairs([[10, 10]])).toBeNull();
  });
});

describe('planShapeDistanceRecompute', () => {
  const stopsAt: Record<string, LngLat> = {
    A: [-112.5, LAT], B: [-112.495, LAT + 0.00002], C: [-112.49, LAT], D: [-112.485, LAT],
  };
  const stopCoord = (id: string) => stopsAt[id] ?? null;

  it('extends a km feed: recomputes shapes + stop distances in km', () => {
    // Shape was A→C; it's been extended to D. Distances are stale (km) and the
    // shape's own column was zeroed by the edit.
    const before = street(-112.5, 10);
    const after = street(-112.5, 15);
    const other = { shape_id: 'OTHER', points: toPoints(street(-112.4, 30), DIST_UNIT_FACTORS.km) };
    const plan = planShapeDistanceRecompute({
      shape_id: 'S',
      points: toPoints(after, 1, false),
      allShapes: [{ shape_id: 'S', points: toPoints(after, 1, false) }, other],
      trips: [{ trip_id: 't1', shape_id: 'S' }, { trip_id: 't2', shape_id: 'S' }],
      stopTimes: [
        { trip_id: 't1', stop_id: 'A', stop_sequence: 1, shape_dist_traveled: 0 },
        { trip_id: 't1', stop_id: 'B', stop_sequence: 2, shape_dist_traveled: 0.39 },
        { trip_id: 't1', stop_id: 'C', stop_sequence: 3, shape_dist_traveled: cumulativeMeters(before).at(-1)! / 1000 },
        { trip_id: 't1', stop_id: 'D', stop_sequence: 4, shape_dist_traveled: 0.5 },
        // t2 publishes no stop distances: left alone.
        { trip_id: 't2', stop_id: 'A', stop_sequence: 1 },
        { trip_id: 't2', stop_id: 'D', stop_sequence: 2 },
      ],
      stopCoord,
    })!;
    expect(plan.unit).toBe('km');
    const total = cumulativeMeters(after).at(-1)!;
    expect(plan.shapeDistances.at(-1)!).toBeCloseTo(total / 1000, 9);
    expect(plan.tripsRecomputed).toEqual(['t1']);
    const v = plan.tripUpdates[0].values;
    expect(v.get(1)).toBeCloseTo(0, 6);
    expect(v.get(4)!).toBeCloseTo(total / 1000, 4);
    expect(v.get(3)!).toBeCloseTo(cumulativeMeters(before).at(-1)! / 1000, 4);
  });

  it('falls back to the stop distances for the unit, then to metres', () => {
    const coords = street(-112.5, 15);
    const total = cumulativeMeters(coords).at(-1)!;
    const base = {
      shape_id: 'S', points: toPoints(coords, 1, false), allShapes: [],
      trips: [{ trip_id: 't', shape_id: 'S' }], stopCoord,
    };
    const ft = planShapeDistanceRecompute({
      ...base,
      stopTimes: [
        { trip_id: 't', stop_id: 'A', stop_sequence: 1, shape_dist_traveled: 0 },
        { trip_id: 't', stop_id: 'D', stop_sequence: 2, shape_dist_traveled: total * 3.1 },
      ],
    })!;
    expect(ft.unit).toBe('ft');
    const m = planShapeDistanceRecompute({ ...base, stopTimes: [], fillMissing: true })!;
    expect(m.unit).toBe('m');
  });

  it('clears a trip whose stops can\'t be placed, instead of leaving stale values', () => {
    const coords = street(-112.5, 15);
    const plan = planShapeDistanceRecompute({
      shape_id: 'S', points: toPoints(coords), allShapes: [],
      trips: [{ trip_id: 'bad', shape_id: 'S' }],
      stopTimes: [
        { trip_id: 'bad', stop_id: 'A', stop_sequence: 1, shape_dist_traveled: 0 },
        { trip_id: 'bad', stop_id: 'GONE', stop_sequence: 2, shape_dist_traveled: 400 },
      ],
      stopCoord,
    })!;
    expect(plan.tripsCleared.map((t) => t.trip_id)).toEqual(['bad']);
    expect([...plan.tripUpdates[0].values.values()]).toEqual([undefined, undefined]);
  });
});

describe('findStaleStopDistances', () => {
  const stopsAt: Record<string, LngLat> = { A: [-112.5, LAT], B: [-112.495, LAT], C: [-112.49, LAT] };
  const stopCoord = (id: string) => stopsAt[id] ?? null;

  it('flags a shape whose stop distances point ~1 km away, and not a correct one', () => {
    // The shape got a ~0.79 km extension at its START; stop distances still
    // measure from the old start.
    const coords = street(-112.51, 20);
    const shape = { shape_id: 'S', points: toPoints(coords) };
    const cum = cumulativeMeters(coords);
    const stale = [
      { trip_id: 't', stop_id: 'A', stop_sequence: 1, shape_dist_traveled: 0 },
      { trip_id: 't', stop_id: 'B', stop_sequence: 2, shape_dist_traveled: cum[15] - cum[10] },
      { trip_id: 't', stop_id: 'C', stop_sequence: 3, shape_dist_traveled: cum[20] - cum[10] },
    ];
    const found = findStaleStopDistances([shape], [{ trip_id: 't', shape_id: 'S' }], stale, stopCoord);
    expect(found).toHaveLength(1);
    expect(found[0].stopCount).toBe(3);
    expect(found[0].worstMeters).toBeGreaterThan(700);

    const fresh = stale.map((st, i) => ({ ...st, shape_dist_traveled: cum[10 + i * 5] }));
    expect(findStaleStopDistances([shape], [{ trip_id: 't', shape_id: 'S' }], fresh, stopCoord)).toEqual([]);
  });

  it('pointAtShapeDistance interpolates the stored column', () => {
    const pts = toPoints(street(-112.5, 2));
    const mid = pointAtShapeDistance(pts, pts[1].shape_dist_traveled / 2)!;
    expect(mid[0]).toBeCloseTo(-112.4995, 6);
  });
});
