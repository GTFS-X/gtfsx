// E2E E1: Route › Shapes › Simplify wrote the simplified points to the store
// BEFORE entering edit_shape, so the edit-mode snapshot was of the simplified
// shape and Cancel didn't restore the original. It also took two undos.
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { useStore } from '../../../store';
import { resetHistory, undo } from '../../../store/history';
import { nextShapeEditSnapshot } from '../../map/mapInteractions';
import { applyShapeSimplification } from '../routePanelHelpers';
import type { ShapePoint } from '../../../types/gtfs';

const s = () => useStore.getState();

const pt = (i: number): ShapePoint => ({
  shape_pt_lat: 45 + i * 0.001,
  shape_pt_lon: -111 + (i % 2) * 0.0001,
  shape_pt_sequence: i,
  shape_dist_traveled: i * 100,
});
const ORIGINAL = Array.from({ length: 9 }, (_, i) => pt(i));
const SIMPLIFIED = [pt(0), pt(8)].map((p, i) => ({ ...p, shape_pt_sequence: i }));

beforeEach(() => {
  s().setShapes([{ shape_id: 'sh1', points: ORIGINAL }]);
  resetHistory();
});

describe('Simplify, then edit', () => {
  it('the edit session snapshots the pre-simplify points, so Cancel restores them', () => {
    applyShapeSimplification('sh1', SIMPLIFIED);
    const current = s().shapes.find((x) => x.shape_id === 'sh1')!.points;
    expect(current).toHaveLength(2);

    // What MapView does when edit_shape starts (ref was cleared outside edit mode).
    const snap = nextShapeEditSnapshot(null, 'sh1', current);
    expect(snap.points).toHaveLength(ORIGINAL.length);
    expect(snap.points.map((p) => p.shape_pt_lat)).toEqual(ORIGINAL.map((p) => p.shape_pt_lat));
  });

  it('the primed snapshot is used once and never leaks into a later edit', () => {
    applyShapeSimplification('sh1', SIMPLIFIED);
    nextShapeEditSnapshot(null, 'sh1', SIMPLIFIED);
    const later = nextShapeEditSnapshot(null, 'sh1', SIMPLIFIED);
    expect(later.points).toHaveLength(2);

    applyShapeSimplification('sh1', SIMPLIFIED);
    // A different shape's edit discards it.
    nextShapeEditSnapshot(null, 'other', SIMPLIFIED);
    expect(nextShapeEditSnapshot(null, 'sh1', SIMPLIFIED).points).toHaveLength(2);
  });

  it('is a single undo step', () => {
    applyShapeSimplification('sh1', SIMPLIFIED);
    expect(undo()).toBe('Simplify shape');
    expect(s().shapes.find((x) => x.shape_id === 'sh1')!.points).toHaveLength(ORIGINAL.length);
  });

  it('RouteShapesTab routes the Simplify level buttons through the helper', () => {
    const src = readFileSync(fileURLToPath(new URL('../RouteShapesTab.tsx', import.meta.url)), 'utf8');
    const i = src.indexOf('SIMPLIFY_LEVELS.map');
    const picker = src.slice(i, src.indexOf('</button>', i));
    expect(picker).toMatch(/applyShapeSimplification\(shape!\.shape_id, preview\)/);
    expect(picker).not.toMatch(/updateShapePoints\(/);
  });
});
