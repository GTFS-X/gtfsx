export interface BlockGroupData {
  geoid: string;
  population: number;
  households: number;
  workers: number;
  lat: number;
  lon: number;
}

interface TigerFeature {
  attributes: {
    GEOID: string;
    CENTLAT: string;
    CENTLON: string;
    AREALAND: number;
  };
}

interface TigerResponse {
  features?: TigerFeature[];
  exceededTransferLimit?: boolean;
}

/**
 * Fetch block group centroids from TIGERweb for a given state+county.
 * Returns a map from GEOID to { lat, lon }.
 */
async function fetchBlockGroupCentroids(
  stateFips: string,
  countyFips: string,
): Promise<Map<string, { lat: number; lon: number }>> {
  const centroids = new Map<string, { lat: number; lon: number }>();
  let offset = 0;
  const batchSize = 5000;

  // Paginate through results
  for (;;) {
    const url =
      `https://tigerweb.geo.census.gov/arcrest/rest/services/TIGERweb/tigerWMS_ACS2023/MapServer/10/query` +
      `?where=STATE='${stateFips}' AND COUNTY='${countyFips}'` +
      `&outFields=GEOID,CENTLAT,CENTLON,AREALAND` +
      `&f=json` +
      `&resultRecordCount=${batchSize}` +
      `&resultOffset=${offset}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`TIGERweb request failed: ${res.status}`);

    const data: TigerResponse = await res.json();
    if (!data.features || data.features.length === 0) break;

    for (const feat of data.features) {
      const { GEOID, CENTLAT, CENTLON } = feat.attributes;
      centroids.set(GEOID, {
        lat: parseFloat(CENTLAT),
        lon: parseFloat(CENTLON),
      });
    }

    if (!data.exceededTransferLimit) break;
    offset += batchSize;
  }

  return centroids;
}

/**
 * Fetch Census ACS5 block-group-level demographic data for a state+county,
 * merged with TIGERweb centroids.
 */
export async function fetchCensusData(
  stateFips: string,
  countyFips: string,
): Promise<BlockGroupData[]> {
  // Fetch centroids and census data concurrently
  const [centroids, censusRes] = await Promise.all([
    fetchBlockGroupCentroids(stateFips, countyFips),
    fetch(
      `https://api.census.gov/data/2023/acs/acs5?get=B01003_001E,B25001_001E,B08301_001E` +
        `&for=block%20group:*&in=state:${stateFips}&in=county:${countyFips}&in=tract:*`,
    ),
  ]);

  if (!censusRes.ok) throw new Error(`Census API request failed: ${censusRes.status}`);

  const rows: string[][] = await censusRes.json();
  // First row is header
  const header = rows[0];
  const stateIdx = header.indexOf('state');
  const countyIdx = header.indexOf('county');
  const tractIdx = header.indexOf('tract');
  const bgIdx = header.indexOf('block group');

  const results: BlockGroupData[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const geoid =
      row[stateIdx] + row[countyIdx] + row[tractIdx] + row[bgIdx];

    const centroid = centroids.get(geoid);
    if (!centroid) continue; // skip if we can't locate this block group

    results.push({
      geoid,
      population: parseInt(row[0], 10) || 0,
      households: parseInt(row[1], 10) || 0,
      workers: parseInt(row[2], 10) || 0,
      lat: centroid.lat,
      lon: centroid.lon,
    });
  }

  return results;
}

/**
 * Look up state + county FIPS codes for a lat/lon using the FCC Area API.
 */
export async function lookupFips(
  lat: number,
  lon: number,
): Promise<{ stateFips: string; countyFips: string }> {
  const res = await fetch(
    `https://geo.fcc.gov/api/census/area?lat=${lat}&lon=${lon}&format=json`,
  );
  if (!res.ok) throw new Error(`FCC Area API request failed: ${res.status}`);

  const data = await res.json();
  const result = data.results?.[0];
  if (!result) throw new Error('No FIPS results found for the given coordinates');

  return {
    stateFips: result.state_fips as string,
    countyFips: result.county_fips as string,
  };
}
