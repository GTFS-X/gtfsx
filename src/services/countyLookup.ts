/**
 * Point → county lookup against GTFS·X's own county-boundary layer.
 *
 * Replaces the FCC Area API (geo.fcc.gov/api/census/area), which the app used
 * to call once per stop for state + county FIPS. That third-party dependency
 * started failing (HTTP 400 from FCC's backend) in October 2026. The boundaries
 * now come from a FlatGeobuf we build and host ourselves:
 *
 *   built by   demand-dots/coverage-pipeline/build_counties.py (TIGER/Line)
 *   stored at  R2 gtfs-builder-tiles/coverage/<COUNTY_LAYER>.fgb
 *   served by  the worker's /_coverage/:region.fgb route (HTTP Range)
 *
 * Exactly like the census-block layer (blockCoverage.ts), the FlatGeobuf HTTP
 * client range-reads only the header, the R-tree nodes it needs and the one to
 * four county polygons whose bbox touches a tiny box around the point (measured
 * 25-330 KB for the first lookup in an area; the client batches nearby features
 * into one Range read), never the whole file. A later lookup that falls inside a
 * county polygon already loaded this session costs no request at all.
 *
 * Accuracy: polygons are TIGER county lines simplified at ~11 m, so an interior
 * point resolves exactly; a point within metres of a county line can land on
 * either side. A point that falls in a simplification sliver (or a stop on a
 * pier just past a simplified shoreline) snaps to the nearest county within
 * SNAP_METERS. Anything farther from every county — outside the US — gets the
 * same "No FIPS results" error the FCC path raised, so callers degrade as before.
 *
 * Connecticut: the layer's vintage matches ACS_YEAR, so CT returns its planning
 * regions (county codes 110-190), which is what current ACS queries need. FCC
 * returned the pre-2022 counties (001-015), which current ACS no longer has.
 */
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { geojson as fgbGeojson } from 'flatgeobuf';
import type { Feature, MultiPolygon, Polygon, Position } from 'geojson';

/**
 * R2 key / region name of the county layer: the `{region}` in
 * `/_coverage/{region}.fgb`. Carries the TIGER vintage because the route serves
 * `immutable` cache headers: a rebuild ships under a NEW key and this constant
 * is bumped. Never overwrite the object in place.
 */
export const COUNTY_LAYER = 'counties-2024';

/** Half-width (degrees) of the box queried around the point; also bounds the snap search. */
const QUERY_PAD_DEG = 0.005;
/** Max distance to snap a point that lands in no polygon to the nearest county. */
const SNAP_METERS = 300;

export interface CountyResult {
  stateFips: string;
  countyFips: string;
  countyName: string;
}

export class CountyNotFoundError extends Error {
  constructor() {
    super('No FIPS results found for the given coordinates');
    this.name = 'CountyNotFoundError';
  }
}

type CountyFeature = Feature<Polygon | MultiPolygon, Record<string, unknown>>;

interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Reads the county features whose bbox intersects `rect`. Injectable for tests. */
export type CountyReader = (url: string, rect: Rect) => AsyncIterable<Feature>;

const defaultReader: CountyReader = (url, rect) =>
  fgbGeojson.deserialize(url, rect) as AsyncGenerator<Feature>;

let reader: CountyReader = defaultReader;
/** Session caches: answers by rounded coordinate, and every county polygon seen so far. */
const resultCache = new Map<string, Promise<CountyResult>>();
const loadedCounties = new Map<string, CountyFeature>();

/** Test hook: swap the FlatGeobuf reader (null restores the real one) and clear caches. */
export function __setCountyReaderForTests(r: CountyReader | null): void {
  reader = r ?? defaultReader;
  resultCache.clear();
  loadedCounties.clear();
}

function layerUrl(): string {
  const path = `/_coverage/${COUNTY_LAYER}.fgb`;
  return typeof window !== 'undefined' && window.location?.origin
    ? `${window.location.origin}${path}`
    : path;
}

function toResult(f: CountyFeature): CountyResult {
  const p = f.properties ?? {};
  return {
    stateFips: String(p.statefp ?? ''),
    countyFips: String(p.countyfp ?? ''),
    countyName: String(p.name ?? ''),
  };
}

function isCounty(f: Feature): f is CountyFeature {
  const t = f.geometry?.type;
  if (t !== 'Polygon' && t !== 'MultiPolygon') return false;
  const p = (f.properties ?? {}) as Record<string, unknown>;
  return typeof p.statefp === 'string' && typeof p.countyfp === 'string';
}

function contains(f: CountyFeature, lon: number, lat: number): boolean {
  return booleanPointInPolygon([lon, lat], f);
}

/** Distance in metres from a point to a polygon's boundary (local equirectangular). */
function distanceToBoundaryM(f: CountyFeature, lon: number, lat: number): number {
  const kx = 111_320 * Math.cos((lat * Math.PI) / 180);
  const ky = 110_540;
  const rings: Position[][] =
    f.geometry.type === 'Polygon' ? f.geometry.coordinates : f.geometry.coordinates.flat();
  let best = Infinity;
  for (const ring of rings) {
    for (let i = 1; i < ring.length; i++) {
      const ax = (ring[i - 1][0] - lon) * kx;
      const ay = (ring[i - 1][1] - lat) * ky;
      const bx = (ring[i][0] - lon) * kx;
      const by = (ring[i][1] - lat) * ky;
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      const px = ax + t * dx;
      const py = ay + t * dy;
      best = Math.min(best, Math.hypot(px, py));
    }
  }
  return best;
}

async function resolve(lat: number, lon: number): Promise<CountyResult> {
  // A county polygon already loaded this session that contains the point is the
  // answer — no network. (Service-area lookups hit the same county repeatedly.)
  for (const f of loadedCounties.values()) {
    if (contains(f, lon, lat)) return toResult(f);
  }

  const rect = {
    minX: lon - QUERY_PAD_DEG,
    minY: lat - QUERY_PAD_DEG,
    maxX: lon + QUERY_PAD_DEG,
    maxY: lat + QUERY_PAD_DEG,
  };
  const candidates: CountyFeature[] = [];
  try {
    for await (const feat of reader(layerUrl(), rect)) {
      if (!isCounty(feat)) continue;
      candidates.push(feat);
      loadedCounties.set(`${feat.properties.statefp}${feat.properties.countyfp}`, feat);
    }
  } catch (err) {
    throw new Error(
      `County boundary lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const hit = candidates.find((f) => contains(f, lon, lat));
  if (hit) return toResult(hit);

  let nearest: CountyFeature | null = null;
  let nearestM = SNAP_METERS;
  for (const f of candidates) {
    const d = distanceToBoundaryM(f, lon, lat);
    if (d <= nearestM) {
      nearest = f;
      nearestM = d;
    }
  }
  if (nearest) return toResult(nearest);
  throw new CountyNotFoundError();
}

/**
 * State + county FIPS (and county name) for a lat/lon. Cached per session by
 * coordinate (~1 m); concurrent calls for the same point share one request.
 * Throws CountyNotFoundError outside the US; a network/layer failure throws a
 * plain Error and is NOT cached, so a retry can succeed.
 */
export function lookupCounty(lat: number, lon: number): Promise<CountyResult> {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return Promise.reject(new CountyNotFoundError());
  }
  const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  const cached = resultCache.get(key);
  if (cached) return cached;
  const p = resolve(lat, lon);
  resultCache.set(key, p);
  p.catch((err) => {
    if (!(err instanceof CountyNotFoundError)) resultCache.delete(key);
  });
  return p;
}
