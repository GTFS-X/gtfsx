// translations.txt — import → editor → export round-trip, on the real-world
// sample feed (public-transport/sample-gtfs-feed, which ships both translation
// forms, a stop_times record_sub_id, a feed_info row and region-tagged
// languages) and on a synthetic feed with every edge case.
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import Papa from 'papaparse';
import { useStore } from '../../store';
import { importGtfsZip, loadImportIntoStore, mergeImportIntoStore } from '../gtfsImport';
import { exportGtfsZip } from '../gtfsExport';
import { resetEditorState } from '../../db/serverPersistence';
import { featureEnabled } from '../../store/featuresSlice';

const FIXTURE = path.resolve(__dirname, '../../../tests/fixtures/sample-gtfs-feed');

async function fixtureZip(overrides: Record<string, string | null> = {}): Promise<File> {
  const zip = new JSZip();
  for (const f of readdirSync(FIXTURE)) {
    if (!f.endsWith('.txt')) continue;
    if (f in overrides) continue;
    zip.file(f, readFileSync(path.join(FIXTURE, f)));
  }
  for (const [name, body] of Object.entries(overrides)) if (body !== null) zip.file(name, body);
  return (await zip.generateAsync({ type: 'uint8array' })) as unknown as File;
}

async function exportedText(name: string): Promise<string | null> {
  const blob = await exportGtfsZip();
  const zip = await JSZip.loadAsync(new Uint8Array(await blob.arrayBuffer()));
  const f = zip.file(name);
  return f ? f.async('string') : null;
}

const rows = (csv: string) => Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true }).data;

beforeEach(() => resetEditorState());

describe('sample-gtfs-feed translations round-trip', () => {
  it('imports all 13 rows, preserving both forms, record_sub_id and region tags', async () => {
    const data = await importGtfsZip(await fixtureZip());
    expect(data.translations).toHaveLength(13);
    expect(data.translations).toContainEqual({
      table_name: 'stop_times', field_name: 'stop_headsign', language: 'de-DE', translation: 'hAllo',
      record_id: 'b-outbound-on-weekends', record_sub_id: '11',
    });
    expect(data.translations).toContainEqual({
      table_name: 'trips', field_name: 'trip_headsign', language: 'de-DE',
      translation: 'Babbage (auswärts)', field_value: 'Babbage (Outbound)',
    });
  });

  it('turns the Translations feature on for a feed that has them', async () => {
    loadImportIntoStore(await importGtfsZip(await fixtureZip()));
    expect(featureEnabled(useStore.getState(), 'translations')).toBe(true);
  });

  it('exports every row except the feed_publisher_url one (GTFS·X rewrites the publisher)', async () => {
    const original = rows(readFileSync(path.join(FIXTURE, 'translations.txt'), 'utf8'));
    loadImportIntoStore(await importGtfsZip(await fixtureZip()));
    const csv = (await exportedText('translations.txt'))!;
    expect(csv.split(/\r?\n/)[0]).toBe('table_name,field_name,language,translation,record_id,record_sub_id,field_value');
    const out = rows(csv);
    const expected = original.filter((r) => r.field_name !== 'feed_publisher_url');
    expect(out).toEqual(expected);
  });

  it('is stable: export → import → export gives a byte-identical translations.txt', async () => {
    loadImportIntoStore(await importGtfsZip(await fixtureZip()));
    const first = (await exportedText('translations.txt'))!;
    const blob = await exportGtfsZip();
    loadImportIntoStore(await importGtfsZip(new Uint8Array(await blob.arrayBuffer()) as unknown as File));
    expect(await exportedText('translations.txt')).toBe(first);
  });

  it('a feed with no translations.txt exports none (and the feature stays off)', async () => {
    loadImportIntoStore(await importGtfsZip(await fixtureZip({ 'translations.txt': null })));
    expect(useStore.getState().translations).toEqual([]);
    expect(featureEnabled(useStore.getState(), 'translations')).toBe(false);
    expect(await exportedText('translations.txt')).toBeNull();
  });
});

describe('edge cases', () => {
  const TRANSLATIONS = [
    'table_name,field_name,language,translation,record_id,record_sub_id,field_value',
    'stops,stop_name,es,Entrada del aeropuerto,airport-entrance,,',
    'stops,stop_name,es,"Entrada, con coma",airport-1,,',           // quoting survives
    'routes,route_long_name,fr,Ligne Babbage,,,Charles Babbage Tram Line',
    'stops,stop_name,es,Fantasma,no-such-stop,,',                   // dangling → kept, not exported
    'calendar,service_name,es,Fines de semana,on-weekends,,',       // unofficial → kept AND exported
    'attributions,organization_name,es,Autoridad,att-1,,',          // not carried → kept, not exported
    'stops,stop_name,Spanish,Malo,airport-1,,',                     // bad language → not exported
    'stops,stop_name,es,Entrada del aeropuerto,airport-entrance,,', // duplicate → not exported
  ].join('\n');

  it('keeps every row in the editor, exports only the valid + unofficial ones', async () => {
    loadImportIntoStore(await importGtfsZip(await fixtureZip({ 'translations.txt': TRANSLATIONS })));
    expect(useStore.getState().translations).toHaveLength(8);
    const out = rows((await exportedText('translations.txt'))!);
    expect(out.map((r) => r.translation)).toEqual([
      'Entrada del aeropuerto', 'Entrada, con coma', 'Ligne Babbage', 'Fines de semana',
    ]);
  });

  it('omits the reference columns no exported row uses', async () => {
    const onlyRecord = [
      'table_name,field_name,language,translation,record_id,record_sub_id,field_value',
      'stops,stop_name,es,Entrada,airport-entrance,,',
    ].join('\n');
    loadImportIntoStore(await importGtfsZip(await fixtureZip({ 'translations.txt': onlyRecord })));
    const csv = (await exportedText('translations.txt'))!;
    expect(csv.split(/\r?\n/)[0]).toBe('table_name,field_name,language,translation,record_id');
  });

  it('an editor-authored translation exports', async () => {
    loadImportIntoStore(await importGtfsZip(await fixtureZip({ 'translations.txt': null })));
    useStore.getState().upsertTranslation({
      table_name: 'stops', field_name: 'stop_name', language: 'es', translation: 'Entrada', record_id: 'airport-entrance',
    });
    expect(rows((await exportedText('translations.txt'))!)).toEqual([{
      table_name: 'stops', field_name: 'stop_name', language: 'es', translation: 'Entrada', record_id: 'airport-entrance',
    }]);
  });
});

describe('merge import ("Import from another feed") carries translations', () => {
  it('re-keys record translations of the merged routes/trips to their prefixed ids', async () => {
    const data = await importGtfsZip(await fixtureZip());
    // Open the same feed, then merge route B from it again → every id collides,
    // so the merged copy is prefixed.
    loadImportIntoStore(data);
    const before = useStore.getState().translations.length;
    mergeImportIntoStore(data, new Set(['B']));
    const st = useStore.getState();
    const added = st.translations.slice(before);
    expect(added.length).toBeGreaterThan(0);
    const routeDesc = added.find((t) => t.table_name === 'routes' && t.field_name === 'route_desc');
    expect(routeDesc?.record_id).toMatch(/^i\d+_B$/);
    expect(st.routes.some((r) => r.route_id === routeDesc!.record_id)).toBe(true);
    const stopTime = added.find((t) => t.table_name === 'stop_times');
    expect(stopTime?.record_id).toMatch(/^i\d+_b-outbound-on-weekends$/);
    // By-value rows aren't duplicated (the open feed already has them).
    expect(added.some((t) => t.field_value)).toBe(false);
  });
});
