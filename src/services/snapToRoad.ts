const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;
const MAX_COORDINATES_PER_REQUEST = 100;
// How far (metres) a snapped endpoint may sit from the drawn endpoint before we
// treat the match as truncated — e.g. the path left the road network and Map
// Matching could only match part of it.
const TRUNCATION_THRESHOLD_M = 150;

interface MapMatchingResponse {
  matchings?: Array<{
    geometry: {
      type: 'LineString';
      coordinates: [number, number][];
    };
  }>;
  // null entries mark input points that couldn't be located on the road network.
  tracepoints?: Array<unknown | null>;
  code: string;
}

export type SnapStatus = 'ok' | 'partial' | 'failed';

export interface SnapResult {
  status: SnapStatus;
  /** Snapped geometry. Truncated to what matched when status === 'partial';
   *  equal to the raw input when status === 'failed'. */
  snapped: [number, number][];
  /** The original drawn coordinates, unchanged. */
  raw: [number, number][];
}

/**
 * Snap an array of [lng, lat] coordinates to the nearest road using the Mapbox
 * Map Matching API. If the input exceeds the API limit of 100 coordinates, the
 * array is split into overlapping chunks and results are merged.
 *
 * Returns the original coordinates unchanged when the API call fails. Note this
 * may return a *truncated* line when the path can't be fully matched (e.g. it
 * leaves the road network) — callers that need to detect that should use
 * `snapToRoadDetailed`.
 */
export async function snapToRoad(
  coordinates: [number, number][],
): Promise<[number, number][]> {
  if (coordinates.length < 2) return coordinates;
  const result = await snapToRoadDetailed(coordinates);
  return result.status === 'failed' ? result.raw : result.snapped;
}

/**
 * Like `snapToRoad`, but reports whether the whole path was matched (`ok`),
 * only partially matched / truncated (`partial`, e.g. a roadless diversion),
 * or couldn't be matched at all (`failed`). Lets the UI warn before silently
 * saving a cut-off shape.
 */
export async function snapToRoadDetailed(
  coordinates: [number, number][],
): Promise<SnapResult> {
  if (coordinates.length < 2) {
    return { status: 'ok', snapped: coordinates, raw: coordinates };
  }

  try {
    const chunks = splitIntoChunks(coordinates, MAX_COORDINATES_PER_REQUEST);
    const results = await Promise.all(chunks.map(callMapMatching));
    const snapped = mergeChunks(results.map((r) => r.coords));
    if (snapped.length < 2) {
      return { status: 'failed', snapped: coordinates, raw: coordinates };
    }
    // Truncated if any chunk's trace was split (gap in the road network / an
    // unlocatable point) or the snapped ends drifted far from the drawn ends.
    const split = results.some((r) => r.split);
    const endpointGap = Math.max(
      haversineMeters(snapped[0], coordinates[0]),
      haversineMeters(snapped[snapped.length - 1], coordinates[coordinates.length - 1]),
    );
    const status: SnapStatus = split || endpointGap > TRUNCATION_THRESHOLD_M ? 'partial' : 'ok';
    return { status, snapped, raw: coordinates };
  } catch {
    return { status: 'failed', snapped: coordinates, raw: coordinates };
  }
}

function splitIntoChunks(
  coords: [number, number][],
  maxSize: number,
): [number, number][][] {
  if (coords.length <= maxSize) return [coords];

  const chunks: [number, number][][] = [];
  let start = 0;

  while (start < coords.length) {
    const end = Math.min(start + maxSize, coords.length);
    chunks.push(coords.slice(start, end));
    // Overlap: next chunk starts at last point of current chunk
    start = end - 1;
    // If we've reached the end, stop
    if (end === coords.length) break;
  }

  return chunks;
}

async function callMapMatching(
  coords: [number, number][],
): Promise<{ coords: [number, number][]; split: boolean }> {
  const coordString = coords.map((c) => `${c[0]},${c[1]}`).join(';');
  const url = `https://api.mapbox.com/matching/v5/mapbox/driving/${coordString}?access_token=${MAPBOX_TOKEN}&geometries=geojson&steps=false&overview=full`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Map Matching API returned ${response.status}`);
  }

  const data: MapMatchingResponse = await response.json();

  if (data.code !== 'Ok' || !data.matchings || data.matchings.length === 0) {
    throw new Error(`Map Matching failed: ${data.code}`);
  }

  // The trace was split into multiple matchings (a gap in the road network) or
  // some input points couldn't be located — either way the geometry we keep
  // (matchings[0]) only covers part of the drawn path.
  const split =
    data.matchings.length > 1 ||
    (Array.isArray(data.tracepoints) && data.tracepoints.some((t) => t === null));

  return { coords: data.matchings[0].geometry.coordinates as [number, number][], split };
}

function mergeChunks(chunks: [number, number][][]): [number, number][] {
  if (chunks.length === 0) return [];
  if (chunks.length === 1) return chunks[0];

  const merged: [number, number][] = [...chunks[0]];

  for (let i = 1; i < chunks.length; i++) {
    // Skip the first point of subsequent chunks to avoid duplication
    // at the overlap boundary
    const chunk = chunks[i];
    merged.push(...chunk.slice(1));
  }

  return merged;
}

/**
 * Cumulative great-circle length (metres) of a [lng, lat] polyline. Used to
 * summarise current-vs-snapped shape length in the snap warning so the user can
 * judge how much geometry a truncated snap would drop. Reuses haversineMeters so
 * the measure matches the truncation check above.
 */
export function pathLengthMeters(coords: [number, number][]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += haversineMeters(coords[i - 1], coords[i]);
  }
  return total;
}

/** Great-circle distance in metres between two [lng, lat] points. */
function haversineMeters(a: [number, number], b: [number, number]): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
