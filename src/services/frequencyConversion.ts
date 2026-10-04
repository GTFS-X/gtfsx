// Frequency → trips converter (issue #65). Materializes a frequency-based
// template's build-out into REAL, individually-editable trips: every projected
// departure the timetable grid shows becomes a trip, the frequencies rows for
// that template are dropped, and the template trip itself STAYS (it's the trip
// at its own departure time — never duplicated; a template off the window grid
// is re-timed onto the first departure, see retimedTemplateStopTimes). Net: the grid rows look
// identical afterwards, but every row is now a real trip, so blocking, per-trip
// editing, and the (trip-only) cost engine all apply.
//
// Pure: computes the new trips + stop_times + which templates to unlink, with no
// store access. `expandFrequencyTrip` (the SAME expansion the grid + Marey view
// render, including its skip-the-template's-own-departure rule) is the single
// source of the departure set; `mintTripId`/`tripIdPrefixForRoute` mint the
// pithy ids. Reuses both — no new expansion or naming math here.

import type { Frequency, Route, StopTime, Trip } from '../types/gtfs';
import { expandFrequencyTrip, windowDepartureCount, type FrequencyWindow } from './frequencyExpansion';
import { mintTripIds, tripIdPrefixForRoute } from './tripNaming';

export interface ConversionInput {
  /** Template trip_ids to convert. Ids without frequency windows (or without a
   *  trip row) are silently skipped, so callers can pass a whole service scope. */
  templateTripIds: string[];
  trips: Trip[];
  stopTimes: StopTime[];
  frequencies: Frequency[];
  routes: Route[];
}

/** Per-template accounting, for the confirm dialog's honest counts. */
export interface TemplateConversion {
  templateTripId: string;
  /** How many NEW trips this template mints (the build-out MINUS the surviving
   *  template row). */
  newTripCount: number;
  /** Resulting real trips for this template = newTripCount + 1 (the template)
   *  = the number of departures its windows define. */
  totalTripCount: number;
  /** True when the template was off the window grid and is re-timed onto the
   *  first departure (see ConversionResult.retimedTemplateStopTimes). */
  retimed: boolean;
  /** True when any window is exact_times ≠ 1 — converting turns an "approximate
   *  every N" promise into exact scheduled times (the dialog says so). */
  approximate: boolean;
}

export interface ConversionResult {
  /** Real trips to ADD to the feed (one per projected departure). */
  newTrips: Trip[];
  /** Stop_times for the new trips (template's, shifted onto each departure). */
  newStopTimes: StopTime[];
  /**
   * Replacement stop_times for templates that sat off their windows' grid
   * (same trip_id / stop_sequence / stop_id as the template's rows, times
   * shifted onto the first departure). The consumer MUST apply these — replace
   * each matching (trip_id, stop_sequence) row — or the template stays at its
   * old time.
   */
  retimedTemplateStopTimes: StopTime[];
  /** Templates whose frequencies rows should be removed (only those actually
   *  converted — i.e. that had ≥1 window and a trip row). */
  removedTemplateIds: string[];
  perTemplate: TemplateConversion[];
  /** Grand totals across every converted template. */
  totalNewTrips: number;
  totalResultTrips: number;
  anyApproximate: boolean;
}

function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = m.get(k);
    if (arr) arr.push(it); else m.set(k, [it]);
  }
  return m;
}

/**
 * Compute the conversion for a set of frequency templates. Deterministic for a
 * given feed state. Nothing is minted for a template that has no frequency
 * windows or no trip row (it's dropped from the result), so `removedTemplateIds`
 * is exactly the set that will actually change.
 */
export function computeFrequencyConversion(input: ConversionInput): ConversionResult {
  const { templateTripIds, trips, stopTimes, frequencies, routes } = input;

  const freqByTrip = groupBy(frequencies, (f) => f.trip_id);
  const stopsByTrip = groupBy(stopTimes, (st) => st.trip_id);
  const tripById = new Map(trips.map((t) => [t.trip_id, t]));
  const routeById = new Map(routes.map((r) => [r.route_id, r]));

  // Mint against every id that will EXIST after the convert — the untouched
  // trips plus the surviving templates — and against ids minted earlier in this
  // same batch, so a multi-template convert never collides.
  const existing = new Set(trips.map((t) => t.trip_id));

  const newTrips: Trip[] = [];
  const newStopTimes: StopTime[] = [];
  const retimedTemplateStopTimes: StopTime[] = [];
  const removedTemplateIds: string[] = [];
  const perTemplate: TemplateConversion[] = [];
  let anyApproximate = false;

  // De-dupe the input ids but keep their order stable.
  const seen = new Set<string>();
  for (const tripId of templateTripIds) {
    if (seen.has(tripId)) continue;
    seen.add(tripId);

    const rawWindows = freqByTrip.get(tripId);
    const template = tripById.get(tripId);
    if (!rawWindows || rawWindows.length === 0 || !template) continue;

    const windows: FrequencyWindow[] = rawWindows.map((f) => ({
      start_time: f.start_time, end_time: f.end_time, headway_secs: f.headway_secs, exact_times: f.exact_times,
    }));
    const templateStops = stopsByTrip.get(tripId) ?? [];
    const projections = expandFrequencyTrip(tripId, templateStops, windows);

    // expandFrequencyTrip skips the departure that coincides with the
    // template's own start. When NOTHING was skipped, the template sits off
    // every window's grid (e.g. an imported 00:00 template under a 06:00–07:00
    // window): keeping it as-is would add a phantom trip at its own time. So
    // the template takes over the FIRST projected departure (its stop_times
    // are re-timed onto it) and only the rest are minted.
    const windowCount = windowDepartureCount(windows);
    const offGrid = projections.length > 0 && projections.length === windowCount;
    const toMint = offGrid ? projections.slice(1) : projections;
    if (offGrid) {
      for (const st of projections[0].stopTimes) retimedTemplateStopTimes.push({ ...st, trip_id: tripId });
    }

    const prefix = tripIdPrefixForRoute(routeById.get(template.route_id));
    const ids = mintTripIds(prefix, toMint.length, existing);
    for (const id of ids) existing.add(id); // so the next template mints past these

    toMint.forEach((proj, i) => {
      const newId = ids[i];
      // Carry over route/direction/shape/service/headsign/accessibility from the
      // template. Two fields are deliberately NOT carried:
      //  - trip_short_name: a per-departure public id (e.g. a train number);
      //    copying one onto every materialized trip would duplicate it.
      //  - block_id: a frequency template stands in for many concurrent
      //    departures, so it has no single vehicle. Carrying a stray block_id
      //    would drop every new trip onto one block and flag them all as
      //    overlaps; instead they start unassigned, ready to block.
      newTrips.push({ ...template, trip_id: newId, trip_short_name: undefined, block_id: undefined });
      for (const st of proj.stopTimes) newStopTimes.push({ ...st, trip_id: newId });
    });

    const approximate = windows.some((w) => (w.exact_times ?? 0) !== 1);
    if (approximate) anyApproximate = true;
    removedTemplateIds.push(tripId);
    perTemplate.push({
      templateTripId: tripId,
      newTripCount: toMint.length,
      totalTripCount: toMint.length + 1,
      approximate,
      retimed: offGrid,
    });
  }

  return {
    newTrips,
    newStopTimes,
    retimedTemplateStopTimes,
    removedTemplateIds,
    perTemplate,
    totalNewTrips: newTrips.length,
    totalResultTrips: perTemplate.reduce((n, p) => n + p.totalTripCount, 0),
    anyApproximate,
  };
}
