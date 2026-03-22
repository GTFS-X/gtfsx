import type { AppStore } from '../store';
import { gtfsTimeToSeconds } from '../utils/time';

export interface RouteStats {
  revenueHoursDaily: number;
  tripsPerDay: number;
  peakVehicles: number;
  dailyCost: number;
  annualCost: number;
}

export interface SystemStats {
  totalRevenueHoursDaily: number;
  totalTripsPerDay: number;
  totalPeakVehicles: number;
  totalDailyCost: number;
  totalAnnualCost: number;
}

/** Count service days per year from calendar entries and calendar_dates exceptions. */
function countServiceDaysPerYear(
  serviceIds: string[],
  state: Pick<AppStore, 'calendars' | 'calendarDates'>
): number {
  if (serviceIds.length === 0) return 365;

  const relevantCalendars = state.calendars.filter((c) =>
    serviceIds.includes(c.service_id)
  );

  if (relevantCalendars.length === 0) return 365;

  // Collect all service dates across all relevant calendars
  let totalDays = 0;

  for (const cal of relevantCalendars) {
    const start = parseYYYYMMDD(cal.start_date);
    const end = parseYYYYMMDD(cal.end_date);
    if (!start || !end) continue;

    const dayFlags = [
      cal.sunday,
      cal.monday,
      cal.tuesday,
      cal.wednesday,
      cal.thursday,
      cal.friday,
      cal.saturday,
    ];

    let days = 0;
    const cursor = new Date(start);
    while (cursor <= end) {
      if (dayFlags[cursor.getDay()]) {
        days++;
      }
      cursor.setDate(cursor.getDate() + 1);
    }

    // Apply calendar_dates exceptions for this service
    const exceptions = state.calendarDates.filter(
      (cd) => cd.service_id === cal.service_id
    );
    for (const ex of exceptions) {
      const exDate = parseYYYYMMDD(ex.date);
      if (!exDate || exDate < start || exDate > end) continue;
      if (ex.exception_type === 1) {
        // Added — only count if not already a regular service day
        if (!dayFlags[exDate.getDay()]) days++;
      } else if (ex.exception_type === 2) {
        // Removed — only subtract if it was a regular service day
        if (dayFlags[exDate.getDay()]) days--;
      }
    }

    totalDays = Math.max(totalDays, days);
  }

  return totalDays || 365;
}

function parseYYYYMMDD(s: string): Date | null {
  if (!s || s.length !== 8) return null;
  const y = parseInt(s.slice(0, 4), 10);
  const m = parseInt(s.slice(4, 6), 10) - 1;
  const d = parseInt(s.slice(6, 8), 10);
  return new Date(y, m, d);
}

/** Get the first and last stop time seconds for a trip. Returns null if no stop times. */
function getTripSpan(
  tripId: string,
  stopTimes: AppStore['stopTimes']
): { start: number; end: number } | null {
  const times = stopTimes.filter(
    (st) => st.trip_id === tripId && st.arrival_time
  );
  if (times.length < 2) return null;

  let earliest = Infinity;
  let latest = -Infinity;
  for (const st of times) {
    const arr = gtfsTimeToSeconds(st.arrival_time);
    const dep = gtfsTimeToSeconds(st.departure_time || st.arrival_time);
    if (arr < earliest) earliest = arr;
    if (dep > latest) latest = dep;
    if (arr > latest) latest = arr;
  }

  if (earliest === Infinity || latest === -Infinity || latest <= earliest)
    return null;
  return { start: earliest, end: latest };
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

export function calculateRouteStats(
  routeId: string,
  state: Pick<AppStore, 'routes' | 'trips' | 'stopTimes' | 'calendars' | 'calendarDates'>,
  defaultCostPerHour = 0,
): RouteStats {
  const route = state.routes.find((r) => r.route_id === routeId);
  const routeTrips = state.trips.filter((t) => t.route_id === routeId);

  const spans: { start: number; end: number }[] = [];
  let totalRevSeconds = 0;

  for (const trip of routeTrips) {
    const span = getTripSpan(trip.trip_id, state.stopTimes);
    if (span) {
      spans.push(span);
      totalRevSeconds += span.end - span.start;
    }
  }

  const revenueHoursDaily = totalRevSeconds / 3600;
  const tripsPerDay = routeTrips.length;
  const peakVehicles = computePeakVehicles(spans);
  const costPerHour = route?._cost_per_revenue_hour ?? defaultCostPerHour;
  const dailyCost = revenueHoursDaily * costPerHour;

  const serviceIds = [...new Set(routeTrips.map((t) => t.service_id))];
  const serviceDays = countServiceDaysPerYear(serviceIds, state);
  const annualCost = dailyCost * serviceDays;

  return {
    revenueHoursDaily,
    tripsPerDay,
    peakVehicles,
    dailyCost,
    annualCost,
  };
}

export function calculateSystemStats(
  state: Pick<AppStore, 'routes' | 'trips' | 'stopTimes' | 'calendars' | 'calendarDates'>,
  defaultCostPerHour = 0,
): SystemStats {
  let totalRevenueHoursDaily = 0;
  let totalTripsPerDay = 0;
  let totalPeakVehicles = 0;
  let totalDailyCost = 0;
  let totalAnnualCost = 0;

  for (const route of state.routes) {
    const stats = calculateRouteStats(route.route_id, state, defaultCostPerHour);
    totalRevenueHoursDaily += stats.revenueHoursDaily;
    totalTripsPerDay += stats.tripsPerDay;
    totalPeakVehicles += stats.peakVehicles;
    totalDailyCost += stats.dailyCost;
    totalAnnualCost += stats.annualCost;
  }

  return {
    totalRevenueHoursDaily,
    totalTripsPerDay,
    totalPeakVehicles,
    totalDailyCost,
    totalAnnualCost,
  };
}
