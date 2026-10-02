#!/usr/bin/env node
/**
 * svt-demo translations — the source of truth for the Spanish translations
 * the published demo feed (svt-demo) carries to exemplify translations.txt.
 *
 * The demo feed is a server project (`/demo` loads
 * https://feeds.gtfsx.com/svt-demo/gtfs.zip), so it can't be rebuilt from the
 * repo. This script holds the rows, checks them against the CURRENT published
 * feed, and prints the one-paste browser-console snippet that applies them to
 * the svt-demo project in the editor (lossless: it only touches translations
 * and feed info — no re-import, so editor-only state like shape names and
 * service alerts is untouched).
 *
 *   node scripts/demo-feed/svt-demo-translations.mjs            # check + print snippet
 *   node scripts/demo-feed/svt-demo-translations.mjs --zip out.zip
 *        # also write the published feed + translations.txt to out.zip, to preview
 *        # in a scratch project (Import → Replace) before touching svt-demo
 *   node scripts/demo-feed/svt-demo-translations.mjs --feed local.zip   # check a local zip
 *
 * Applying (needs Mark's account): open the svt-demo project in the editor,
 * paste the printed snippet into the devtools console, check Translations in
 * the left rail and Validation (no translation warnings), Save, then Publish.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import JSZip from 'jszip';
import Papa from 'papaparse';

const FEED_URL = 'https://feeds.gtfsx.com/svt-demo/gtfs.zip';
const LANG = 'es';

/** @type {{table_name:string, field_name:string, language:string, translation:string, record_id?:string, record_sub_id?:string, field_value?:string}[]} */
export const TRANSLATIONS = [
  // agency.txt — by record
  { table_name: 'agency', field_name: 'agency_name', record_id: '260', translation: 'Tránsito de Sunny Valley' },

  // routes.txt — by record
  { table_name: 'routes', field_name: 'route_long_name', record_id: '6850', translation: 'Línea Azul' },
  { table_name: 'routes', field_name: 'route_long_name', record_id: '6852', translation: 'Línea Morada' },
  { table_name: 'routes', field_name: 'route_long_name', record_id: '6853', translation: 'Línea Dorada' },
  { table_name: 'routes', field_name: 'route_long_name', record_id: '6854', translation: 'Línea Café' },
  { table_name: 'routes', field_name: 'route_long_name', record_id: '6856', translation: 'Lanzadera del noreste de Bozeman' },
  { table_name: 'routes', field_name: 'route_desc', record_id: '6850', translation: 'De MSU SUB a Gallatin Center, ida y vuelta' },
  { table_name: 'routes', field_name: 'route_desc', record_id: '6852', translation: 'De Urgencias de Bozeman Health a Fallon y Cottonwood, ida y vuelta' },

  // trips.txt headsigns — by value (one row covers every trip with that headsign)
  { table_name: 'trips', field_name: 'trip_headsign', field_value: 'Northbound', translation: 'Hacia el norte' },
  { table_name: 'trips', field_name: 'trip_headsign', field_value: 'Southbound', translation: 'Hacia el sur' },
  { table_name: 'trips', field_name: 'trip_headsign', field_value: 'Eastbound', translation: 'Hacia el este' },
  { table_name: 'trips', field_name: 'trip_headsign', field_value: 'Westbound', translation: 'Hacia el oeste' },
  { table_name: 'trips', field_name: 'trip_headsign', field_value: 'To Downtown Transit Station', translation: 'Hacia la estación de transbordo del centro' },
  { table_name: 'trips', field_name: 'trip_headsign', field_value: 'Clockwise partial loop', translation: 'Circuito parcial en sentido horario' },

  // stops.txt — by record
  { table_name: 'stops', field_name: 'stop_name', record_id: '11234870', translation: 'MSU SUB (Edificio Strand Union)' },
  { table_name: 'stops', field_name: 'stop_name', record_id: '11234871', translation: '6th y Garfield (hacia el norte)' },
  { table_name: 'stops', field_name: 'stop_name', record_id: '11234872', translation: 'Garfield y Willson' },
  { table_name: 'stops', field_name: 'stop_name', record_id: '11234877', translation: 'Mendenhall y Black (estación de transbordo del centro)' },
  { table_name: 'stops', field_name: 'stop_name', record_id: '11234893', translation: 'Gallatin Center (estacionamiento de Staples)' },
  { table_name: 'stops', field_name: 'stop_name', record_id: '11235824', translation: 'Entrada de Urgencias de Bozeman Health' },
  { table_name: 'stops', field_name: 'stop_name', record_id: '11237374', translation: 'Main frente a la Biblioteca Pública de Bozeman' },
  { table_name: 'stops', field_name: 'stop_name', record_id: '11238739', translation: 'Tamarack y Tracy (Centro para Personas Mayores)' },
].map((t) => ({ language: LANG, ...t }));

/** feed_info: the original text is English; apps that don't know the rider's
 *  language fall back to English. */
export const FEED_LANG = 'en-US';
export const DEFAULT_LANG = 'en-US';

const COLUMNS = ['table_name', 'field_name', 'language', 'translation', 'record_id', 'record_sub_id', 'field_value'];
const KEY_OF = { agency: 'agency_id', routes: 'route_id', trips: 'trip_id', stops: 'stop_id' };

async function loadFeed(path) {
  const buf = path ? readFileSync(path) : Buffer.from(await (await fetch(FEED_URL)).arrayBuffer());
  return JSZip.loadAsync(buf);
}

async function rows(zip, name) {
  const f = zip.file(name);
  if (!f) return [];
  return Papa.parse(await f.async('string'), { header: true, skipEmptyLines: true }).data;
}

async function main() {
  const args = process.argv.slice(2);
  const feedArg = args.includes('--feed') ? args[args.indexOf('--feed') + 1] : undefined;
  const zipOut = args.includes('--zip') ? args[args.indexOf('--zip') + 1] : undefined;
  const zip = await loadFeed(feedArg);

  const problems = [];
  for (const t of TRANSLATIONS) {
    const table = await rows(zip, `${t.table_name}.txt`);
    if (t.record_id !== undefined) {
      const rec = table.find((r) => r[KEY_OF[t.table_name]] === t.record_id);
      if (!rec) problems.push(`no ${t.table_name} record ${t.record_id}`);
      else if (!rec[t.field_name]) problems.push(`${t.table_name} ${t.record_id} has no ${t.field_name} to translate`);
    } else if (!table.some((r) => r[t.field_name] === t.field_value)) {
      problems.push(`no ${t.table_name} row has ${t.field_name} = "${t.field_value}"`);
    }
  }
  if (problems.length) {
    console.error(`✗ ${problems.length} translation(s) don't match the feed:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
  console.error(`✓ all ${TRANSLATIONS.length} translations resolve against ${feedArg ?? FEED_URL}`);

  if (zipOut) {
    zip.file('translations.txt', Papa.unparse(TRANSLATIONS, { columns: COLUMNS }));
    const info = (await rows(zip, 'feed_info.txt'))[0] ?? {};
    info.feed_lang = FEED_LANG;
    info.default_lang = DEFAULT_LANG;
    zip.file('feed_info.txt', Papa.unparse([info]));
    writeFileSync(zipOut, await zip.generateAsync({ type: 'nodebuffer' }));
    console.error(`✓ wrote ${zipOut}`);
  }

  const snippet = [
    '// svt-demo translations — paste in the devtools console with the svt-demo project open',
    '(() => {',
    '  const s = window.__gtfsStore.getState();',
    `  s.updateFeedInfo({ feed_lang: ${JSON.stringify(FEED_LANG)}, default_lang: ${JSON.stringify(DEFAULT_LANG)} });`,
    "  s.setFeatureSetting('translations', true);",
    `  const rows = ${JSON.stringify(TRANSLATIONS)};`,
    '  for (const t of rows) s.upsertTranslation(t);',
    "  console.log('translations:', window.__gtfsStore.getState().translations.length);",
    '})();',
  ].join('\n');
  console.log(snippet);
}

main().catch((e) => { console.error(e); process.exit(1); });
