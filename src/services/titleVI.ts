import distance from '@turf/distance';
import { point } from '@turf/helpers';
import type { BlockGroupData } from './demographics';
import type { Stop } from '../types/gtfs';
import type { AppStore } from '../store';
import { BG_RADIUS_MILES, circleOverlapFraction, computeBgRadii } from './coverageAnalysis';
import { representativeServiceDate } from './serviceIds';

/**
 * Two-tier buffer per FTA-aligned local practice: stops with peak-hour headways
 * of 15 minutes or less ("high-frequency" service) draw service area at the
 * 0.5-mile walk distance commonly associated with light rail / BRT; all other
 * stops use 0.25 mile, the conventional bus walk-distance threshold.
 */
const HIGH_FREQ_BUFFER_MILES = 0.5;
const GENERAL_BUFFER_MILES = 0.25;
/** A stop qualifies for the larger buffer when its peak hour headway ≤ this. */
const HIGH_FREQ_HEADWAY_MIN = 15;

export interface BlockGroupServiceLevel {
  geoid: string;
  dailyTrips: number;
  minorityShare: number;
  isMinority: boolean;
  /** False when the BG has no race data; it is then in neither minority group. */
  hasRaceData: boolean;
  lowIncomeShare: number;
  isLowIncome: boolean;
  /** False when the BG has no poverty-universe data; excluded from the EJ groups. */
  hasIncomeData: boolean;
  population: number;
}

export interface TitleVIGroup {
  count: number;
  avgDailyTrips: number;
  totalPop: number;
}

export interface TitleVIResult {
  /** Regional minority share — threshold for classifying a BG as minority. */
  regionalMinorityShare: number;
  minority: TitleVIGroup;
  nonMinority: TitleVIGroup;
  /**
   * Ratio of minority avg. daily trips to non-minority avg. daily trips.
   * < 1.0 means minority BGs receive less service on average. null when
   * either group is empty or the non-minority group gets no service.
   */
  ratio: number | null;
  /** Regional low-income (<200% FPL) share — threshold for the EJ comparison. */
  regionalLowIncomeShare: number;
  lowIncome: TitleVIGroup;
  nonLowIncome: TitleVIGroup;
  /** Ratio of low-income to non-low-income avg. daily trips (FTA EJ analysis);
   *  null when there is no meaningful comparison (see `ratio`). */
  lowIncomeRatio: number | null;
  blockGroupLevels: BlockGroupServiceLevel[];
  /**
   * The service day the trip counts are based on: the representative date
   * (label e.g. "Mon, Oct 5, 2026") when chosen automatically, the caller's
   * service ids (label null) when passed, or null when stop_times were used
   * unfiltered (no trips supplied).
   */
  basis: { label: string | null; date: string | null; serviceIds: string[] } | null;
}

/**
 * Pick a per-stop service buffer using the peak-hour headway as the
 * frequency proxy. Peak hour = the single hour-of-day with the most trips
 * serving the stop; headway = 60 / trip-count in that hour. Stops with no
 * stop_times entries inherit the general buffer (no service to weight).
 */
function computeStopBuffers(
  stops: Stop[],
  stopTimes: AppStore['stopTimes'],
): Map<string, number> {
  // Trips per (stop_id, hour-of-day 0-23). Wrap-around hours (24:00:00 +)
  // collapse modulo 24 — overnight service rarely defines the peak anyway.
  const tripsPerHourPerStop = new Map<string, Map<number, number>>();
  for (const st of stopTimes) {
    const time = st.departure_time || st.arrival_time;
    if (!time) continue;
    const hour = Number.parseInt(time.split(':')[0] ?? '', 10);
    if (!Number.isFinite(hour)) continue;
    const bucket = ((hour % 24) + 24) % 24;
    let m = tripsPerHourPerStop.get(st.stop_id);
    if (!m) { m = new Map(); tripsPerHourPerStop.set(st.stop_id, m); }
    m.set(bucket, (m.get(bucket) ?? 0) + 1);
  }

  const buffers = new Map<string, number>();
  for (const s of stops) {
    const hourMap = tripsPerHourPerStop.get(s.stop_id);
    if (!hourMap || hourMap.size === 0) {
      buffers.set(s.stop_id, GENERAL_BUFFER_MILES);
      continue;
    }
    let maxTrips = 0;
    for (const v of hourMap.values()) if (v > maxTrips) maxTrips = v;
    const peakHeadway = maxTrips > 0 ? 60 / maxTrips : Number.POSITIVE_INFINITY;
    buffers.set(
      s.stop_id,
      peakHeadway <= HIGH_FREQ_HEADWAY_MIN ? HIGH_FREQ_BUFFER_MILES : GENERAL_BUFFER_MILES,
    );
  }
  return buffers;
}

/**
 * Perform a Title VI transit service equity analysis.
 *
 * Steps:
 *   1. Count daily trips per stop (unique trip_ids in stop_times).
 *   2. Determine a per-stop service buffer: 0.5 mi when peak-hour headway is
 *      ≤ 15 minutes ("high-frequency"), 0.25 mi otherwise.
 *   3. Compute the regional minority share threshold.
 *   4. For each block group, apportion daily trips from nearby stops using the
 *      same circle-circle overlap formula as the coverage analysis.
 *   5. Classify each BG as minority or non-minority based on whether its
 *      minority population share meets or exceeds the regional average.
 *   6. Compare average apportioned daily trips between the two groups.
 */
export function calculateTitleVI(
  stops: Stop[],
  blockGroups: BlockGroupData[],
  state: Pick<AppStore, 'stopTimes'> & Partial<Pick<AppStore, 'trips' | 'calendars' | 'calendarDates'>>,
  serviceIds?: ReadonlySet<string>,
): TitleVIResult {
  // 0. One service day. Without this, every service_id's trips (weekday +
  //    Saturday + Sunday …) were summed into "daily" trips and the peak hour.
  //    The caller may pass the services to analyse; otherwise, when trips and
  //    calendars are supplied, the representative (busiest) service date is
  //    used. With no trips, stop_times are used as given (legacy behaviour).
  let basis: TitleVIResult['basis'] = null;
  let stopTimes = state.stopTimes;
  if (state.trips) {
    let ids: ReadonlySet<string> | undefined = serviceIds;
    if (!ids && (state.calendars || state.calendarDates)) {
      const rep = representativeServiceDate({
        trips: state.trips,
        calendars: state.calendars ?? [],
        calendarDates: state.calendarDates ?? [],
      });
      if (rep.date) {
        ids = rep.serviceIds;
        basis = { label: rep.label, date: rep.date, serviceIds: [...rep.serviceIds] };
      }
    } else if (ids) {
      basis = { label: null, date: null, serviceIds: [...ids] };
    }
    if (ids) {
      const keep = ids;
      const tripsOnDay = new Set(state.trips.filter((t) => keep.has(t.service_id)).map((t) => t.trip_id));
      stopTimes = state.stopTimes.filter((st) => tripsOnDay.has(st.trip_id));
    }
  }

  // 1. Daily trips per stop: count of unique trip_ids visiting each stop_id
  const tripSetsPerStop = new Map<string, Set<string>>();
  for (const st of stopTimes) {
    let s = tripSetsPerStop.get(st.stop_id);
    if (!s) { s = new Set(); tripSetsPerStop.set(st.stop_id, s); }
    s.add(st.trip_id);
  }
  const dailyTripsPerStop = new Map<string, number>();
  for (const [stopId, trips] of tripSetsPerStop) {
    dailyTripsPerStop.set(stopId, trips.size);
  }

  // 2. Per-stop buffer based on peak-hour headway
  const stopBuffers = computeStopBuffers(stops, stopTimes);

  // 3. Regional minority share across all block groups with known race data
  const bgsWithRace = blockGroups.filter((bg) => bg.totalRacePop > 0);
  const regionTotalPop = bgsWithRace.reduce((s, bg) => s + bg.totalRacePop, 0);
  const regionMinorityPop = bgsWithRace.reduce((s, bg) => s + bg.minorityPop, 0);
  const regionalMinorityShare = regionTotalPop > 0 ? regionMinorityPop / regionTotalPop : 0;

  // 3b. Regional low-income (<200% FPL) share — the EJ-population threshold.
  const regionPovertyUniverse = blockGroups.reduce((s, bg) => s + bg.povertyUniverse, 0);
  const regionLowIncome = blockGroups.reduce((s, bg) => s + bg.lowIncomePop, 0);
  const regionalLowIncomeShare = regionPovertyUniverse > 0 ? regionLowIncome / regionPovertyUniverse : 0;

  // 4 & 5. For each block group compute apportioned daily trips and classify
  const stopPoints = stops.map((s) => ({
    pt: point([s.stop_lon, s.stop_lat]),
    dailyTrips: dailyTripsPerStop.get(s.stop_id) ?? 0,
    bufferMiles: stopBuffers.get(s.stop_id) ?? GENERAL_BUFFER_MILES,
  }));

  // Adaptive per-tract apportionment radius — same model the coverage panel
  // uses, so the two analyses agree and rural tracts aren't dead zones.
  const radii = computeBgRadii(blockGroups);
  const levels: BlockGroupServiceLevel[] = [];

  for (const bg of blockGroups) {
    const bgPoint = point([bg.lon, bg.lat]);
    const bgRadius = radii.get(bg.geoid) ?? BG_RADIUS_MILES;
    let dailyTrips = 0;

    for (const { pt, dailyTrips: stopTrips, bufferMiles } of stopPoints) {
      const d = distance(bgPoint, pt, { units: 'miles' });
      const fraction = circleOverlapFraction(d, bufferMiles, bgRadius);
      if (fraction > 0) dailyTrips += fraction * stopTrips;
    }

    const hasRaceData = bg.totalRacePop > 0;
    const hasIncomeData = bg.povertyUniverse > 0;
    const minorityShare = hasRaceData ? bg.minorityPop / bg.totalRacePop : 0;
    const lowIncomeShare = hasIncomeData ? bg.lowIncomePop / bg.povertyUniverse : 0;
    levels.push({
      geoid: bg.geoid,
      dailyTrips,
      minorityShare,
      isMinority: hasRaceData && minorityShare >= regionalMinorityShare,
      hasRaceData,
      lowIncomeShare,
      isLowIncome: hasIncomeData && lowIncomeShare >= regionalLowIncomeShare,
      hasIncomeData,
      population: bg.population,
    });
  }

  // 6. Aggregate by group
  const avgTrips = (arr: BlockGroupServiceLevel[]) =>
    arr.length > 0 ? arr.reduce((s, l) => s + l.dailyTrips, 0) / arr.length : 0;
  const sumPop = (arr: BlockGroupServiceLevel[]) => arr.reduce((s, l) => s + l.population, 0);
  const group = (arr: BlockGroupServiceLevel[]): TitleVIGroup => ({
    count: arr.length,
    avgDailyTrips: avgTrips(arr),
    totalPop: sumPop(arr),
  });

  // Block groups with no race (or poverty-universe) data are left out of that
  // comparison entirely, rather than defaulting to a 0 share (which put them
  // all in the non-minority group).
  const minorityLevels     = levels.filter((l) => l.hasRaceData && l.isMinority);
  const nonMinorityLevels  = levels.filter((l) => l.hasRaceData && !l.isMinority);
  const lowIncomeLevels     = levels.filter((l) => l.hasIncomeData && l.isLowIncome);
  const nonLowIncomeLevels  = levels.filter((l) => l.hasIncomeData && !l.isLowIncome);
  // null = no meaningful ratio (a group is empty, or the comparison group gets
  // no service), never 0 — 0 would render as the worst-case disparity.
  const ratioOf = (num: BlockGroupServiceLevel[], den: BlockGroupServiceLevel[]): number | null => {
    if (num.length === 0 || den.length === 0) return null;
    const d = avgTrips(den);
    return d > 0 ? avgTrips(num) / d : null;
  };

  return {
    regionalMinorityShare,
    minority: group(minorityLevels),
    nonMinority: group(nonMinorityLevels),
    ratio: ratioOf(minorityLevels, nonMinorityLevels),
    regionalLowIncomeShare,
    lowIncome: group(lowIncomeLevels),
    nonLowIncome: group(nonLowIncomeLevels),
    lowIncomeRatio: ratioOf(lowIncomeLevels, nonLowIncomeLevels),
    blockGroupLevels: levels,
    basis,
  };
}
