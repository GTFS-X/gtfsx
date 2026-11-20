// Shape edits keep stop_times.shape_dist_traveled honest: the recompute runs
// inside the same undo step as the geometry change, Cancel-style restores put
// the original values back exactly, and variants carry the change.
import { beforeEach, describe, expect, it } from 'vitest';
import { resetStore, store } from '../../test-utils/store';
import { historyDepths, undo, redo } from '../history';
import { commitShapeGeometry, recomputeShapeDistances } from '../../services/shapeEdit';
import { cumulativeMeters, type LngLat } from '../../services/shapeDistRecompute';
import { createVariantFromCurrent, switchToVariant, baselineVariant } from '../../services/variants';
import { buildVariantsEnvelope, parseVariantsEnvelope } from '../../services/variantPersistence';
import type { Shape, ShapePoint, Stop, StopTime, Trip } from '../../types/gtfs';

const LAT = 46;
const street = (lon0: number, n: number): LngLat[] =>
  Array.from({ length: n + 1 }, (_, i) => [lon0 + i * 0.001, LAT] as LngLat);
const pts = (coords: LngLat[], factor = 1): ShapePoint[] => {
  const cum = cumulativeMeters(coords);
  return coords.map((c, i) => ({ shape_pt_lon: c[0], shape_pt_lat: c[1], shape_pt_sequence: i, shape_dist_traveled: cum[i] * factor }));
};

const BEFORE = street(-112.5, 10);
const AFTER = [...street(-112.51, 10), ...street(-112.5, 10).slice(1)]; // extended ~0.77 km at the start

const stops: Stop[] = [
  { stop_id: 'A', stop_name: 'A', stop_lat: LAT, stop_lon: -112.5 },
  { stop_id: 'B', stop_name: 'B', stop_lat: LAT + 0.00002, stop_lon: -112.495 },
  { stop_id: 'C', stop_name: 'C', stop_lat: LAT, stop_lon: -112.49 },
  { stop_id: 'X', stop_name: 'Start of extension', stop_lat: LAT, stop_lon: -112.51 },
] as Stop[];

function seed(factor = 1) {
  const cum = cumulativeMeters(BEFORE);
  const st = (trip: string, stop: string, seq: number, d?: number): StopTime =>
    ({ trip_id: trip, stop_id: stop, stop_sequence: seq, arrival_time: '', departure_time: '', ...(d === undefined ? {} : { shape_dist_traveled: d }) }) as StopTime;
  resetStore({
    shapes: [
      { shape_id: 'S', points: pts(BEFORE, factor) } as Shape,
      { shape_id: 'OTHER', points: pts(street(-112.3, 20), factor) } as Shape,
    ],
    stops,
    trips: [
      { trip_id: 't1', route_id: 'R', service_id: 'WK', direction_id: 0, shape_id: 'S' },
      { trip_id: 't2', route_id: 'R', service_id: 'WK', direction_id: 0, shape_id: 'S' },
      { trip_id: 'nodist', route_id: 'R', service_id: 'WK', direction_id: 0, shape_id: 'S' },
    ] as Trip[],
    stopTimes: [
      st('t1', 'A', 1, 0), st('t1', 'B', 2, cum[5] * factor), st('t1', 'C', 3, cum[10] * factor),
      st('t2', 'A', 1, 0), st('t2', 'C', 2, cum[10] * factor),
      st('nodist', 'A', 1), st('nodist', 'C', 2),
    ],
  });
}

const dist = (trip: string, seq: number) =>
  store().stopTimes.find((r) => r.trip_id === trip && r.stop_sequence === seq)?.shape_dist_traveled;
const asPts = (c: LngLat[]) => c.map(([lon, lat]) => ({ shape_pt_lon: lon, shape_pt_lat: lat }));

describe('shape edit → shape_dist_traveled recompute', () => {
  beforeEach(() => seed());

  it('extending a shape re-projects every trip\'s stop distances, in ONE undo step', () => {
    const report = commitShapeGeometry('S', asPts(AFTER));
    expect(report?.unit).toBe('m');
    expect(report?.tripsRecomputed).toBe(2);
    const ext = cumulativeMeters(AFTER)[10]; // length of the extension
    const cumAfter = cumulativeMeters(AFTER);
    expect(dist('t1', 1)!).toBeCloseTo(ext, 0);
    expect(dist('t1', 3)!).toBeCloseTo(cumAfter.at(-1)!, 0);
    expect(dist('t2', 2)!).toBeCloseTo(cumAfter.at(-1)!, 0);
    // A trip that publishes no stop distances keeps publishing none.
    expect(dist('nodist', 1)).toBeUndefined();
    // Shape column matches the new geometry.
    const shape = store().shapes.find((s) => s.shape_id === 'S')!;
    expect(shape.points.at(-1)!.shape_dist_traveled).toBeCloseTo(cumAfter.at(-1)!, 6);

    expect(historyDepths().undo).toBe(1);
    undo();
    expect(store().shapes.find((s) => s.shape_id === 'S')!.points).toHaveLength(BEFORE.length);
    expect(dist('t1', 1)).toBe(0);
    expect(dist('t1', 3)!).toBeCloseTo(cumulativeMeters(BEFORE).at(-1)!, 6);
    redo();
    expect(dist('t1', 1)!).toBeCloseTo(ext, 0);
  });

  it('keeps a kilometre feed in kilometres', () => {
    seed(0.001);
    const report = commitShapeGeometry('S', asPts(AFTER));
    expect(report?.unit).toBe('km');
    expect(dist('t1', 3)!).toBeCloseTo(cumulativeMeters(AFTER).at(-1)! / 1000, 4);
    expect(store().shapes.find((s) => s.shape_id === 'S')!.points.at(-1)!.shape_dist_traveled)
      .toBeCloseTo(cumulativeMeters(AFTER).at(-1)! / 1000, 6);
  });

  it('clears (not leaves stale) a trip whose stops can\'t be placed', () => {
    // Move the shape ~3.3 km north, so every stop is > 1 km off it.
    const far = street(-112.5, 10).map(([x]) => [x, LAT + 0.03] as LngLat);
    const report = commitShapeGeometry('S', asPts(far));
    expect(report?.tripsCleared.map((t) => t.trip_id).sort()).toEqual(['t1', 't2']);
    expect(dist('t1', 2)).toBeUndefined();
    expect(store().stopTimes.find((r) => r.trip_id === 't1' && r.stop_sequence === 2)).not.toHaveProperty('shape_dist_traveled');
    undo();
    expect(dist('t1', 2)!).toBeGreaterThan(0);
  });

  it('restoreShapeDistances reverses a recompute exactly (validation-fix undo)', () => {
    const before = store().stopTimes.map((r) => r.shape_dist_traveled);
    store().updateShapePoints('S', pts(AFTER, 0));
    const report = store().recalcShapeDistances('S')!;
    expect(report.stopTimesChanged).toBeGreaterThan(0);
    store().restoreShapeDistances(report.snapshot);
    expect(store().stopTimes.map((r) => r.shape_dist_traveled)).toEqual(before);
  });

  it('clearShapeDistances drops stop distances on the shape only', () => {
    const report = store().clearShapeDistances('S')!;
    expect(report.stopTimesChanged).toBe(5);
    expect(store().stopTimes.every((r) => r.shape_dist_traveled === undefined)).toBe(true);
    store().restoreShapeDistances(report.snapshot);
    expect(dist('t1', 3)).toBeGreaterThan(0);
  });

  it('recomputeShapeDistances on an unedited shape is a no-op step', () => {
    commitShapeGeometry('S', asPts(AFTER));
    const depth = historyDepths().undo;
    const r = recomputeShapeDistances('S');
    expect(r?.stopTimesChanged).toBe(0);
    expect(r?.shapeChanged).toBe(false);
    expect(historyDepths().undo).toBe(depth);
  });
});

describe('variants carry recomputed distances', () => {
  beforeEach(() => {
    seed();
    store().setVariants([]);
    store().setActiveVariantId(null);
  });

  it('an edit in a variant leaves the baseline\'s distances alone and survives save/load', () => {
    const vid = createVariantFromCurrent('Extend');
    commitShapeGeometry('S', asPts(AFTER));
    const extended = dist('t1', 3)!;
    expect(extended).toBeGreaterThan(cumulativeMeters(BEFORE).at(-1)! + 500);

    switchToVariant(baselineVariant()!.id);
    expect(dist('t1', 3)!).toBeCloseTo(cumulativeMeters(BEFORE).at(-1)!, 6);
    switchToVariant(vid);
    expect(dist('t1', 3)).toBe(extended);

    // Persisted as a diff from baseline and rebuilt.
    const base = baselineVariant()!.snapshot;
    store().updateVariantSnapshot(vid, { ...store().variants.find((v) => v.id === vid)!.snapshot, stopTimes: store().stopTimes, shapes: store().shapes });
    const env = buildVariantsEnvelope(store().variants, vid, base);
    const parsed = parseVariantsEnvelope({ __variants: env }, base)!;
    const v = parsed.variants.find((x) => x.id === vid)!;
    const rows = v.snapshot.stopTimes as StopTime[];
    expect(rows.find((r) => r.trip_id === 't1' && r.stop_sequence === 3)!.shape_dist_traveled).toBe(extended);
  });
});
