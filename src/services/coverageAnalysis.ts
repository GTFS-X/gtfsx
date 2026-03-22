import distance from '@turf/distance';
import buffer from '@turf/buffer';
import { point, featureCollection } from '@turf/helpers';
import type { BlockGroupData } from './demographics';
import type { Stop } from '../types/gtfs';
import type { AppStore } from '../store';
import { gtfsTimeToSeconds } from '../utils/time';

export interface CoverageResult {
  totalPopulation: number;
  totalHouseholds: number;
  totalWorkers: number;
  coveredBlockGroupIds: string[];
  bufferMiles: number;
}

/**
 * Check which block group centroids fall within `bufferMiles` of any stop.
 */
export function calculateCoverage(
  stops: Stop[],
  blockGroups: BlockGroupData[],
  bufferMiles: number,
): CoverageResult {
  const stopPoints = stops.map((s) => point([s.stop_lon, s.stop_lat]));

  let totalPopulation = 0;
  let totalHouseholds = 0;
  let totalWorkers = 0;
  const coveredBlockGroupIds: string[] = [];

  for (const bg of blockGroups) {
    const bgPoint = point([bg.lon, bg.lat]);
    let covered = false;

    for (const sp of stopPoints) {
      const dist = distance(bgPoint, sp, { units: 'miles' });
      if (dist <= bufferMiles) {
        covered = true;
        break;
      }
    }

    if (covered) {
      totalPopulation += bg.population;
      totalHouseholds += bg.households;
      totalWorkers += bg.workers;
      coveredBlockGroupIds.push(bg.geoid);
    }
  }

  return { totalPopulation, totalHouseholds, totalWorkers, coveredBlockGroupIds, bufferMiles };
}

/**
 * Calculate average headway in minutes for all trips on a given route.
 * Returns Infinity if there are fewer than 2 trips.
 */
function getAverageHeadway(routeId: string, state: AppStore): number {
  const routeTrips = state.trips.filter((t) => t.route_id === routeId);
  if (routeTrips.length < 2) return Infinity;

  // For each trip, find the earliest departure time
  const tripStartTimes: number[] = [];
  for (const trip of routeTrips) {
    const times = state.stopTimes
      .filter((st) => st.trip_id === trip.trip_id && st.departure_time)
      .map((st) => gtfsTimeToSeconds(st.departure_time));
    if (times.length > 0) {
      tripStartTimes.push(Math.min(...times));
    }
  }

  if (tripStartTimes.length < 2) return Infinity;

  tripStartTimes.sort((a, b) => a - b);

  let totalGap = 0;
  for (let i = 1; i < tripStartTimes.length; i++) {
    totalGap += tripStartTimes[i] - tripStartTimes[i - 1];
  }

  return totalGap / (tripStartTimes.length - 1) / 60; // convert seconds to minutes
}

/**
 * Get coverage for a specific route's stops, using 0.25mi default
 * or 0.5mi if average headway <= 15 minutes.
 */
export function getBufferForRoute(
  routeId: string,
  state: AppStore,
  blockGroups: BlockGroupData[],
): CoverageResult {
  const avgHeadway = getAverageHeadway(routeId, state);
  const bufferMiles = avgHeadway <= 15 ? 0.5 : 0.25;

  // Get stops that belong to this route
  const routeStopIds = new Set(
    state.routeStops
      .filter((rs) => rs.route_id === routeId)
      .map((rs) => rs.stop_id),
  );
  const routeStops = state.stops.filter((s) => routeStopIds.has(s.stop_id));

  return calculateCoverage(routeStops, blockGroups, bufferMiles);
}

/**
 * Generate GeoJSON buffer polygons around stops for map display.
 */
export function generateBufferGeoJSON(
  stops: Stop[],
  bufferMiles: number,
): GeoJSON.FeatureCollection {
  if (stops.length === 0) {
    return featureCollection([]) as GeoJSON.FeatureCollection;
  }

  const stopFeatures = stops.map((s) =>
    point([s.stop_lon, s.stop_lat], { stop_id: s.stop_id }),
  );

  const collection = featureCollection(stopFeatures);
  const buffered = buffer(collection, bufferMiles, { units: 'miles' });

  return (buffered ?? featureCollection([])) as GeoJSON.FeatureCollection;
}
