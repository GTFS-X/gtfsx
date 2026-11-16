// Unmodelled files and columns round-trip: import → editor → export.
//
// Files the editor doesn't model (calendar_attributes.txt, realtime_routes.txt,
// a binary attachment…) are kept verbatim and written back byte for byte; on
// the one-row-per-entity files, columns the editor doesn't model are kept per
// row. The modeled data always wins over a kept copy.
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import Papa from 'papaparse';
import { useStore } from '../../store';
import { importGtfsZip, loadImportIntoStore } from '../gtfsImport';
import { exportGtfsZip } from '../gtfsExport';
import { resetEditorState } from '../../db/serverPersistence';
import {
  encodePassthroughFile, isWritablePassthrough, passthroughBytes, type PassthroughFile,
} from '../feedPassthrough';

const FIXTURE = path.resolve(__dirname, '../../../tests/fixtures/sample-gtfs-feed');

const CAL_ATTRS = 'service_id,service_description\r\nWeekdays,"Mon–Fri, ünïcode"\r\n';
const RT_ROUTES = 'route_id,realtime_enabled\nA,1\nB,0\n';
// Not valid UTF-8 — must survive as bytes, not as text.
const BINARY = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x80, 0xc3]);
// A UTF-8 byte-order mark must not be stripped.
const BOM_TEXT = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('a,b\n1,2\n')]);

async function fixtureZip(
  extra: Record<string, string | Uint8Array | null> = {},
  folder = '',
): Promise<File> {
  const zip = new JSZip();
  for (const f of readdirSync(FIXTURE)) {
    if (!f.endsWith('.txt') || f in extra) continue;
    zip.file(folder + f, readFileSync(path.join(FIXTURE, f)));
  }
  for (const [name, body] of Object.entries(extra)) if (body !== null) zip.file(folder + name, body);
  return (await zip.generateAsync({ type: 'uint8array' })) as unknown as File;
}

async function exported(): Promise<JSZip> {
  const blob = await exportGtfsZip();
  return JSZip.loadAsync(new Uint8Array(await blob.arrayBuffer()));
}

const rows = (csv: string) => Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });

beforeEach(() => resetEditorState());

describe('unmodelled files are kept verbatim', () => {
  const extras = {
    'calendar_attributes.txt': CAL_ATTRS,
    'realtime_routes.txt': RT_ROUTES,
    'docs/logo.png': BINARY,
    'bom.txt': BOM_TEXT,
    '.DS_Store': 'junk',
    '__MACOSX/._stops.txt': 'junk',
    'Thumbs.db': 'junk',
  };

  it('import keeps them (and drops OS clutter), export writes them back byte-identical', async () => {
    const data = await importGtfsZip(await fixtureZip(extras));
    expect(data.passthroughFiles.map((f) => f.name).sort()).toEqual(
      ['bom.txt', 'calendar_attributes.txt', 'docs/logo.png', 'realtime_routes.txt'],
    );
    expect(data.passthroughFiles.find((f) => f.name === 'docs/logo.png')!.encoding).toBe('base64');
    expect(data.passthroughFiles.find((f) => f.name === 'realtime_routes.txt')!.encoding).toBe('utf8');

    loadImportIntoStore(data);
    const zip = await exported();
    for (const name of ['calendar_attributes.txt', 'realtime_routes.txt', 'docs/logo.png', 'bom.txt'] as const) {
      const want = typeof extras[name] === 'string'
        ? new TextEncoder().encode(extras[name] as string)
        : (extras[name] as Uint8Array);
      expect(zip.file(name), name).not.toBeNull();
      expect(await zip.file(name)!.async('uint8array'), name).toEqual(want);
    }
    expect(zip.file('.DS_Store')).toBeNull();
    expect(zip.file('Thumbs.db')).toBeNull();
    expect(zip.file(/__MACOSX/)).toHaveLength(0);
  });

  it('the import notice says they are kept, not dropped', async () => {
    const data = await importGtfsZip(await fixtureZip(extras));
    const notice = data.warnings.find((w) => w.includes('calendar_attributes.txt'))!;
    expect(notice).toMatch(/kept unchanged in exports/);
    expect(notice).not.toMatch(/will not be included/);
  });

  it('a feed nested in a subfolder keeps its extra files beside the flattened standard ones', async () => {
    const data = await importGtfsZip(await fixtureZip({ 'calendar_attributes.txt': CAL_ATTRS }, 'myfeed/'));
    expect(data.passthroughFiles.map((f) => f.name)).toEqual(['calendar_attributes.txt']);
    loadImportIntoStore(data);
    const zip = await exported();
    expect(zip.file('stops.txt')).not.toBeNull();
    expect(await zip.file('calendar_attributes.txt')!.async('string')).toBe(CAL_ATTRS);
  });

  it('a feed with no extra files has none, and exports nothing extra', async () => {
    const data = await importGtfsZip(await fixtureZip());
    expect(data.passthroughFiles).toEqual([]);
    loadImportIntoStore(data);
    const zip = await exported();
    const names = Object.keys(zip.files);
    expect(names.every((n) => n.endsWith('.txt') || n.endsWith('.geojson'))).toBe(true);
  });
});

describe('the modeled data wins over a kept copy', () => {
  it('never writes a kept file over, or in place of, a file the editor models', async () => {
    loadImportIntoStore(await importGtfsZip(await fixtureZip()));
    const enc = (name: string, text: string) => encodePassthroughFile(name, new TextEncoder().encode(text));
    useStore.getState().setPassthroughFiles([
      enc('stops.txt', 'stop_id\nIMPOSTOR\n'),        // collides with a written file
      enc('fare_media.txt', 'fare_media_id\nSTALE\n'), // modeled, but this feed has none
      enc('nested/agency.txt', 'agency_id\nSTALE\n'), // modeled name in a folder
      enc('notes.txt', 'kept'),
    ]);
    const zip = await exported();
    expect(await zip.file('stops.txt')!.async('string')).not.toContain('IMPOSTOR');
    expect(zip.file('fare_media.txt')).toBeNull();
    expect(zip.file('nested/agency.txt')).toBeNull();
    expect(await zip.file('notes.txt')!.async('string')).toBe('kept');
  });

  it('skips malformed or unsafe stored entries instead of throwing', async () => {
    loadImportIntoStore(await importGtfsZip(await fixtureZip()));
    useStore.getState().setPassthroughFiles([
      { name: '../escape.txt', encoding: 'utf8', data: 'x' },
      { name: '/abs.txt', encoding: 'utf8', data: 'x' },
      { name: 'ok.txt', encoding: 'nope', data: 'x' } as unknown as PassthroughFile,
      null as unknown as PassthroughFile,
      { name: 'fine.txt', encoding: 'utf8', data: 'y' },
    ]);
    const zip = await exported();
    expect(Object.keys(zip.files).filter((n) => /escape|abs|ok\.txt/.test(n))).toEqual([]);
    expect(await zip.file('fine.txt')!.async('string')).toBe('y');
  });
});

describe('encodePassthroughFile', () => {
  it('round-trips arbitrary bytes exactly', () => {
    for (const bytes of [BINARY, BOM_TEXT, new Uint8Array(0), new TextEncoder().encode('plain\r\n')]) {
      const f = encodePassthroughFile('x', bytes);
      expect(isWritablePassthrough(f)).toBe(true);
      expect(passthroughBytes(JSON.parse(JSON.stringify(f)))).toEqual(bytes);
    }
  });
});

describe('unmodelled columns are kept per row', () => {
  const withColumns = async () => {
    const zip = new JSZip();
    for (const f of readdirSync(FIXTURE)) {
      if (f.endsWith('.txt')) zip.file(f, readFileSync(path.join(FIXTURE, f), 'utf8'));
    }
    // Add a custom column to stops / routes / trips / stop_times / agency.
    const addCol = (file: string, col: string, value: (r: Record<string, string>, i: number) => string) => {
      const parsed = rows(readFileSync(path.join(FIXTURE, file), 'utf8'));
      const data = parsed.data.map((r, i) => ({ ...r, [col]: value(r, i) }));
      zip.file(file, Papa.unparse(data, { columns: [...parsed.meta.fields!, col] }));
    };
    addCol('stops.txt', 'tts_stop_name', (r) => `say ${r.stop_id}`);
    addCol('routes.txt', 'x_route_rank', (_r, i) => String(i + 1));
    addCol('stop_times.txt', 'x_custom', (_r, i) => (i === 0 ? 'first' : ''));
    addCol('agency.txt', 'x_agency_note', () => 'note');
    return (await zip.generateAsync({ type: 'uint8array' })) as unknown as File;
  };

  // The sample feed already ships standard columns the editor doesn't model
  // (routes.route_sort_order, trips.bikes_allowed); those ride the same path.
  it('re-emits them on export and reports them as kept', async () => {
    const data = await importGtfsZip(await withColumns());
    expect(data.warnings.find((w) => w.startsWith('stops.txt: column tts_stop_name'))).toMatch(/kept unchanged in exports/);
    loadImportIntoStore(data);
    const zip = await exported();
    const stops = rows(await zip.file('stops.txt')!.async('string')).data;
    expect(stops.every((s) => s.tts_stop_name === `say ${s.stop_id}`)).toBe(true);
    const routes = rows(await zip.file('routes.txt')!.async('string')).data;
    expect(routes.map((r) => r.x_route_rank)).toEqual(routes.map((_r, i) => String(i + 1)));
    const srcRoutes = rows(readFileSync(path.join(FIXTURE, 'routes.txt'), 'utf8')).data;
    expect(routes.map((r) => r.route_sort_order)).toEqual(srcRoutes.map((r) => r.route_sort_order));
    const trips = rows(await zip.file('trips.txt')!.async('string')).data;
    const srcTrips = rows(readFileSync(path.join(FIXTURE, 'trips.txt'), 'utf8')).data;
    expect(trips.map((t) => t.bikes_allowed)).toEqual(srcTrips.map((t) => t.bikes_allowed));
    const st = rows(await zip.file('stop_times.txt')!.async('string'));
    expect(st.meta.fields).toContain('x_custom');
    expect(st.data.filter((r) => r.x_custom === 'first')).toHaveLength(1);
    const agency = rows(await zip.file('agency.txt')!.async('string')).data;
    expect(agency[0].x_agency_note).toBe('note');
  });

  it('new rows get blank cells, deleted rows take theirs, renamed trips keep theirs', async () => {
    loadImportIntoStore(await importGtfsZip(await withColumns()));
    const s = useStore.getState();
    const [gone, kept] = s.stops;
    s.removeStop(gone.stop_id);
    s.addStop({ stop_id: 'NEW', stop_name: 'New', stop_lat: 1, stop_lon: 1, location_type: 0, wheelchair_boarding: 0 });
    const trip = s.trips.find((t) => t._extra?.bikes_allowed)!;
    s.renameTripId(trip.trip_id, 'RENAMED');

    const zip = await exported();
    const stops = rows(await zip.file('stops.txt')!.async('string')).data;
    expect(stops.find((x) => x.stop_id === gone.stop_id)).toBeUndefined();
    expect(stops.find((x) => x.stop_id === kept.stop_id)!.tts_stop_name).toBe(`say ${kept.stop_id}`);
    expect(stops.find((x) => x.stop_id === 'NEW')!.tts_stop_name).toBe('');
    const trips = rows(await zip.file('trips.txt')!.async('string')).data;
    expect(trips.find((t) => t.trip_id === 'RENAMED')!.bikes_allowed).toBe(trip._extra!.bikes_allowed);
  });

  it('a column the editor models wins over a stale kept copy', async () => {
    loadImportIntoStore(await importGtfsZip(await fixtureZip()));
    const s = useStore.getState();
    const id = s.stops[0].stop_id;
    s.updateStop(id, { platform_code: 'G', _extra: { platform_code: 'STALE', stop_name: 'STALE' } });
    const zip = await exported();
    const row = rows(await zip.file('stops.txt')!.async('string')).data.find((x) => x.stop_id === id)!;
    expect(row.platform_code).toBe('G');
    expect(row.stop_name).not.toBe('STALE');
  });

  it('platform_code is modeled: imported, editable, exported', async () => {
    // The sample feed's stops.txt carries a platform_code column.
    const parsed = rows(readFileSync(path.join(FIXTURE, 'stops.txt'), 'utf8'));
    const csv = Papa.unparse(parsed.data.map((r, i) => ({ ...r, platform_code: i === 0 ? '3' : r.platform_code })),
      { columns: parsed.meta.fields! });
    const data = await importGtfsZip(await fixtureZip({ 'stops.txt': csv }));
    expect(data.warnings.some((w) => w.includes('platform_code'))).toBe(false);
    expect(data.stops[0].platform_code).toBe('3');
    expect(data.stops[0]._extra).toBeUndefined();
    loadImportIntoStore(data);
    const out = rows(await (await exported()).file('stops.txt')!.async('string')).data;
    expect(out[0].platform_code).toBe('3');
  });

  it('a file without custom columns adds no _extra key to its entities', async () => {
    const data = await importGtfsZip(await fixtureZip());
    for (const list of [data.stops, data.stopTimes, data.agencies, data.calendars, data.calendarDates]) {
      expect(list.some((e) => '_extra' in e)).toBe(false);
    }
  });
});
