// E2E E2: route A has fixed trips with no trip_headsign plus a flex trip with
// headsign "Ada Flex". Without directions.txt, the parser's direction-name
// fallback picked the flex trip's headsign as Direction 0's name, and the
// export then filled the fixed trips' blank headsigns with "Ada Flex".
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { importGtfsZip } from '../gtfsParse';

const csv = (rows: string[]) => rows.join('\n') + '\n';

async function mixedFeed(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('agency.txt', csv(['agency_id,agency_name,agency_url,agency_timezone', 'A,Ada Transit,https://x.test,America/Boise']));
  zip.file('calendar.txt', csv([
    'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date',
    'wk,1,1,1,1,1,0,0,20260101,20261231',
  ]));
  zip.file('stops.txt', csv([
    'stop_id,stop_name,stop_lat,stop_lon',
    's1,One,43.60,-116.20',
    's2,Two,43.61,-116.21',
  ]));
  zip.file('routes.txt', csv(['route_id,agency_id,route_short_name,route_long_name,route_type', 'a,A,A,Route A,3']));
  zip.file('trips.txt', csv([
    'route_id,service_id,trip_id,trip_headsign,direction_id',
    'a,wk,a-fixed-1,,0',
    'a,wk,a-fixed-2,,0',
    'a,wk,a-flex-1,Ada Flex,0',
  ]));
  zip.file('stop_times.txt', csv([
    'trip_id,arrival_time,departure_time,stop_id,location_id,stop_sequence,start_pickup_drop_off_window,end_pickup_drop_off_window,pickup_type,drop_off_type',
    'a-fixed-1,08:00:00,08:00:00,s1,,1,,,,',
    'a-fixed-1,08:10:00,08:10:00,s2,,2,,,,',
    'a-fixed-2,09:00:00,09:00:00,s1,,1,,,,',
    'a-fixed-2,09:10:00,09:10:00,s2,,2,,,,',
    'a-flex-1,,,,fz,1,07:00:00,19:00:00,2,1',
    'a-flex-1,,,,fz,2,07:00:00,19:00:00,1,2',
  ]));
  zip.file('locations.geojson', JSON.stringify({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      id: 'fz',
      properties: { stop_name: 'Ada zone' },
      geometry: { type: 'Polygon', coordinates: [[[-116.3, 43.5], [-116.3, 43.7], [-116.1, 43.7], [-116.1, 43.5], [-116.3, 43.5]]] },
    }],
  }));
  return zip.generateAsync({ type: 'uint8array' });
}

describe('direction-name fallback on a mixed fixed + flex route', () => {
  it("does not take the flex trip's headsign for the fixed direction", async () => {
    const parsed = await importGtfsZip((await mixedFeed()) as unknown as File);
    const route = parsed.routes.find((r) => r.route_id === 'a')!;
    expect(route._direction_0_name).not.toBe('Ada Flex');
    const fixed = parsed.trips.filter((t) => t.trip_id.startsWith('a-fixed'));
    expect(fixed).toHaveLength(2);
    for (const t of fixed) expect(t.trip_headsign ?? '').toBe('');
  });
});
