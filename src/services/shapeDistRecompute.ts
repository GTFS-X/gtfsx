// Keep shape_dist_traveled honest after a shape's geometry changes.
//
// WHY: imported feeds carry shapes.shape_dist_traveled AND
// stop_times.shape_dist_traveled. Consumers place a stop on its shape by
// walking the shape's distance column to the stop's distance, so when a shape
// is edited (vertices dragged, a branch extended, a loop removed) every stop
// distance downstream of the edit points at the wrong place on the new line.
// The Butte-Silver Bow Orange extension left 11 stops ~1 km off in apps and
// added 11 `stop_too_far_from_shape_using_user_distance` validator warnings.
//
// This module is PURE (plain arrays, no store, no Vite-only imports) so the
// validator, the store action and the tsx editor-test harness can all use it.
//
// Units: GTFS leaves the unit of shape_dist_traveled to the producer (it only
// has to be consistent between shapes.txt and stop_times.txt). We detect it
// from the values a feed already has (metres, kilometres, feet, miles) by the
// ratio of the stored distance to the measured geodesic length, and write new
// values in the same unit. With nothing to go on we default to metres, which
// is what the importer and every GTFS·X-drawn shape already use.

import type { ShapePoint } from '../types/gtfs';

export type LngLat = [number, number];

/** Units of shape_dist_traveled we recognise, as "units per metre". */
export const DIST_UNIT_FACTORS = {
  m: 1,
  km: 0.001,
  ft: 3.280839895,
  mi: 0.000621371192,
} as const;
export type DistUnit = keyof typeof DIST_UNIT_FACTORS;

/** Same earth radius turf uses, so our lengths match fillShapeDistances. */
const EARTH_RADIUS_M = 6371008.8;
const DEG = Math.PI / 180;

/** Haversine distance between two [lng, lat] points, in metres. */
export function haversineMeters(a: LngLat, b: LngLat): number {
  const dLat = (b[1] - a[1]) * DEG;
  const dLon = (b[0] - a[0]) * DEG;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(a[1] * DEG) * Math.cos(b[1] * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

/** Cumulative geodesic distance (metres) at each vertex. cum[0] = 0. */
export function cumulativeMeters(coords: LngLat[]): number[] {
  const cum = new Array<number>(coords.length);
  if (coords.length === 0) return cum;
  cum[0] = 0;
  for (let i = 1; i < coords.length; i++) cum[i] = cum[i - 1] + haversineMeters(coords[i - 1], coords[i]);
  return cum;
}

/** Shape points (in sequence order) as [lng, lat]. */
export function shapeCoords(points: ShapePoint[]): LngLat[] {
  return [...points]
    .sort((a, b) => a.shape_pt_sequence - b.shape_pt_sequence)
    .map((p) => [p.shape_pt_lon, p.shape_pt_lat] as LngLat);
}

/**
 * Snap a measured "stored units per metre" ratio to a known unit. Matching is
 * in log space with a ±35% window: wide enough to absorb a shape that was
 * lengthened or shortened by an edit since its distances were written, and
 * still far from the next unit (metres and feet are 3.28x apart).
 */
export function snapUnit(ratio: number): DistUnit | null {
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  let best: DistUnit | null = null;
  let bestErr = Infinity;
  for (const [unit, factor] of Object.entries(DIST_UNIT_FACTORS) as [DistUnit, number][]) {
    const err = Math.abs(Math.log(ratio / factor));
    if (err < bestErr) { bestErr = err; best = unit; }
  }
  return bestErr <= Math.log(1.35) ? best : null;
}

/** Median of (stored / metres) over the pairs, snapped to a unit. Pairs whose
 *  metre length is tiny are ignored (ratio noise). */
export function detectUnitFromPairs(pairs: Array<[stored: number, meters: number]>): DistUnit | null {
  const ratios = pairs
    .filter(([s, m]) => Number.isFinite(s) && s > 0 && m > 50)
    .map(([s, m]) => s / m)
    .sort((a, b) => a - b);
  if (ratios.length === 0) return null;
  return snapUnit(ratios[Math.floor(ratios.length / 2)]);
}

/** True when a shape carries real (not all-zero) distances. */
export function hasRealShapeDistances(points: ShapePoint[]): boolean {
  return points.some((p) => p.shape_dist_traveled !== 0 && Number.isFinite(p.shape_dist_traveled));
}

/** Unit of a shape's OWN stored distances, judged against its own geometry. */
export function detectShapeUnit(points: ShapePoint[]): DistUnit | null {
  if (points.length < 2 || !hasRealShapeDistances(points)) return null;
  const ordered = [...points].sort((a, b) => a.shape_pt_sequence - b.shape_pt_sequence);
  const cum = cumulativeMeters(ordered.map((p) => [p.shape_pt_lon, p.shape_pt_lat] as LngLat));
  const stored = ordered[ordered.length - 1].shape_dist_traveled - ordered[0].shape_dist_traveled;
  return detectUnitFromPairs([[stored, cum[cum.length - 1]]]);
}

// ─── Projection ──────────────────────────────────────────────────────────────

/** A stop further than this from its shape can't be placed meaningfully. */
export const MAX_STOP_OFFSET_M = 1000;
/** A pass of the shape is a candidate for a stop if it is within this much of
 *  the closest pass (or twice the closest distance, whichever is larger). */
const CANDIDATE_SLACK_M = 150;
const MAX_CANDIDATES = 16;

interface Candidate {
  /** Distance along the shape, metres. */
  along: number;
  /** Perpendicular distance from the stop to this pass, metres. */
  offset: number;
}

/** Closest point on segment a→b to p, using a local equirectangular frame
 *  (metres). Accurate to well under a metre at transit-segment scale. */
function projectOnSegment(p: LngLat, a: LngLat, b: LngLat): { t: number; offset: number } {
  const kx = Math.cos(a[1] * DEG) * DEG * EARTH_RADIUS_M;
  const ky = DEG * EARTH_RADIUS_M;
  const bx = (b[0] - a[0]) * kx;
  const by = (b[1] - a[1]) * ky;
  const px = (p[0] - a[0]) * kx;
  const py = (p[1] - a[1]) * ky;
  const len2 = bx * bx + by * by;
  let t = len2 > 0 ? (px * bx + py * by) / len2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const dx = px - t * bx;
  const dy = py - t * by;
  return { t, offset: Math.sqrt(dx * dx + dy * dy) };
}

/** Distance (metres) from p to the nearest point of the polyline. */
export function offsetFromLine(p: LngLat, coords: LngLat[]): number {
  let best = Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    const r = projectOnSegment(p, coords[i], coords[i + 1]);
    if (r.offset < best) best = r.offset;
  }
  return best;
}

/**
 * Every distinct pass of the shape near `p`: the local minima of the
 * stop-to-segment distance along the shape, kept when they're within the
 * slack of the closest one. A loop or out-and-back that passes the stop twice
 * yields two candidates; the sequence solver picks between them.
 */
function candidatesFor(p: LngLat, coords: LngLat[], cum: number[]): Candidate[] {
  const n = coords.length - 1;
  if (n < 1) return [];
  const t = new Array<number>(n);
  const d = new Array<number>(n);
  let minD = Infinity;
  for (let i = 0; i < n; i++) {
    const r = projectOnSegment(p, coords[i], coords[i + 1]);
    t[i] = r.t;
    d[i] = r.offset;
    if (r.offset < minD) minD = r.offset;
  }
  const limit = Math.max(minD * 2, minD + CANDIDATE_SLACK_M);
  const out: Candidate[] = [];
  let lastAccepted = -2;
  for (let i = 0; i < n; i++) {
    if (d[i] > limit) continue;
    const leftOk = i === 0 || d[i] <= d[i - 1];
    const rightOk = i === n - 1 || d[i] <= d[i + 1];
    if (!leftOk || !rightOk) continue;
    // A plateau of equal distances (e.g. a stop dead on a shared vertex)
    // is one pass, not several.
    if (lastAccepted === i - 1 && d[i] === d[i - 1]) { lastAccepted = i; continue; }
    const along = cum[i] + t[i] * (cum[i + 1] - cum[i]);
    const prev = out[out.length - 1];
    if (prev && along - prev.along < 1) {
      if (d[i] < prev.offset) { prev.offset = d[i]; prev.along = along; }
    } else {
      out.push({ along, offset: d[i] });
    }
    lastAccepted = i;
  }
  if (out.length <= MAX_CANDIDATES) return out;
  return out.sort((a, b) => a.offset - b.offset).slice(0, MAX_CANDIDATES).sort((a, b) => a.along - b.along);
}

export type ProjectionResult =
  | { ok: true; along: number[]; maxOffset: number }
  | { ok: false; reason: string };

/**
 * Place each stop on the shape, in stop order, so that distances never go
 * backwards: dynamic programming over each stop's candidate passes, choosing
 * the non-decreasing assignment with the least total stop-to-shape offset.
 *
 * Greedy nearest-point fails exactly where it matters: a stop on an
 * out-and-back street is about equally close to both legs, and picking the
 * return leg too early strands every later stop. The DP sees the whole trip,
 * so the first and last stop of a loop that starts and ends at the same place
 * land at 0 and at the shape's end, and a stop passed twice gets the pass that
 * fits the sequence.
 *
 * Returns along-shape distances in METRES. Fails (ok:false) when a stop has no
 * coordinates, sits more than MAX_STOP_OFFSET_M off the shape, or no
 * monotonic assignment exists.
 */
export function projectStopsOntoShape(coords: LngLat[], stops: Array<LngLat | null>, cum = cumulativeMeters(coords)): ProjectionResult {
  if (coords.length < 2) return { ok: false, reason: 'shape has fewer than two points' };
  if (stops.length === 0) return { ok: true, along: [], maxOffset: 0 };
  const cands: Candidate[][] = [];
  for (let s = 0; s < stops.length; s++) {
    const p = stops[s];
    if (!p) return { ok: false, reason: `stop ${s + 1} has no coordinates` };
    const c = candidatesFor(p, coords, cum).sort((a, b) => a.along - b.along);
    if (c.length === 0) return { ok: false, reason: `stop ${s + 1} could not be projected` };
    cands.push(c);
  }
  // cost[s][j] = least total offset placing stops 0..s with stop s at cands[s][j].
  const EPS = 1e-6;
  let prevCost = cands[0].map((c) => c.offset);
  const back: number[][] = [cands[0].map(() => -1)];
  for (let s = 1; s < stops.length; s++) {
    const cur = cands[s];
    const prev = cands[s - 1];
    const cost = new Array<number>(cur.length).fill(Infinity);
    const from = new Array<number>(cur.length).fill(-1);
    for (let j = 0; j < cur.length; j++) {
      for (let i = 0; i < prev.length; i++) {
        if (prev[i].along > cur[j].along + EPS) continue;
        const c = prevCost[i] + cur[j].offset;
        if (c < cost[j] - EPS) { cost[j] = c; from[j] = i; }
      }
    }
    back.push(from);
    prevCost = cost;
  }
  let bestJ = -1;
  let best = Infinity;
  for (let j = 0; j < prevCost.length; j++) {
    if (prevCost[j] < best - EPS) { best = prevCost[j]; bestJ = j; }
  }
  if (bestJ === -1 || !Number.isFinite(best)) return { ok: false, reason: 'no forward-only placement of the stops fits this shape' };
  const along = new Array<number>(stops.length);
  let maxOffset = 0;
  let j = bestJ;
  for (let s = stops.length - 1; s >= 0; s--) {
    const c = cands[s][j];
    along[s] = c.along;
    if (c.offset > maxOffset) maxOffset = c.offset;
    j = back[s][j];
  }
  if (maxOffset > MAX_STOP_OFFSET_M) {
    return { ok: false, reason: `a stop is ${Math.round(maxOffset)} m from the shape` };
  }
  return { ok: true, along, maxOffset };
}

/**
 * Convert metres to the feed's unit and make the sequence STRICTLY increasing
 * (MobilityData errors on equal consecutive stop distances, which a stop listed
 * twice in a row would otherwise produce). The nudge is a millimetre-equivalent.
 */
export function toFeedDistances(alongMeters: number[], unit: DistUnit): number[] {
  const f = DIST_UNIT_FACTORS[unit];
  const step = 0.001 * f;
  const out = alongMeters.map((m) => m * f);
  for (let i = 1; i < out.length; i++) {
    if (out[i] <= out[i - 1]) out[i] = out[i - 1] + step;
  }
  return out;
}

/**
 * Locate the point at stored distance `dist` along a shape, by interpolating
 * the shape's own shape_dist_traveled column — exactly what a consumer does.
 * Points must be in sequence order. Returns null when the shape has no usable
 * distances.
 */
export function pointAtShapeDistance(ordered: ShapePoint[], dist: number): LngLat | null {
  const n = ordered.length;
  if (n < 2) return null;
  if (dist <= ordered[0].shape_dist_traveled) return [ordered[0].shape_pt_lon, ordered[0].shape_pt_lat];
  if (dist >= ordered[n - 1].shape_dist_traveled) return [ordered[n - 1].shape_pt_lon, ordered[n - 1].shape_pt_lat];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ordered[mid].shape_dist_traveled <= dist) lo = mid; else hi = mid;
  }
  const a = ordered[lo];
  const b = ordered[hi];
  const span = b.shape_dist_traveled - a.shape_dist_traveled;
  const t = span > 0 ? (dist - a.shape_dist_traveled) / span : 0;
  return [a.shape_pt_lon + t * (b.shape_pt_lon - a.shape_pt_lon), a.shape_pt_lat + t * (b.shape_pt_lat - a.shape_pt_lat)];
}

// ─── Plan a recompute (pure) ─────────────────────────────────────────────────

export interface RecomputeInput {
  shape_id: string;
  /** The shape's points as they are NOW (new geometry; distances may be stale/zero). */
  points: ShapePoint[];
  /** Every shape in the feed — used to detect the unit when this one has none. */
  allShapes: { shape_id: string; points: ShapePoint[] }[];
  /** Trips on this shape. */
  trips: { trip_id: string; shape_id?: string }[];
  /** stop_times rows for those trips (other rows are ignored). */
  stopTimes: { trip_id: string; stop_id: string; stop_sequence: number; shape_dist_traveled?: number }[];
  /** Stop coordinate lookup. */
  stopCoord: (stop_id: string) => LngLat | null;
  /** Unit to use, overriding detection (e.g. the shape's unit captured before the edit). */
  unit?: DistUnit;
  /** Also fill trips that carry no stop distances yet. Default false: a feed
   *  that doesn't publish stop distances keeps not publishing them. */
  fillMissing?: boolean;
}

export interface TripDistanceUpdate {
  trip_id: string;
  /** stop_sequence → new value; undefined means "clear". */
  values: Map<number, number | undefined>;
}

export interface RecomputePlan {
  unit: DistUnit;
  /** New shape_dist_traveled per point, aligned with `points` in sequence order. */
  shapeDistances: number[];
  /** Ordered shape points (sequence order) the distances align with. */
  orderedPoints: ShapePoint[];
  tripUpdates: TripDistanceUpdate[];
  tripsRecomputed: string[];
  tripsCleared: { trip_id: string; reason: string }[];
}

/**
 * Choose the unit for a shape: its own stored distances if they're real;
 * otherwise the feed's other shapes; otherwise its trips' stop distances
 * measured against the projected positions; otherwise metres.
 */
export function chooseUnit(input: RecomputeInput, cum: number[]): DistUnit {
  if (input.unit) return input.unit;
  const own = detectShapeUnit(input.points);
  if (own) return own;
  const otherPairs: Array<[number, number]> = [];
  for (const s of input.allShapes) {
    if (s.shape_id === input.shape_id || s.points.length < 2 || !hasRealShapeDistances(s.points)) continue;
    const ordered = [...s.points].sort((a, b) => a.shape_pt_sequence - b.shape_pt_sequence);
    const c = cumulativeMeters(ordered.map((p) => [p.shape_pt_lon, p.shape_pt_lat] as LngLat));
    otherPairs.push([ordered[ordered.length - 1].shape_dist_traveled - ordered[0].shape_dist_traveled, c[c.length - 1]]);
    if (otherPairs.length >= 25) break;
  }
  const fromOthers = detectUnitFromPairs(otherPairs);
  if (fromOthers) return fromOthers;
  // Stop distances: the largest stored value on each trip vs. the shape length.
  const tripMax = new Map<string, number>();
  for (const st of input.stopTimes) {
    if (st.shape_dist_traveled == null || !Number.isFinite(st.shape_dist_traveled)) continue;
    tripMax.set(st.trip_id, Math.max(tripMax.get(st.trip_id) ?? 0, st.shape_dist_traveled));
  }
  const total = cum[cum.length - 1] ?? 0;
  const fromStops = detectUnitFromPairs([...tripMax.values()].map((v) => [v, total]));
  return fromStops ?? 'm';
}

/** Build the full set of writes for a recompute. Pure. */
export function planShapeDistanceRecompute(input: RecomputeInput): RecomputePlan | null {
  if (input.points.length < 2) return null;
  const orderedPoints = [...input.points].sort((a, b) => a.shape_pt_sequence - b.shape_pt_sequence);
  const coords = orderedPoints.map((p) => [p.shape_pt_lon, p.shape_pt_lat] as LngLat);
  const cum = cumulativeMeters(coords);
  const unit = chooseUnit(input, cum);
  const f = DIST_UNIT_FACTORS[unit];
  const shapeDistances = cum.map((m) => m * f);

  const tripIds = new Set(input.trips.filter((t) => t.shape_id === input.shape_id).map((t) => t.trip_id));
  const rowsByTrip = new Map<string, RecomputeInput['stopTimes']>();
  for (const st of input.stopTimes) {
    if (!tripIds.has(st.trip_id)) continue;
    let rows = rowsByTrip.get(st.trip_id);
    if (!rows) { rows = []; rowsByTrip.set(st.trip_id, rows); }
    rows.push(st);
  }

  // Trips sharing a stop pattern share a projection.
  const cache = new Map<string, ProjectionResult>();
  const tripUpdates: TripDistanceUpdate[] = [];
  const tripsRecomputed: string[] = [];
  const tripsCleared: { trip_id: string; reason: string }[] = [];
  for (const [tripId, rawRows] of rowsByTrip) {
    const rows = [...rawRows].sort((a, b) => a.stop_sequence - b.stop_sequence);
    const hasAny = rows.some((r) => r.shape_dist_traveled != null && Number.isFinite(r.shape_dist_traveled));
    if (!hasAny && !input.fillMissing) continue;
    const key = rows.map((r) => r.stop_id).join('\u0001');
    let proj = cache.get(key);
    if (!proj) {
      proj = projectStopsOntoShape(coords, rows.map((r) => input.stopCoord(r.stop_id)), cum);
      cache.set(key, proj);
    }
    const values = new Map<number, number | undefined>();
    if (proj.ok) {
      const feed = toFeedDistances(proj.along, unit);
      rows.forEach((r, i) => values.set(r.stop_sequence, feed[i]));
      tripsRecomputed.push(tripId);
    } else {
      rows.forEach((r) => values.set(r.stop_sequence, undefined));
      tripsCleared.push({ trip_id: tripId, reason: proj.reason });
    }
    tripUpdates.push({ trip_id: tripId, values });
  }
  return { unit, shapeDistances, orderedPoints, tripUpdates, tripsRecomputed, tripsCleared };
}

// ─── Stale-distance detection (validator) ────────────────────────────────────

export interface StaleStopDistanceFinding {
  shape_id: string;
  /** Trips on this shape with at least one misplaced stop distance. */
  tripIds: string[];
  /** Distinct (stop) placements that are off. */
  stopCount: number;
  /** Worst gap between a stop and where its distance puts it, metres. */
  worstMeters: number;
}

/** A stop whose distance puts it further than this from where it is gets flagged. */
export const STALE_STOP_DISTANCE_M = 100;

/**
 * Shapes whose trips' stop_times.shape_dist_traveled no longer point at the
 * stops: interpolating the shape's own distance column at the stop's distance
 * lands more than STALE_STOP_DISTANCE_M from the stop (and meaningfully further
 * than the stop is from the shape at all, so a stop that is simply off-route
 * is left to `stop_too_far_from_shape`). That's the consumer's view of the
 * feed (MobilityData `stop_too_far_from_shape_using_user_distance`).
 */
export function findStaleStopDistances(
  shapes: { shape_id: string; points: ShapePoint[] }[],
  trips: { trip_id: string; shape_id?: string }[],
  stopTimes: { trip_id: string; stop_id: string; stop_sequence: number; shape_dist_traveled?: number }[],
  stopCoord: (stop_id: string) => LngLat | null,
): StaleStopDistanceFinding[] {
  const shapeById = new Map<string, ShapePoint[]>();
  for (const s of shapes) {
    if (s.points.length >= 2 && hasRealShapeDistances(s.points)) shapeById.set(s.shape_id, s.points);
  }
  if (shapeById.size === 0) return [];
  const tripShape = new Map<string, string>();
  for (const t of trips) if (t.shape_id && shapeById.has(t.shape_id)) tripShape.set(t.trip_id, t.shape_id);
  if (tripShape.size === 0) return [];

  const ordered = new Map<string, ShapePoint[]>();
  const geom = new Map<string, { coords: LngLat[] }>();
  const orderedFor = (id: string) => {
    let o = ordered.get(id);
    if (!o) { o = [...shapeById.get(id)!].sort((a, b) => a.shape_pt_sequence - b.shape_pt_sequence); ordered.set(id, o); }
    return o;
  };
  const geomFor = (id: string) => {
    let g = geom.get(id);
    if (!g) { g = { coords: orderedFor(id).map((p) => [p.shape_pt_lon, p.shape_pt_lat] as LngLat) }; geom.set(id, g); }
    return g;
  };

  const byShape = new Map<string, { trips: Set<string>; stops: Set<string>; worst: number }>();
  // (shape, stop, value) → verdict, so the many trips sharing a pattern cost one check.
  const verdict = new Map<string, number>();
  for (const st of stopTimes) {
    if (st.shape_dist_traveled == null || !Number.isFinite(st.shape_dist_traveled)) continue;
    const shapeId = tripShape.get(st.trip_id);
    if (!shapeId) continue;
    const key = `${shapeId}\u0001${st.stop_id}\u0001${st.shape_dist_traveled}`;
    let gap = verdict.get(key);
    if (gap === undefined) {
      gap = 0;
      const p = stopCoord(st.stop_id);
      const at = p ? pointAtShapeDistance(orderedFor(shapeId), st.shape_dist_traveled) : null;
      if (p && at) {
        const d = haversineMeters(p, at);
        if (d > STALE_STOP_DISTANCE_M) {
          if (d > offsetFromLine(p, geomFor(shapeId).coords) + 50) gap = d;
        }
      }
      verdict.set(key, gap);
    }
    if (gap > 0) {
      let agg = byShape.get(shapeId);
      if (!agg) { agg = { trips: new Set(), stops: new Set(), worst: 0 }; byShape.set(shapeId, agg); }
      agg.trips.add(st.trip_id);
      agg.stops.add(st.stop_id);
      if (gap > agg.worst) agg.worst = gap;
    }
  }
  return [...byShape.entries()].map(([shape_id, a]) => ({
    shape_id, tripIds: [...a.trips], stopCount: a.stops.size, worstMeters: a.worst,
  }));
}
