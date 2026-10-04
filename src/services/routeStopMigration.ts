import type { RouteStop, StopTime, Trip } from '../types/gtfs';

/**
 * The stop_sequence for a stop APPENDED to a pattern: one past the highest
 * sequence already in it (0 for an empty pattern).
 *
 * Never use the pattern's stop COUNT for this. The timetable keys every cell by
 * (trip_id, stop_sequence), and count only equals "next free sequence" when the
 * pattern is numbered 0..n-1 with no gaps. An imported feed keeps its own
 * numbering (GTFS usually starts at 1) and removing a stop leaves a gap, so the
 * count lands ON an existing stop: the two columns then share one stop_times
 * row and editing either cell changes both (forum report 2026-10-04). On a
 * sparse pattern (10, 20, 30) the count also sorts the "appended" stop first.
 */
export function nextRouteStopSequence(pattern: readonly { stop_sequence: number }[]): number {
  let max = -1;
  for (const rs of pattern) if (rs.stop_sequence > max) max = rs.stop_sequence;
  return max + 1;
}

/** Whether two route stops belong to the same pattern — the grouping every
 *  route_stop mutation uses (per shape when tagged, else per direction). */
export function sameRouteStopPattern(
  rs: Pick<RouteStop, 'route_id' | 'direction_id' | 'shape_id'>,
  of: Pick<RouteStop, 'route_id' | 'direction_id' | 'shape_id'>,
): boolean {
  return rs.route_id === of.route_id
    && (of.shape_id ? rs.shape_id === of.shape_id : rs.direction_id === of.direction_id);
}

/**
 * Give every route stop in a pattern its own stop_sequence.
 *
 * Feeds saved by the old count-as-sequence append (see nextRouteStopSequence)
 * can hold two route stops at the same sequence in one pattern. Their timetable
 * columns share a stop_times row, so the pair edits together. Each later
 * duplicate (array order — the append pushed it last) moves to one past the
 * pattern's highest sequence, i.e. to the end, where the append meant to put it.
 *
 * stop_times are only MOVED, never invented: a trip's row at the shared
 * sequence that names the moved stop (and not the stop staying put) follows it
 * to the new sequence. Otherwise the moved stop shows as skipped on that trip
 * (one click to serve it). So the exported feed is unchanged except for rows
 * that were already attributed to the moved stop.
 *
 * Returns both inputs by reference when there's nothing to repair.
 */
export function dedupeRouteStopSequences(
  routeStops: RouteStop[],
  trips: Trip[],
  stopTimes: StopTime[],
): { routeStops: RouteStop[]; stopTimes: StopTime[] } {
  const patternKey = (rs: RouteStop) =>
    rs.shape_id ? `${rs.route_id}|s|${rs.shape_id}` : `${rs.route_id}|d|${rs.direction_id}`;

  // Pass 1: max sequence per pattern, so a moved stop lands past all of them.
  const maxSeq = new Map<string, number>();
  for (const rs of routeStops) {
    const k = patternKey(rs);
    maxSeq.set(k, Math.max(maxSeq.get(k) ?? -1, rs.stop_sequence));
  }

  // Pass 2: first holder of a sequence keeps it; later ones move to the end.
  const holder = new Map<string, RouteStop>(); // `${pattern}#${seq}` → keeper
  const moves: { moved: RouteStop; kept: RouteStop; from: number; to: number }[] = [];
  const out = routeStops.map((rs) => {
    const k = patternKey(rs);
    const slot = `${k}#${rs.stop_sequence}`;
    const kept = holder.get(slot);
    if (!kept) { holder.set(slot, rs); return rs; }
    const to = maxSeq.get(k)! + 1;
    maxSeq.set(k, to);
    const moved = { ...rs, stop_sequence: to };
    holder.set(`${k}#${to}`, moved);
    moves.push({ moved, kept, from: rs.stop_sequence, to });
    return moved;
  });
  if (moves.length === 0) return { routeStops, stopTimes };

  // Re-home stop_times that name the moved stop. Copy-on-write per row.
  let timesOut = stopTimes;
  for (const { moved, kept, from, to } of moves) {
    if (moved.stop_id === kept.stop_id) continue; // can't tell whose row it is — leave it with the keeper
    const tripIds = new Set(trips.filter((t) => sameRouteStopPattern(
      { route_id: t.route_id, direction_id: t.direction_id, shape_id: t.shape_id }, moved,
    )).map((t) => t.trip_id));
    if (tripIds.size === 0) continue;
    const hit = (st: StopTime) => tripIds.has(st.trip_id) && st.stop_sequence === from && st.stop_id === moved.stop_id;
    if (!timesOut.some(hit)) continue;
    timesOut = timesOut.map((st) => (hit(st) ? { ...st, stop_sequence: to } : st));
  }
  return { routeStops: out, stopTimes: timesOut };
}

/**
 * Backfill `shape_id` on route stops saved before stops were keyed per shape.
 *
 * Today's per-shape work made the timetable and stops panel filter route stops
 * strictly on `rs.shape_id === <selected shape>`. Feeds saved before that change
 * have route stops with no `shape_id`, so those views find none and show
 * "Add stops to this route first" even though the stops are still there.
 *
 * Assign each shape-less stop the first `shape_id` used by a trip on its
 * (route_id, direction_id) — the representative shape for that direction, which
 * is what legacy single-shape-per-direction feeds expect. Stops that already
 * carry a shape_id, and feeds whose trips have no shapes, pass through unchanged.
 *
 * Run on EVERY load path (local IndexedDB draft AND server working state) so the
 * two can't drift apart — the original bug was the server loader missing this.
 */
export function backfillRouteStopShapeIds(routeStops: RouteStop[], trips: Trip[]): RouteStop[] {
  // Fast path: nothing to migrate (new feeds — every stop already keyed).
  if (routeStops.length === 0 || routeStops.every((rs) => rs.shape_id)) return routeStops;

  const shapeForRouteDir = new Map<string, string>();
  for (const t of trips) {
    if (!t.shape_id) continue;
    const k = `${t.route_id}|${t.direction_id}`;
    if (!shapeForRouteDir.has(k)) shapeForRouteDir.set(k, t.shape_id);
  }

  // Only rebuild the array when a stop actually GETS a shape id. A feed whose
  // trips carry no shapes has nothing to assign, and handing back a fresh array
  // of `{...rs, shape_id: undefined}` clones would be both a wasted allocation
  // and — since callers use identity as the "did the migration change
  // anything?" test (see repairRouteStops) — a false "this feed was repaired"
  // signal that marks an untouched project dirty on open.
  let changed = false;
  const migrated = routeStops.map((rs) => {
    if (rs.shape_id) return rs;
    const shape_id = shapeForRouteDir.get(`${rs.route_id}|${rs.direction_id}`);
    if (!shape_id) return rs;
    changed = true;
    return { ...rs, shape_id };
  });
  return changed ? migrated : routeStops;
}

/**
 * Backfill route_stops for stop_times the pattern doesn't cover.
 *
 * A route's stop list is what the timetable builds its COLUMNS from, and it was
 * derived from a single canonical trip per direction (see gtfsParse). When the
 * other trips on that pattern serve MORE stops than the canonical one — a feed
 * whose first trip is a short-turn is enough — their extra stop_times land on
 * stop_sequences with no route_stop. Those rows are then invisible: the grid
 * renders no column for them, and every write path is column-scoped (cell edits,
 * Set run time, Estimate, interpolate, seedTripStops), so a re-time rewrites the
 * covered rows and leaves the uncovered ones at their old values. The trip's
 * STORED times then run backwards while the grid still shows a clean row.
 *
 * Add a route_stop for every (route, direction, sequence) a trip's stop_times
 * reference but the pattern lacks, so the columns cover every stored row.
 *
 * Deliberately CONSERVATIVE — it only extends a pattern that already exists. A
 * (route, direction) with no route_stops at all is left alone: removeRouteStop
 * cascades into stop_times, so an empty stop list is a deliberate state, not a
 * gap to refill. New sequences inherit the shape tag of the pattern they extend
 * so we never invent a second, half-populated pattern for one direction.
 *
 * Run on EVERY load path (local IndexedDB draft AND server working state) plus
 * the importer, so feeds already saved in the broken state self-heal on open.
 */
export function backfillMissingRouteStops(
  routeStops: RouteStop[],
  trips: Trip[],
  stopTimes: StopTime[],
): RouteStop[] {
  if (routeStops.length === 0 || trips.length === 0 || stopTimes.length === 0) return routeStops;

  // Sequences already covered, keyed both per (route, direction, shape) and per
  // (route, direction). A trip is matched against its OWN shape's pattern when
  // that pattern exists, else against the direction's as a whole — legacy
  // route_stops predate per-shape keying and carry no shape_id.
  const byDirShape = new Map<string, Set<number>>();
  const byDir = new Map<string, Set<number>>();
  const shapeOfDir = new Map<string, string | undefined>();
  for (const rs of routeStops) {
    const dirKey = `${rs.route_id}|${rs.direction_id}`;
    const shapeKey = `${dirKey}|${rs.shape_id ?? ''}`;
    if (!byDirShape.has(shapeKey)) byDirShape.set(shapeKey, new Set());
    byDirShape.get(shapeKey)!.add(rs.stop_sequence);
    if (!byDir.has(dirKey)) byDir.set(dirKey, new Set());
    byDir.get(dirKey)!.add(rs.stop_sequence);
    if (!shapeOfDir.has(dirKey)) shapeOfDir.set(dirKey, rs.shape_id);
  }

  const timesByTrip = new Map<string, StopTime[]>();
  for (const st of stopTimes) {
    const arr = timesByTrip.get(st.trip_id);
    if (arr) arr.push(st); else timesByTrip.set(st.trip_id, [st]);
  }

  const added: RouteStop[] = [];
  for (const t of trips) {
    const times = timesByTrip.get(t.trip_id);
    if (!times) continue;
    const dirKey = `${t.route_id}|${t.direction_id}`;
    const own = byDirShape.get(`${dirKey}|${t.shape_id ?? ''}`);
    const covered = own ?? byDir.get(dirKey);
    if (!covered) continue; // no pattern to extend — leave it alone
    // Extending the trip's own pattern keeps that trip's shape; extending the
    // direction's keeps the direction's existing tag, so the added stops stay
    // in the pattern the timetable already filters on.
    const shape_id = own ? t.shape_id : shapeOfDir.get(dirKey);
    for (const st of times) {
      if (covered.has(st.stop_sequence)) continue;
      covered.add(st.stop_sequence);
      added.push({
        route_id: t.route_id,
        stop_id: st.stop_id,
        direction_id: t.direction_id,
        stop_sequence: st.stop_sequence,
        _snapped: true,
        shape_id,
      });
    }
  }

  return added.length === 0 ? routeStops : [...routeStops, ...added];
}

export interface RouteStopRepair {
  routeStops: RouteStop[];
  /** The stop_times to load: the input by reference unless a duplicate-sequence
   *  repair re-homed rows (see dedupeRouteStopSequences). */
  stopTimes: StopTime[];
  /**
   * True when the migrations actually changed the pattern, i.e. what is now in
   * the store no longer matches what was loaded.
   *
   * Load runs inside `loadingFeed()` and ends with `markSaved()`, so without
   * this signal a repair is invisible: the editor reports "Saved", Save stays
   * disabled, and the fix lives only in memory. A server-backed feed then
   * re-serves the broken pattern forever and every session silently re-repairs
   * it — which is exactly how the orphan-stop_times fix looked like it had
   * never shipped. Callers use this to re-mark the project dirty AFTER the
   * load's `markSaved()`, so the user's next Save persists the repair.
   *
   * Both backfills return their input array by reference when there is nothing
   * to do, so identity is an exact "did anything change?" test.
   */
  repaired: boolean;
}

/**
 * Run the route_stop migrations in the canonical order and report whether they
 * changed anything. Every load path (IndexedDB draft, server working state)
 * goes through this so the two can't drift.
 */
export function repairRouteStops(
  routeStops: RouteStop[],
  trips: Trip[],
  stopTimes: StopTime[],
): RouteStopRepair {
  // Shape ids first (dedupe groups by shape), then split shared sequences
  // (backfill must see each stop at its own sequence), then cover orphans.
  const deduped = dedupeRouteStopSequences(
    backfillRouteStopShapeIds(routeStops, trips),
    trips,
    stopTimes,
  );
  const repaired = backfillMissingRouteStops(deduped.routeStops, trips, deduped.stopTimes);
  return {
    routeStops: repaired,
    stopTimes: deduped.stopTimes,
    repaired: repaired !== routeStops || deduped.stopTimes !== stopTimes,
  };
}
