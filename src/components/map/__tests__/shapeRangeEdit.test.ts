import { describe, expect, it } from 'vitest';
import {
  chooseCandidate, isContiguous, rangeIndices, removeVertices, spliceSegment, vertexCandidates,
  SELECT_PRIORITY_RADIUS_PX, type LngLat,
} from '../shapeRangeEdit';

describe('range selection helpers', () => {
  it('rangeIndices covers both ends in either order', () => {
    expect(rangeIndices(3, 6)).toEqual([3, 4, 5, 6]);
    expect(rangeIndices(6, 3)).toEqual([3, 4, 5, 6]);
    expect(rangeIndices(2, 2)).toEqual([2]);
  });
  it('isContiguous', () => {
    expect(isContiguous([4, 5, 6])).toBe(true);
    expect(isContiguous([4, 6])).toBe(false);
    expect(isContiguous([])).toBe(false);
  });
  it('removeVertices refuses to leave fewer than two points', () => {
    expect(removeVertices([0, 1, 2, 3, 4], [1, 2, 3])).toEqual([0, 4]);
    expect(removeVertices([0, 1, 2], [0, 1])).toBeNull();
  });
});

describe('select-priority hit testing', () => {
  // A dense cluster: vertices 2 px apart along x, plus one far away.
  const px = [{ x: 100, y: 100 }, { x: 102, y: 100 }, { x: 104, y: 100 }, { x: 300, y: 300 }];

  it('a press near existing vertices finds them (nearest first), so it selects instead of inserting', () => {
    // 1 px right of vertex 1 — exactly where a midpoint between 0 and 1 sits.
    expect(vertexCandidates(px, { x: 101.2, y: 100 })).toEqual([1, 0, 2]);
    expect(vertexCandidates(px, { x: 200, y: 200 })).toEqual([]);
    expect(vertexCandidates(px, { x: 100 + SELECT_PRIORITY_RADIUS_PX + 1, y: 100 })).toEqual([2, 1]);
  });

  it('pressing the same spot again cycles through overlapping vertices', () => {
    const cands = [7, 42, 8];
    const at = { x: 50, y: 50 };
    expect(chooseCandidate(cands, at, null)).toBe(7);
    expect(chooseCandidate(cands, at, { at, chosen: 7 })).toBe(42);
    expect(chooseCandidate(cands, at, { at, chosen: 42 })).toBe(8);
    expect(chooseCandidate(cands, at, { at, chosen: 8 })).toBe(7);
    // A press somewhere else starts over at the nearest.
    expect(chooseCandidate(cands, { x: 80, y: 50 }, { at, chosen: 7 })).toBe(7);
    expect(chooseCandidate([], at, null)).toBeNull();
  });
});

describe('spliceSegment (Redraw segment)', () => {
  const line: LngLat[] = Array.from({ length: 11 }, (_, i) => [-112.5 + i * 0.001, 46] as LngLat);

  it('replaces the vertices between start and end, keeping both ends', () => {
    const detour: LngLat[] = [line[3], [-112.4965, 46.001], [-112.4945, 46.001], line[7]];
    const out = spliceSegment(line, 3, 7, detour);
    expect(out.slice(0, 4)).toEqual(line.slice(0, 4));
    expect(out.slice(4, 6)).toEqual([[-112.4965, 46.001], [-112.4945, 46.001]]);
    expect(out.slice(6)).toEqual(line.slice(7));
    expect(out).toHaveLength(4 + 2 + 4);
  });

  it('drops a routed path\'s road-snapped ends when they sit next to the vertices', () => {
    const routed: LngLat[] = [[-112.497, 46.00002], [-112.496, 46.0005], [-112.495, 46.0005], [-112.4930, 45.99998]];
    const out = spliceSegment(line, 3, 7, routed);
    expect(out).toContainEqual(line[3]);
    expect(out).toContainEqual(line[7]);
    expect(out).not.toContainEqual(routed[0]);
    expect(out).not.toContainEqual(routed[3]);
  });

  it('removes a loop when the replacement is just start → end (Butte Blue case)', () => {
    // Loop: out to vertex 3, a detour 4..8, back to the same street at 9.
    const loop: LngLat[] = [
      ...line.slice(0, 4),
      [-112.497, 46.002], [-112.495, 46.002], [-112.495, 46.004], [-112.497, 46.004], [-112.497, 46.00001],
      ...line.slice(4),
    ];
    const out = spliceSegment(loop, 3, 9, [loop[3], loop[9]]);
    expect(out).toEqual(line);
  });
});
