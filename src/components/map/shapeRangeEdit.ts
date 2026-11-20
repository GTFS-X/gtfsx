// Pure helpers behind the shape editor's range selection, select-priority hit
// testing, and "Redraw segment" splice. Kept free of mapbox-gl-draw so they are
// unit-testable; shapeEditMode.ts wires them into the draw mode.

export type LngLat = [number, number];
export interface Pixel { x: number; y: number }

/**
 * A press within this many screen pixels of an existing vertex SELECTS that
 * vertex instead of inserting a new one at a midpoint. mapbox-gl-draw's own
 * hit test returns whichever supplementary point the renderer lists first
 * (vertices and midpoints share no id, so its de-dup keeps just one), which in
 * a dense cluster is usually a midpoint — every click there added a vertex.
 */
export const SELECT_PRIORITY_RADIUS_PX = 8;

/** Two presses this close (px) count as "the same spot" for cycling. */
export const CYCLE_SAME_SPOT_PX = 4;

/** Every vertex index from a to b inclusive, ascending (either order in). */
export function rangeIndices(a: number, b: number): number[] {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const out: number[] = [];
  for (let i = lo; i <= hi; i++) out.push(i);
  return out;
}

/** Vertex indices within `radius` px of `click`, nearest first. */
export function vertexCandidates(pixels: Pixel[], click: Pixel, radius = SELECT_PRIORITY_RADIUS_PX): number[] {
  const r2 = radius * radius;
  const hits: { i: number; d2: number }[] = [];
  for (let i = 0; i < pixels.length; i++) {
    const dx = pixels[i].x - click.x;
    const dy = pixels[i].y - click.y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= r2) hits.push({ i, d2 });
  }
  hits.sort((a, b) => a.d2 - b.d2 || a.i - b.i);
  return hits.map((h) => h.i);
}

/**
 * Which overlapping vertex a press picks. Normally the nearest. Pressing the
 * same spot again steps to the next candidate, so a vertex hidden under
 * another leg of the shape (the Butte Blue loop sits 0.5–7 m from the street
 * it doubles back along) is still reachable without zooming to street level.
 */
export function chooseCandidate(
  candidates: number[],
  click: Pixel,
  last: { at: Pixel; chosen: number } | null,
): number | null {
  if (candidates.length === 0) return null;
  if (last && candidates.length > 1) {
    const dx = last.at.x - click.x;
    const dy = last.at.y - click.y;
    if (dx * dx + dy * dy <= CYCLE_SAME_SPOT_PX * CYCLE_SAME_SPOT_PX) {
      const k = candidates.indexOf(last.chosen);
      if (k !== -1) return candidates[(k + 1) % candidates.length];
    }
  }
  return candidates[0];
}

/** True when the sorted indices are one unbroken run. */
export function isContiguous(sorted: number[]): boolean {
  for (let i = 1; i < sorted.length; i++) if (sorted[i] !== sorted[i - 1] + 1) return false;
  return sorted.length > 0;
}

/** Remove the vertices at `indices`; refuses (returns null) if fewer than two would remain. */
export function removeVertices<T>(coords: T[], indices: number[]): T[] | null {
  const drop = new Set(indices);
  const kept = coords.filter((_, i) => !drop.has(i));
  return kept.length >= 2 ? kept : null;
}

function metersBetween(a: LngLat, b: LngLat): number {
  const R = 6371008.8;
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

/**
 * Replace the vertices strictly between `startIdx` and `endIdx` with `path`
 * (which runs from the start vertex to the end vertex). The start and end
 * vertices themselves are kept, so the shape stays joined to its unedited
 * parts. A routed path begins and ends on the road nearest each vertex; those
 * end points are dropped when they're within `joinToleranceM` of the vertex so
 * the splice doesn't leave a metre-long jog. Consecutive duplicates are removed.
 */
export function spliceSegment(
  coords: LngLat[],
  startIdx: number,
  endIdx: number,
  path: LngLat[],
  joinToleranceM = 15,
): LngLat[] {
  const s = Math.min(startIdx, endIdx);
  const e = Math.max(startIdx, endIdx);
  // A path drawn end→start when the range was picked backwards is reversed
  // by the caller; here it always runs coords[s] → coords[e].
  let inner = path.slice();
  if (inner.length > 0 && metersBetween(inner[0], coords[s]) <= joinToleranceM) inner = inner.slice(1);
  if (inner.length > 0 && metersBetween(inner[inner.length - 1], coords[e]) <= joinToleranceM) inner = inner.slice(0, -1);
  const out = [...coords.slice(0, s + 1), ...inner, ...coords.slice(e)];
  return out.filter((c, i) => i === 0 || c[0] !== out[i - 1][0] || c[1] !== out[i - 1][1]);
}
