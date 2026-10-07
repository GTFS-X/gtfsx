import { fetchCensusData, lookupFips, type BlockGroupData } from '../../services/demographics';

/** Grid cell size (degrees) used to sample the service area for county lookups. */
export const SERVICE_AREA_GRID_DEG = 0.1;
/** Upper bound on county lookups per analysis (cells beyond this are dropped, densest first kept). */
export const MAX_SERVICE_AREA_CELLS = 40;
const LOOKUP_CONCURRENCY = 4;
const CENSUS_CONCURRENCY = 2;

interface LatLon {
  stop_lat: number;
  stop_lon: number;
}

export interface ServiceAreaDeps {
  lookupFips: typeof lookupFips;
  fetchCensusData: typeof fetchCensusData;
}

const defaultDeps: ServiceAreaDeps = { lookupFips, fetchCensusData };

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * One representative stop per 0.1° grid cell, densest cells first, capped.
 * Exported for tests.
 */
export function sampleStopCells(stops: LatLon[], cap = MAX_SERVICE_AREA_CELLS): LatLon[] {
  const cells = new Map<string, { sample: LatLon; count: number }>();
  for (const s of stops) {
    if (!Number.isFinite(s.stop_lat) || !Number.isFinite(s.stop_lon)) continue;
    const key = `${Math.floor(s.stop_lat / SERVICE_AREA_GRID_DEG)}:${Math.floor(s.stop_lon / SERVICE_AREA_GRID_DEG)}`;
    const cell = cells.get(key);
    if (cell) cell.count++;
    else cells.set(key, { sample: s, count: 1 });
  }
  return [...cells.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, cap)
    .map((c) => c.sample);
}

/**
 * ACS block groups for EVERY county the stops fall in, not just the county of
 * the stops' centroid (C5-12). Stops are snapped to a coarse grid, each cell is
 * resolved to a state+county via the self-hosted county layer (capped), and each distinct
 * county is fetched once; results are concatenated and de-duplicated by geoid.
 *
 * A cell whose lookup fails (e.g. over water) is skipped; if no cell resolves,
 * the first error is thrown so the panel can show it.
 */
export async function fetchServiceAreaBlockGroups(
  stops: LatLon[],
  deps: ServiceAreaDeps = defaultDeps,
): Promise<BlockGroupData[]> {
  const samples = sampleStopCells(stops);
  if (samples.length === 0) return [];

  let firstError: unknown = null;
  const looked = await mapLimit(samples, LOOKUP_CONCURRENCY, async (s) => {
    try {
      return await deps.lookupFips(s.stop_lat, s.stop_lon);
    } catch (err) {
      firstError ??= err;
      return null;
    }
  });

  const counties = new Map<string, { stateFips: string; countyFips: string }>();
  for (const f of looked) {
    if (f) counties.set(`${f.stateFips}${f.countyFips}`, f);
  }
  if (counties.size === 0) {
    throw firstError instanceof Error ? firstError : new Error('No FIPS results found for the service area');
  }

  const perCounty = await mapLimit([...counties.values()], CENSUS_CONCURRENCY, (c) =>
    deps.fetchCensusData(c.stateFips, c.countyFips),
  );
  const seen = new Set<string>();
  const out: BlockGroupData[] = [];
  for (const list of perCounty) {
    for (const bg of list) {
      if (seen.has(bg.geoid)) continue;
      seen.add(bg.geoid);
      out.push(bg);
    }
  }
  return out;
}
