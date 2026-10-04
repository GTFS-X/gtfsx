// Import/export fidelity fixes: per-shape patterns (S1-03), anchored file
// lookup (S1-04), transfers 4/5 + qualifiers (S1-05), blank timepoint (S1-06),
// coordinate-less nodes (S1-07), dropped-column/file warnings (S1-08), CSV parse
// errors (S1-09), publisher flex routes (S1-10), O(n) shape distances (S1-27).
import { beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import Papa from 'papaparse';
import length from '@turf/length';
import { lineString } from '@turf/helpers';
import { useStore } from '../../store';
import { importGtfsZip } from '../gtfsParse';
import { loadImportIntoStore } from '../gtfsImport';
import { exportGtfsZip } from '../gtfsExport';
import { runValidation } from '../validation';
import { backfillMissingRouteStops } from '../routeStopMigration';
import { fillShapeDistances } from '../shapeDistance';
import type { RouteStop, ShapePoint, StopTime, Trip } from '../../types/gtfs';

type Row = Record<string, string>;
type Files = Record<string, string>;

const BASE: Files = {
  'agency.txt': 'agency_id,agency_name,agency_url,agency_timezone\nA,Agency,https://x.test,America/Denver\n',
  'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWK,1,1,1,1,1,0,0,20260101,20261231\n',
  'routes.txt': 'route_id,agency_id,route_short_name,route_long_name,route_type\nR,A,1,One,3\n',
  'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon\nP1,P1,45,-111\nP2,P2,45.01,-111\nP3,P3,45.02,-111\nP4,P4,45.03,-111\n',
};

async function zipOf(files: Files): Promise<File> {
  const zip = new JSZip();
  for (const [name, body] of Object.entries(files)) zip.file(name, body);
  return (await zip.generateAsync({ type: 'uint8array' })) as unknown as File;
}

async function exportedRows(name: string): Promise<Row[]> {
  const zip = await JSZip.loadAsync(await (await exportGtfsZip()).arrayBuffer());
  const f = zip.file(name);
  if (!f) return [];
  return Papa.parse<Row>(await f.async('string'), { header: true, skipEmptyLines: true }).data;
}

beforeEach(() => {
  useStore.getState().setFlexZones([]);
});

describe('S1-03 one pattern per (route, direction, shape)', () => {
  const files: Files = {
    ...BASE,
    'trips.txt': 'route_id,service_id,trip_id,direction_id,shape_id\nR,WK,T1,0,SA\nR,WK,T2,0,SB\n',
    'stop_times.txt': [
      'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
      'T1,08:00:00,08:00:00,P1,1', 'T1,08:05:00,08:05:00,P2,2', 'T1,08:10:00,08:10:00,P3,3',
      'T2,09:00:00,09:00:00,P1,1', 'T2,09:05:00,09:05:00,P2,2', 'T2,09:08:00,09:08:00,P4,3', 'T2,09:12:00,09:12:00,P3,4',
    ].join('\n'),
  };

  it('SA gets 3 route stops, SB gets 4 (incl. P4@3), and SA has no seq 4', async () => {
    const r = await importGtfsZip(await zipOf(files));
    const sa = r.routeStops.filter((rs) => rs.shape_id === 'SA').map((rs) => `${rs.stop_id}@${rs.stop_sequence}`);
    const sb = r.routeStops.filter((rs) => rs.shape_id === 'SB').map((rs) => `${rs.stop_id}@${rs.stop_sequence}`);
    expect(sa).toEqual(['P1@1', 'P2@2', 'P3@3']);
    expect(sb).toEqual(['P1@1', 'P2@2', 'P4@3', 'P3@4']);
  });

  it('backfill never files a shaped trip under another shape', () => {
    const rs: RouteStop[] = [1, 2, 3].map((n) => ({ route_id: 'R', stop_id: `P${n}`, direction_id: 0, stop_sequence: n, _snapped: true, shape_id: 'SA' }));
    const trips: Trip[] = [{ trip_id: 'T2', route_id: 'R', service_id: 'WK', direction_id: 0, shape_id: 'SB' }];
    const st: StopTime[] = [1, 2, 3, 4].map((n) => ({ trip_id: 'T2', stop_id: `P${n}`, stop_sequence: n, arrival_time: '', departure_time: '' }));
    expect(backfillMissingRouteStops(rs, trips, st)).toBe(rs);
  });
});

describe('S1-04 anchored optional-file lookup', () => {
  it('route_networks.txt / stop_areas.txt are not read as networks.txt / areas.txt', async () => {
    const r = await importGtfsZip(await zipOf({
      ...BASE,
      'route_networks.txt': 'network_id,route_id\nN1,R\nN1,R2\n',
      'stop_areas.txt': 'area_id,stop_id\nAR,P1\n',
    }));
    expect(r.fareNetworks).toEqual([]);
    expect(r.fareAreas).toEqual([]);
    expect(r.routeNetworks).toHaveLength(2);
  });

  it('a nested feed/networks.txt is still found, and __MACOSX copies are ignored', async () => {
    const nested: Files = {};
    for (const [k, v] of Object.entries(BASE)) nested[`feed/${k}`] = v;
    nested['feed/networks.txt'] = 'network_id,network_name\nN1,Net\n';
    nested['__MACOSX/feed/._networks.txt'] = 'garbage';
    nested['__MACOSX/feed/networks.txt'] = 'network_id,network_name\nBAD,Bad\n';
    const r = await importGtfsZip(await zipOf(nested));
    expect(r.fareNetworks.map((n) => n.network_id)).toEqual(['N1']);
    expect(r.stops).toHaveLength(4);
  });
});

describe('S1-05 transfers.txt in-seat and qualified rows', () => {
  it('round-trips a type-4 trip-to-trip row and a route-qualified row', async () => {
    const r = await importGtfsZip(await zipOf({
      ...BASE,
      'trips.txt': 'route_id,service_id,trip_id,direction_id\nR,WK,T1,0\nR,WK,T2,0\n',
      'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,08:00:00,08:00:00,P1,1\nT1,08:10:00,08:10:00,P2,2\nT2,08:20:00,08:20:00,P2,1\nT2,08:30:00,08:30:00,P3,2\n',
      'transfers.txt': 'from_stop_id,to_stop_id,from_route_id,to_route_id,from_trip_id,to_trip_id,transfer_type,min_transfer_time\n,,,,T1,T2,4,\nP1,P2,R,R,,,2,120\n',
    }));
    expect(r.transfers).toHaveLength(2);
    loadImportIntoStore(r);
    const rows = await exportedRows('transfers.txt');
    const inSeat = rows.find((x) => x.transfer_type === '4')!;
    expect(inSeat).toMatchObject({ from_stop_id: '', to_stop_id: '', from_trip_id: 'T1', to_trip_id: 'T2' });
    const routeQ = rows.find((x) => x.transfer_type === '2')!;
    expect(routeQ).toMatchObject({ from_stop_id: 'P1', to_stop_id: 'P2', from_route_id: 'R', to_route_id: 'R', min_transfer_time: '120' });
  });
});

describe('S1-06 / S1-07 blank timepoint and coordinate-less nodes', () => {
  const files: Files = {
    ...BASE,
    'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\nST,Station,45,-111,1,\nP1,P1,45,-111,0,ST\nP2,P2,45.01,-111,0,\nN1,,,,3,ST\n',
    'trips.txt': 'route_id,service_id,trip_id,direction_id\nR,WK,T1,0\n',
    'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence,timepoint\nT1,08:00:00,08:00:00,P1,1,\nT1,08:10:00,08:10:00,P2,2,\n',
  };

  it('blank timepoint stays blank through import and export', async () => {
    const r = await importGtfsZip(await zipOf(files));
    expect(r.stopTimes.map((s) => s.timepoint)).toEqual([undefined, undefined]);
    loadImportIntoStore(r);
    const rows = await exportedRows('stop_times.txt');
    expect(rows.every((x) => (x.timepoint ?? '') === '')).toBe(true);
  });

  it('a type-3 node with blank coordinates exports blank and is not a coordinate error', async () => {
    loadImportIntoStore(await importGtfsZip(await zipOf(files)));
    const node = (await exportedRows('stops.txt')).find((s) => s.stop_id === 'N1')!;
    expect(node.stop_lat).toBe('');
    expect(node.stop_lon).toBe('');
    expect(runValidation(useStore.getState()).some((m) => /invalid coordinates/.test(m.message))).toBe(false);
  });

  it('a stop on the prime meridian (lon 0) is valid; 0,0 on a platform is not', () => {
    const s = useStore.getState();
    s.setStops([
      { stop_id: 'G', stop_name: 'Greenwich', stop_lat: 51.48, stop_lon: 0, location_type: 0, wheelchair_boarding: 0 },
      { stop_id: 'Z', stop_name: 'Null', stop_lat: 0, stop_lon: 0, location_type: 0, wheelchair_boarding: 0 },
    ]);
    const bad = runValidation(useStore.getState()).filter((m) => /invalid coordinates/.test(m.message)).map((m) => m.entity_id);
    expect(bad).toEqual(['Z']);
  });
});

describe('S1-08 / S1-09 import warnings', () => {
  it('names dropped columns and unsupported files', async () => {
    const r = await importGtfsZip(await zipOf({
      ...BASE,
      'routes.txt': 'route_id,agency_id,route_short_name,route_long_name,route_type,route_sort_order\nR,A,1,One,3,7\n',
      'attributions.txt': 'attribution_id,organization_name\nX,Org\n',
    }));
    expect(r.warnings.some((w) => w.includes('routes.txt') && w.includes('route_sort_order'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('attributions.txt'))).toBe(true);
  });

  it('an unbalanced quote produces a warning naming stops.txt', async () => {
    const r = await importGtfsZip(await zipOf({
      ...BASE,
      'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon\n1,"Main St,45,-111\n2,Second,45.01,-111\n',
    }));
    expect(r.warnings.some((w) => w.includes('stops.txt') && /quote/i.test(w))).toBe(true);
  });

  it('a clean feed has no such warnings', async () => {
    const r = await importGtfsZip(await zipOf(BASE));
    expect(r.warnings).toEqual([]);
  });
});

describe('S1-10 a publisher flex route survives a round trip', () => {
  it('route id, colour and zone.routeId are unchanged after export → import → export', async () => {
    const s = useStore.getState();
    s.setAgencies([{ agency_id: 'A', agency_name: 'A', agency_url: 'https://x.test', agency_timezone: 'America/Denver' }]);
    s.setCalendars([{ service_id: 'WK', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0, start_date: '20260101', end_date: '20261231' }]);
    s.setCalendarDates([]);
    s.setRoutes([{ route_id: 'DAR', agency_id: 'A', route_short_name: 'DAR', route_long_name: 'Dial-a-Ride', route_type: 715, route_color: '00AA55', route_text_color: 'FFFFFF', route_url: 'https://x.test/dar' }]);
    s.setTrips([]); s.setStopTimes([]); s.setStops([]); s.setRouteStops([]); s.setTransfers([]);
    s.setFlexZones([{
      id: 'zone', name: 'Zone', bufferMiles: 0, serviceId: 'WK', routeId: 'DAR',
      pickupWindowStart: '06:00:00', pickupWindowEnd: '18:00:00',
      geojson: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-111, 45], [-111, 45.05], [-110.95, 45.05], [-111, 45]]] } }] },
    } as never]);
    const first = await exportGtfsZip();
    const r = await importGtfsZip(new Uint8Array(await first.arrayBuffer()) as unknown as File);
    const route = r.routes.find((x) => x.route_id === 'DAR');
    expect(route?.route_color).toBe('00AA55');
    expect(r.flexZones[0].routeId).toBe('DAR');
    loadImportIntoStore(r);
    const routes = await exportedRows('routes.txt');
    expect(routes.map((x) => x.route_id)).toEqual(['DAR']);
    expect(routes[0].route_url).toBe('https://x.test/dar');
    useStore.getState().setFlexZones([]);
  });
});

describe('S1-27 O(n) shape distances', () => {
  const shape = (n: number): ShapePoint[] => Array.from({ length: n }, (_, i) => ({
    shape_pt_lat: 45 + i * 1e-4, shape_pt_lon: -111 + Math.sin(i / 50) * 1e-3, shape_pt_sequence: i, shape_dist_traveled: 0,
  }));

  it('matches measuring the polyline up to each point', () => {
    const pts = fillShapeDistances(shape(300));
    const coords = pts.map((p) => [p.shape_pt_lon, p.shape_pt_lat]);
    for (const i of [1, 17, 150, 299]) {
      expect(pts[i].shape_dist_traveled).toBeCloseTo(length(lineString(coords.slice(0, i + 1)), { units: 'meters' }), 6);
    }
  });

  it('handles a 20k-point shape quickly', () => {
    const pts = shape(20_000);
    const t0 = performance.now();
    fillShapeDistances(pts);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(pts[19_999].shape_dist_traveled).toBeGreaterThan(0);
  });
});
