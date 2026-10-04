import type { AppStore } from '../store';
import type { Frequency, StopTime, Trip, Stop } from '../types/gtfs';
import { gtfsTimeToSeconds } from '../utils/time';
import { computeTripSpans, deadheadSecs } from './blockBuilder';
import { activeServiceDates, gtfsDateToDayNumber } from './serviceIds';
import { windowDepartureCount } from './frequencyExpansion';

export interface RouteSpans {
  weeklyRevHours: number;
  weeklyTotalHoursBase: number; // revenue hours (no deadhead applied yet)
  tripsPerWeek: number;
  peakVehicles: number;
  /** Per-service-id breakdown needed for annual cost calculation */
  _serviceBreakdown: {
    serviceId: string;
    revHours: number;
    daysPerWeek: number;
    serviceDaysPerYear: number;
    peak: number;
  }[];
}

export interface RouteStats {
  revenueHoursWeekly: number;
  totalHoursWeekly: number; // revenue hours * deadhead factor
  tripsPerWeek: number;
  peakVehicles: number;
  weeklyCost: number;
  annualCost: number;
}

export interface SystemStats {
  totalRevenueHoursWeekly: number;
  totalHoursWeekly: number;
  totalTripsPerWeek: number;
  /** Sum of each route's individual peak. OVER-counts the real fleet need
   *  because routes peak at different times of day — kept for the CSV/context
   *  only; use `systemPeakVehicles` for "vehicles required for peak service". */
  totalPeakVehicles: number;
  /** TRUE whole-system peak: max vehicles simultaneously in service at the
   *  single busiest instant across the entire system (≤ totalPeakVehicles;
   *  both expand frequencies.txt templates the same way, so this holds). */
  systemPeakVehicles: number;
  totalWeeklyCost: number;
  totalAnnualCost: number;
}

export interface ServiceDayStats {
  /** Typical service days per week. */
  daysPerWeek: number;
  /** Service days per year, annualized over the service's validity span. */
  serviceDaysPerYear: number;
}

/** Fallback for a service_id defined in neither calendar file (an orphan
 *  reference): the historical "runs every day" assumption. */
const UNKNOWN_SERVICE_DAYS: ServiceDayStats = { daysPerWeek: 7, serviceDaysPerYear: 365 };

const serviceDayCache = new WeakMap<object, WeakMap<object, Map<string, ServiceDayStats>>>();

/**
 * Days per week and per year a service runs, from calendar.txt AND
 * calendar_dates.txt (via serviceIds.activeServiceDates).
 *
 *  - A calendar row with at least one weekday flag keeps the historical model:
 *    daysPerWeek = number of flagged weekdays, and per-year = active dates
 *    (weekdays in range, + added dates, − removed dates) annualized over the
 *    span; spans over 2 years use flags × 52.
 *  - A calendar_dates-only service, or a calendar row with every weekday 0,
 *    is measured from its actual active dates: per-year = dates annualized over
 *    the first..last date span, daysPerWeek = dates per week of that span.
 *  - An id defined in neither file falls back to 7 / 365.
 *
 * Annualization (scaling a short season to a full year) is unchanged; see
 * DEFERRED S2-20. Added (exception_type 1) dates outside the calendar range now
 * count, as the spec allows, and the span widens to include them.
 */
export function serviceDayStats(
  serviceId: string,
  state: Pick<AppStore, 'calendars' | 'calendarDates'>,
): ServiceDayStats {
  let byDates = serviceDayCache.get(state.calendars);
  if (!byDates) { byDates = new WeakMap(); serviceDayCache.set(state.calendars, byDates); }
  let cache = byDates.get(state.calendarDates);
  if (!cache) { cache = new Map(); byDates.set(state.calendarDates, cache); }
  const hit = cache.get(serviceId);
  if (hit) return hit;
  const stats = computeServiceDayStats(serviceId, state);
  cache.set(serviceId, stats);
  return stats;
}

function computeServiceDayStats(
  serviceId: string,
  state: Pick<AppStore, 'calendars' | 'calendarDates'>,
): ServiceDayStats {
  const cal = state.calendars.find((c) => c.service_id === serviceId);
  const hasDates = state.calendarDates.some((d) => d.service_id === serviceId);
  if (!cal && !hasDates) return UNKNOWN_SERVICE_DAYS;

  const flagSum = cal
    ? Number(cal.monday) + Number(cal.tuesday) + Number(cal.wednesday) + Number(cal.thursday)
      + Number(cal.friday) + Number(cal.saturday) + Number(cal.sunday)
    : 0;
  const calStart = cal ? gtfsDateToDayNumber(cal.start_date) : Number.NaN;
  const calEnd = cal ? gtfsDateToDayNumber(cal.end_date) : Number.NaN;
  const calSpanValid = Number.isFinite(calStart) && Number.isFinite(calEnd) && calEnd >= calStart;

  if (cal && flagSum > 0) {
    if (!calSpanValid) return { daysPerWeek: flagSum, serviceDaysPerYear: 365 };
    if (calEnd - calStart + 1 > 730) return { daysPerWeek: flagSum, serviceDaysPerYear: flagSum * 52 };
  }

  const dates = activeServiceDates(serviceId, state.calendars, state.calendarDates)
    .map(gtfsDateToDayNumber);
  if (dates.length === 0) {
    return { daysPerWeek: cal && flagSum > 0 ? flagSum : 0, serviceDaysPerYear: 0 };
  }
  let lo = dates[0];
  let hi = dates[dates.length - 1];
  if (calSpanValid) { lo = Math.min(lo, calStart); hi = Math.max(hi, calEnd); }
  const spanDays = hi - lo + 1;
  const serviceDaysPerYear = Math.round(dates.length / (spanDays / 365.25));

  if (cal && flagSum > 0) return { daysPerWeek: flagSum, serviceDaysPerYear };
  const weekSpan = Math.max(spanDays, 7);
  return {
    daysPerWeek: Math.min(7, (dates.length * 7) / weekSpan),
    serviceDaysPerYear,
  };
}

/** Get the first and last stop time seconds for a trip by stop_sequence order.
 *  Uses the first and last non-blank times in sequence order for a robust span.
 *  Considers both arrival_time and departure_time (first stop may have only departure).
 *  Accepts either a pre-filtered array (from byTrip index) or falls back to filtering. */
function getTripSpan(
  tripId: string,
  stopTimesOrIndex: StopTime[] | Map<string, StopTime[]>
): { start: number; end: number } | null {
  const raw = Array.isArray(stopTimesOrIndex)
    ? stopTimesOrIndex.filter((st) => st.trip_id === tripId)
    : (stopTimesOrIndex.get(tripId) || []);
  const times = raw
    .filter((st) => st.arrival_time || st.departure_time)
    .sort((a, b) => a.stop_sequence - b.stop_sequence);
  if (times.length < 2) return null;

  const first = times[0];
  const last = times[times.length - 1];
  const start = gtfsTimeToSeconds(first.departure_time || first.arrival_time);
  const end = gtfsTimeToSeconds(last.arrival_time || last.departure_time);

  if (end <= start) return null;
  return { start, end };
}

/** Estimate peak overlapping vehicles using a sweep-line algorithm. */
function computePeakVehicles(spans: { start: number; end: number }[]): number {
  if (spans.length === 0) return 0;

  const events: { time: number; delta: number }[] = [];
  for (const span of spans) {
    events.push({ time: span.start, delta: 1 });
    events.push({ time: span.end, delta: -1 });
  }

  // Sort by time; on tie, ends (-1) before starts (+1) so we don't over-count
  events.sort((a, b) => a.time - b.time || a.delta - b.delta);

  let current = 0;
  let peak = 0;
  for (const ev of events) {
    current += ev.delta;
    if (current > peak) peak = current;
  }

  return peak;
}

/** The in-service spans a single trip contributes to the concurrency sweep.
 *
 *  Normally one span = [first departure, last arrival]. But if the trip has
 *  frequencies.txt entries it is a headway-based pattern standing in for many
 *  vehicles rather than a single run: during each [start_time, end_time) window
 *  the number of vehicles simultaneously in service is ≈
 *  ceil(tripDuration / headway_secs), so we emit that many overlapping copies of
 *  the window (the reference run's explicit stop_times are ignored, per the GTFS
 *  spec). Invalid windows (non-positive headway or empty range) are skipped, and
 *  if every window is invalid we fall back to the single reference span so the
 *  trip still counts as one vehicle. */
function tripConcurrencySpans(
  span: { start: number; end: number },
  freqs: Frequency[] | undefined,
): { start: number; end: number }[] {
  if (!freqs || freqs.length === 0) return [span];

  const duration = span.end - span.start;
  const out: { start: number; end: number }[] = [];
  for (const f of freqs) {
    const winStart = gtfsTimeToSeconds(f.start_time);
    const winEnd = gtfsTimeToSeconds(f.end_time);
    if (winEnd <= winStart || f.headway_secs <= 0 || duration <= 0) continue;
    const concurrent = Math.max(1, Math.ceil(duration / f.headway_secs));
    for (let i = 0; i < concurrent; i++) out.push({ start: winStart, end: winEnd });
  }

  return out.length > 0 ? out : [span];
}

/** Departures a frequency template stands for across its valid windows
 *  (ceil(window / headway) each), or 0 when it has none (a plain trip). */
function frequencyDepartures(
  span: { start: number; end: number },
  freqs: Frequency[] | undefined,
): number {
  if (!freqs || freqs.length === 0 || span.end <= span.start) return 0;
  return windowDepartureCount(freqs);
}

/** TRUE whole-system peak: the maximum number of vehicles simultaneously in
 *  service at the single busiest instant across the ENTIRE system.
 *
 *  Gathers every trip across every route, groups them by service_id, and runs
 *  the concurrency sweep over ALL of that service_id's trips system-wide; the
 *  answer is the MAX over service_ids. This is the "vehicles required for peak
 *  service" number, and it is ≤ the sum of per-route peaks (routes peak at
 *  different times of day, so their peaks never all stack at one instant).
 *
 *  Design notes (matches calculateRouteSpans' existing approach):
 *   - Grouping by service_id mirrors the per-route logic and keeps day-types
 *     separate (one service_id ≈ one day type). This can slightly UNDER-count
 *     when a single calendar DATE is served by multiple overlapping service_ids
 *     whose peaks would actually stack on that date — acceptable for v1.
 *   - block_id is intentionally NOT special-cased: a block's trips are
 *     sequential and never overlap, so the per-trip sweep already yields the
 *     correct instantaneous peak (block_id affects total fleet/deadhead, not the
 *     instantaneous in-service count).
 *   - frequencies.txt IS honored via tripConcurrencySpans (a headway-based trip
 *     contributes ceil(tripDuration / headway) concurrent vehicles per window). */
export function calculateSystemPeakVehicles(
  state: Pick<AppStore, 'trips'> & {
    stopTimes: StopTime[];
    stopTimesByTrip?: Map<string, StopTime[]>;
    frequencies?: Frequency[];
  },
): number {
  const lookup = state.stopTimesByTrip || state.stopTimes;

  // Index frequencies by trip_id for O(1) lookup per trip.
  const freqByTrip = new Map<string, Frequency[]>();
  for (const f of state.frequencies || []) {
    const group = freqByTrip.get(f.trip_id) || [];
    group.push(f);
    freqByTrip.set(f.trip_id, group);
  }

  // Group every trip (all routes) by service_id, accumulating its concurrency
  // spans into that service_id's bucket.
  const spansByService = new Map<string, { start: number; end: number }[]>();
  for (const trip of state.trips) {
    const span = getTripSpan(trip.trip_id, lookup);
    if (!span) continue;
    const group = spansByService.get(trip.service_id) || [];
    for (const s of tripConcurrencySpans(span, freqByTrip.get(trip.trip_id))) {
      group.push(s);
    }
    spansByService.set(trip.service_id, group);
  }

  let systemPeak = 0;
  for (const spans of spansByService.values()) {
    const peak = computePeakVehicles(spans);
    if (peak > systemPeak) systemPeak = peak;
  }
  return systemPeak;
}

/** Phase 2: Compute route spans (expensive, depends on trips + stopTimes).
 *  Accepts an optional byTrip index for O(1) lookups instead of O(n) scans. */
export function calculateRouteSpans(
  routeId: string,
  state: Pick<AppStore, 'routes' | 'trips' | 'calendars' | 'calendarDates'> & {
    stopTimes: StopTime[];
    stopTimesByTrip?: Map<string, StopTime[]>;
    /** frequencies.txt: a template trip with valid windows counts once per
     *  departure (revenue hours, trips) and as concurrent vehicles (peak), the
     *  same expansion calculateSystemPeakVehicles uses. */
    frequencies?: Frequency[];
  },
): RouteSpans {
  const routeTrips = state.trips.filter((t) => t.route_id === routeId);
  const lookup = state.stopTimesByTrip || state.stopTimes;
  const routeTripIds = new Set(routeTrips.map((t) => t.trip_id));
  const freqByTrip = new Map<string, Frequency[]>();
  for (const f of state.frequencies || []) {
    if (!routeTripIds.has(f.trip_id)) continue;
    const group = freqByTrip.get(f.trip_id);
    if (group) group.push(f); else freqByTrip.set(f.trip_id, [f]);
  }

  // Group trips by service_id
  const tripsByService = new Map<string, typeof routeTrips>();
  for (const trip of routeTrips) {
    const group = tripsByService.get(trip.service_id) || [];
    group.push(trip);
    tripsByService.set(trip.service_id, group);
  }

  let weeklyRevHours = 0;
  let weeklyTrips = 0;
  let maxPeakVehicles = 0;
  const serviceBreakdown: RouteSpans['_serviceBreakdown'] = [];

  for (const [serviceId, serviceTrips] of tripsByService) {
    const spans: { start: number; end: number }[] = [];
    let revSeconds = 0;
    let dailyTrips = 0;

    for (const trip of serviceTrips) {
      const span = getTripSpan(trip.trip_id, lookup);
      const departures = span ? frequencyDepartures(span, freqByTrip.get(trip.trip_id)) : 0;
      if (span) {
        for (const s of tripConcurrencySpans(span, freqByTrip.get(trip.trip_id))) spans.push(s);
        revSeconds += (span.end - span.start) * Math.max(1, departures);
      }
      dailyTrips += Math.max(1, departures);
    }

    const revHours = revSeconds / 3600;
    const peak = computePeakVehicles(spans);

    const { daysPerWeek, serviceDaysPerYear } = serviceDayStats(serviceId, state);

    weeklyRevHours += revHours * daysPerWeek;
    weeklyTrips += dailyTrips * daysPerWeek;
    if (peak > maxPeakVehicles) maxPeakVehicles = peak;

    serviceBreakdown.push({ serviceId, revHours, daysPerWeek, serviceDaysPerYear, peak });
  }

  return {
    weeklyRevHours,
    weeklyTotalHoursBase: weeklyRevHours, // same as rev hours before deadhead
    tripsPerWeek: weeklyTrips,
    peakVehicles: maxPeakVehicles,
    _serviceBreakdown: serviceBreakdown,
  };
}

/** Phase 2: Apply cost parameters to pre-computed spans (cheap multiplication). */
export function applyRouteCosts(
  spans: RouteSpans,
  costPerHour: number,
  deadheadFactor: number,
): RouteStats {
  const weeklyTotalHours = spans.weeklyRevHours * deadheadFactor;
  let weeklyCost = 0;
  let annualCost = 0;

  for (const svc of spans._serviceBreakdown) {
    const totalHoursForSvc = svc.revHours * deadheadFactor;
    const dailyCost = totalHoursForSvc * costPerHour;
    weeklyCost += dailyCost * svc.daysPerWeek;
    annualCost += dailyCost * svc.serviceDaysPerYear;
  }

  return {
    revenueHoursWeekly: spans.weeklyRevHours,
    totalHoursWeekly: weeklyTotalHours,
    tripsPerWeek: spans.tripsPerWeek,
    peakVehicles: spans.peakVehicles,
    weeklyCost,
    annualCost,
  };
}

/** Combined convenience function (backward-compatible). */
export function calculateRouteStats(
  routeId: string,
  state: Pick<AppStore, 'routes' | 'trips' | 'stopTimes' | 'calendars' | 'calendarDates'> & {
    stopTimesByTrip?: Map<string, StopTime[]>;
    frequencies?: Frequency[];
  },
  defaultCostPerHour = 0,
  deadheadFactor = 1.2,
): RouteStats {
  const route = state.routes.find((r) => r.route_id === routeId);
  const costPerHour = route?._cost_per_revenue_hour ?? defaultCostPerHour;
  const spans = calculateRouteSpans(routeId, state);
  return applyRouteCosts(spans, costPerHour, deadheadFactor);
}

export function calculateSystemStats(
  state: Pick<AppStore, 'routes' | 'trips' | 'stopTimes' | 'calendars' | 'calendarDates'> & {
    stopTimesByTrip?: Map<string, StopTime[]>;
    frequencies?: Frequency[];
  },
  defaultCostPerHour = 0,
  deadheadFactor = 1.2,
): SystemStats {
  let totalRevenueHoursWeekly = 0;
  let totalHoursWeekly = 0;
  let totalTripsPerWeek = 0;
  let totalPeakVehicles = 0;
  let totalWeeklyCost = 0;
  let totalAnnualCost = 0;

  for (const route of state.routes) {
    const stats = calculateRouteStats(route.route_id, state, defaultCostPerHour, deadheadFactor);
    totalRevenueHoursWeekly += stats.revenueHoursWeekly;
    totalHoursWeekly += stats.totalHoursWeekly;
    totalTripsPerWeek += stats.tripsPerWeek;
    totalPeakVehicles += stats.peakVehicles;
    totalWeeklyCost += stats.weeklyCost;
    totalAnnualCost += stats.annualCost;
  }

  // The real fleet need: max simultaneous vehicles across the whole system,
  // NOT the sum of per-route peaks above (which over-counts).
  const systemPeakVehicles = calculateSystemPeakVehicles(state);

  return {
    totalRevenueHoursWeekly,
    totalHoursWeekly,
    totalTripsPerWeek,
    totalPeakVehicles,
    systemPeakVehicles,
    totalWeeklyCost,
    totalAnnualCost,
  };
}

// ─── B3: block-derived cost ────────────────────────────────────────────────
// Upgrades the flat deadheadFactor to real service / layover / deadhead hours
// derived from the block geometry, when blocks exist. Falls back to the flat
// factor when they don't (closes REQUIREMENTS.md:246).

export interface BlockCostOptions {
  costPerHour: number;
  /** Include in-block layover (recovery) hours in the operating cost. */
  costLayover: boolean;
  /** Include inter-trip deadhead hours in the operating cost. */
  costDeadhead: boolean;
  deadheadSpeedMph?: number;
  /** Cap on how much of a within-block gap counts as paid layover. */
  maxLayoverSecs?: number;
  /** Flat multiplier applied to the revenue hours of unblocked trips (all
   *  trips, when the feed has no blocks). */
  deadheadFactor?: number;
}

export interface BlockServiceCost {
  serviceId: string;
  vehicles: number;          // distinct blocks in this day-type
  unblockedTrips: number;
  serviceHours: number;      // daily, Σ in-service time
  layoverHours: number;      // daily, Σ capped in-block gaps
  deadheadHours: number;     // daily, Σ in-block inter-trip deadhead
  dailyCost: number;
  daysPerWeek: number;
  serviceDaysPerYear: number;
}

export interface BlockCostResult {
  hasBlocks: boolean;
  perService: BlockServiceCost[];
  /** Peak fleet: the busiest day-type's vehicle (block) count. */
  maxVehicles: number;
  weeklyCost: number;
  annualCost: number;
}

/**
 * Per day-type service / layover / deadhead hours from the block geometry, and
 * the resulting daily / weekly / annual cost. When the feed has no block_id at
 * all, this matches the flat-deadheadFactor model (regression-safe).
 */
export function calculateBlockCost(
  state: Pick<AppStore, 'trips' | 'stopTimes' | 'stops' | 'calendars' | 'calendarDates'>,
  opts: BlockCostOptions,
): BlockCostResult {
  const speed = opts.deadheadSpeedMph ?? 25;
  const maxLayover = opts.maxLayoverSecs ?? 3600;
  const deadheadFactor = opts.deadheadFactor ?? 1.2;
  const stopsById = new Map<string, Stop>(state.stops.map((s) => [s.stop_id, s]));
  const spans = computeTripSpans(state.trips as Trip[], state.stopTimes);

  const hasBlocks = (state.trips as Trip[]).some((t) => !!t.block_id);

  const byService = new Map<string, Trip[]>();
  for (const t of state.trips as Trip[]) {
    const g = byService.get(t.service_id);
    if (g) g.push(t); else byService.set(t.service_id, [t]);
  }

  const perService: BlockServiceCost[] = [];
  let weeklyCost = 0;
  let annualCost = 0;
  let maxVehicles = 0;

  for (const [serviceId, trips] of byService) {
    let serviceSec = 0;
    let unblockedSec = 0;
    let layoverSec = 0;
    let deadheadSec = 0;
    let unblockedTrips = 0;

    const blocks = new Map<string, Trip[]>();
    for (const t of trips) {
      const span = spans.get(t.trip_id);
      if (span) serviceSec += span.endSec - span.startSec;
      if (t.block_id) {
        const g = blocks.get(t.block_id);
        if (g) g.push(t); else blocks.set(t.block_id, [t]);
      } else if (span) {
        unblockedTrips++;
        unblockedSec += span.endSec - span.startSec;
      }
    }

    for (const blockTrips of blocks.values()) {
      const ordered = blockTrips
        .map((t) => spans.get(t.trip_id))
        .filter((s): s is NonNullable<typeof s> => !!s)
        .sort((a, b) => a.startSec - b.startSec);
      for (let i = 1; i < ordered.length; i++) {
        const gap = ordered[i].startSec - ordered[i - 1].endSec;
        if (gap <= 0) continue; // overlap — not a real layover
        const dh = deadheadSecs(ordered[i - 1].endStopId, ordered[i].startStopId, stopsById, speed);
        deadheadSec += Math.min(dh, gap);
        layoverSec += Math.min(Math.max(0, gap - dh), maxLayover);
      }
    }

    const serviceHours = serviceSec / 3600;
    const layoverHours = layoverSec / 3600;
    const deadheadHours = deadheadSec / 3600;

    // Daily operating hours: block-derived for blocked trips (their real
    // layover + deadhead), and the flat factor on revenue hours for every
    // unblocked trip — per service, so blocking one day-type never strips the
    // factor from another. With no blocks at all this is serviceHours × factor
    // (regression-safe with applyRouteCosts).
    const blockedHours = (serviceSec - unblockedSec) / 3600;
    const unblockedHours = unblockedSec / 3600;
    const opHours = blockedHours
      + (opts.costLayover ? layoverHours : 0)
      + (opts.costDeadhead ? deadheadHours : 0)
      + unblockedHours * deadheadFactor;
    const dailyCost = opHours * opts.costPerHour;

    const { daysPerWeek, serviceDaysPerYear } = serviceDayStats(serviceId, state);

    weeklyCost += dailyCost * daysPerWeek;
    annualCost += dailyCost * serviceDaysPerYear;
    const vehicles = blocks.size;
    if (vehicles > maxVehicles) maxVehicles = vehicles;

    perService.push({
      serviceId, vehicles, unblockedTrips,
      serviceHours, layoverHours, deadheadHours,
      dailyCost, daysPerWeek, serviceDaysPerYear,
    });
  }

  perService.sort((a, b) => b.dailyCost - a.dailyCost);
  return { hasBlocks, perService, maxVehicles, weeklyCost, annualCost };
}
