import distance from '@turf/distance';
import { point } from '@turf/helpers';
import type { BlockGroupData } from './demographics';
import type { Stop } from '../types/gtfs';
import type { AppStore } from '../store';
import { BG_RADIUS_MILES, circleOverlapFraction } from './coverageAnalysis';

/** Buffer radius used when assigning stop service to block groups for Title VI. */
const TITLE_VI_BUFFER_MILES = 0.5;

export interface BlockGroupServiceLevel {
  geoid: string;
  dailyTrips: number;
  minorityShare: number;
  isMinority: boolean;
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
   * < 1.0 means minority BGs receive less service on average.
   */
  ratio: number;
  blockGroupLevels: BlockGroupServiceLevel[];
}

/**
 * Perform a Title VI transit service equity analysis per the methodology in
 * "Title VI Transit Service Analysis - Calculation Procedures Memo.md".
 *
 * Steps:
 *   1. Count daily trips per stop (unique trip_ids in stop_times).
 *   2. Compute the regional minority share threshold.
 *   3. For each block group, apportion daily trips from nearby stops using the
 *      same circle-circle overlap formula as the coverage analysis.
 *   4. Classify each BG as minority or non-minority based on whether its
 *      minority population share meets or exceeds the regional average.
 *   5. Compare average apportioned daily trips between the two groups.
 */
export function calculateTitleVI(
  stops: Stop[],
  blockGroups: BlockGroupData[],
  state: Pick<AppStore, 'stopTimes'>,
): TitleVIResult {
  // 1. Daily trips per stop: count of unique trip_ids visiting each stop_id
  const tripSetsPerStop = new Map<string, Set<string>>();
  for (const st of state.stopTimes) {
    let s = tripSetsPerStop.get(st.stop_id);
    if (!s) { s = new Set(); tripSetsPerStop.set(st.stop_id, s); }
    s.add(st.trip_id);
  }
  const dailyTripsPerStop = new Map<string, number>();
  for (const [stopId, trips] of tripSetsPerStop) {
    dailyTripsPerStop.set(stopId, trips.size);
  }

  // 2. Regional minority share across all block groups with known race data
  const bgsWithRace = blockGroups.filter((bg) => bg.totalRacePop > 0);
  const regionTotalPop = bgsWithRace.reduce((s, bg) => s + bg.totalRacePop, 0);
  const regionMinorityPop = bgsWithRace.reduce((s, bg) => s + bg.minorityPop, 0);
  const regionalMinorityShare = regionTotalPop > 0 ? regionMinorityPop / regionTotalPop : 0;

  // 3 & 4. For each block group compute apportioned daily trips and classify
  const stopPoints = stops.map((s) => ({
    pt: point([s.stop_lon, s.stop_lat]),
    dailyTrips: dailyTripsPerStop.get(s.stop_id) ?? 0,
  }));

  const levels: BlockGroupServiceLevel[] = [];

  for (const bg of blockGroups) {
    const bgPoint = point([bg.lon, bg.lat]);
    let dailyTrips = 0;

    for (const { pt, dailyTrips: stopTrips } of stopPoints) {
      const d = distance(bgPoint, pt, { units: 'miles' });
      const fraction = circleOverlapFraction(d, TITLE_VI_BUFFER_MILES, BG_RADIUS_MILES);
      if (fraction > 0) dailyTrips += fraction * stopTrips;
    }

    const minorityShare = bg.totalRacePop > 0 ? bg.minorityPop / bg.totalRacePop : 0;
    levels.push({
      geoid: bg.geoid,
      dailyTrips,
      minorityShare,
      isMinority: minorityShare >= regionalMinorityShare,
      population: bg.population,
    });
  }

  // 5. Aggregate by group
  const minorityLevels    = levels.filter((l) => l.isMinority);
  const nonMinorityLevels = levels.filter((l) => !l.isMinority);

  const avgTrips = (arr: BlockGroupServiceLevel[]) =>
    arr.length > 0 ? arr.reduce((s, l) => s + l.dailyTrips, 0) / arr.length : 0;

  const minorityAvg    = avgTrips(minorityLevels);
  const nonMinorityAvg = avgTrips(nonMinorityLevels);

  return {
    regionalMinorityShare,
    minority: {
      count:        minorityLevels.length,
      avgDailyTrips: minorityAvg,
      totalPop:     minorityLevels.reduce((s, l) => s + l.population, 0),
    },
    nonMinority: {
      count:        nonMinorityLevels.length,
      avgDailyTrips: nonMinorityAvg,
      totalPop:     nonMinorityLevels.reduce((s, l) => s + l.population, 0),
    },
    ratio: nonMinorityAvg > 0 ? minorityAvg / nonMinorityAvg : 0,
    blockGroupLevels: levels,
  };
}
