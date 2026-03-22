const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;
const MAX_COORDINATES_PER_REQUEST = 100;

interface MapMatchingResponse {
  matchings?: Array<{
    geometry: {
      type: 'LineString';
      coordinates: [number, number][];
    };
  }>;
  code: string;
}

/**
 * Snap an array of [lng, lat] coordinates to the nearest road using
 * the Mapbox Map Matching API. If the input exceeds the API limit of
 * 100 coordinates, the array is split into overlapping chunks and
 * results are merged.
 *
 * Returns the original coordinates unchanged when the API call fails.
 */
export async function snapToRoad(
  coordinates: [number, number][],
): Promise<[number, number][]> {
  if (coordinates.length < 2) return coordinates;

  try {
    const chunks = splitIntoChunks(coordinates, MAX_COORDINATES_PER_REQUEST);
    const results = await Promise.all(chunks.map(callMapMatching));
    return mergeChunks(results);
  } catch {
    return coordinates;
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
): Promise<[number, number][]> {
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

  return data.matchings[0].geometry.coordinates as [number, number][];
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
