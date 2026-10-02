// translations.txt — the pure spec rules (services/translations.ts).
import { describe, expect, it } from 'vitest';
import type { Translation } from '../../types/gtfs';
import {
  analyzeTranslations,
  exportableTranslations,
  isWellFormedLanguageTag,
  languageName,
  languagesOverlap,
  parseTranslationRows,
  renameTranslationRecord,
  translationCsvColumns,
  translationKey,
  withoutTranslationsFor,
  type TranslationFeed,
} from '../translations';

function feed(translations: Translation[], extra: Partial<TranslationFeed> = {}): TranslationFeed {
  return {
    agencies: [{ agency_id: 'A', agency_name: 'Sunny Valley Transit', agency_url: 'https://x.test', agency_timezone: 'America/Denver' }],
    stops: [{ stop_id: 'S1', stop_name: 'Main St', stop_lat: 45, stop_lon: -111, location_type: 0, wheelchair_boarding: 0 }],
    routes: [{ route_id: 'R1', agency_id: 'A', route_short_name: 'Blue', route_long_name: 'Blue Line', route_type: 3, route_color: '0000FF', route_text_color: 'FFFFFF' }],
    trips: [{ trip_id: 'T1', route_id: 'R1', service_id: 'WK', direction_id: 0, trip_headsign: 'Northbound' }],
    stopTimes: [{ trip_id: 'T1', stop_id: 'S1', stop_sequence: 3, arrival_time: '08:00:00', departure_time: '08:00:00', stop_headsign: 'Downtown' }],
    pathways: [{ pathway_id: 'P1', from_stop_id: 'S1', to_stop_id: 'S1', pathway_mode: 1, is_bidirectional: 1, signposted_as: 'Exit' }],
    levels: [{ level_id: 'L0', level_index: 0, level_name: 'Ground' }],
    feedInfo: { feed_publisher_name: 'x', feed_publisher_url: 'https://x', feed_lang: 'en', feed_contact_url: 'https://help' },
    translations,
    ...extra,
  };
}

const T = (t: Partial<Translation>): Translation => ({
  table_name: 'stops', field_name: 'stop_name', language: 'es', translation: 'Calle Mayor', record_id: 'S1', ...t,
});

function kinds(rows: Translation[], extra?: Partial<TranslationFeed>) {
  return analyzeTranslations(feed(rows, extra)).map((i) => [i.index, i.kind]);
}

describe('language tags (IETF BCP 47)', () => {
  it('accepts well-formed tags, including mul and script/region subtags', () => {
    for (const tag of ['es', 'en-US', 'fr-CA', 'zh-Hant', 'zh-Hant-TW', 'mul', 'de-AT', 'sr-Latn']) {
      expect(isWellFormedLanguageTag(tag), tag).toBe(true);
    }
  });
  it('rejects malformed ones', () => {
    for (const tag of ['', 'Spanish', 'en_US', ' es', 'es ', 'e', '123']) {
      expect(isWellFormedLanguageTag(tag), JSON.stringify(tag)).toBe(false);
    }
  });
  it('names languages and falls back to the tag', () => {
    expect(languageName('es')).toBe('Spanish');
    expect(languageName('mul')).toBe('Multiple languages');
    expect(languageName('not a tag')).toBe('not a tag');
  });
  it('treats a region form as overlapping its base language', () => {
    expect(languagesOverlap('de', 'de-AT')).toBe(true);
    expect(languagesOverlap('DE-at', 'de')).toBe(true);
    expect(languagesOverlap('de', 'en')).toBe(false);
    expect(languagesOverlap('zh', 'zh-Hant')).toBe(true);
  });
});

describe('parseTranslationRows', () => {
  it('keeps every row, normalizes blank optional columns to absent, never trims values', () => {
    const rows = parseTranslationRows([
      { table_name: 'stops', field_name: 'stop_name', language: 'es', translation: ' Calle  Mayor ', record_id: 'S1', record_sub_id: '', field_value: '' },
      { table_name: 'trips', field_name: 'trip_headsign', language: 'es', translation: 'Al norte', record_id: '', record_sub_id: '', field_value: 'Northbound' },
      { table_name: 'mystery', field_name: '', language: 'xx_YY', translation: '' },
      { table_name: '', field_name: '', language: '', translation: '' }, // a blank line
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ table_name: 'stops', field_name: 'stop_name', language: 'es', translation: ' Calle  Mayor ', record_id: 'S1' });
    expect(rows[1]).toEqual({ table_name: 'trips', field_name: 'trip_headsign', language: 'es', translation: 'Al norte', field_value: 'Northbound' });
    expect('record_id' in rows[1]).toBe(false);
    expect(rows[2].table_name).toBe('mystery'); // lossless: broken rows are kept
  });
});

describe('analyzeTranslations — spec rules', () => {
  it('a clean feed has no issues, in both forms and for every spec table', () => {
    expect(kinds([
      T({}),
      T({ table_name: 'trips', field_name: 'trip_headsign', record_id: undefined, field_value: 'Northbound', translation: 'Hacia el norte' }),
      T({ table_name: 'stop_times', field_name: 'stop_headsign', record_id: 'T1', record_sub_id: '3', translation: 'Centro' }),
      T({ table_name: 'stop_times', field_name: 'stop_headsign', record_id: undefined, field_value: 'Downtown', translation: 'Centro' }),
      T({ table_name: 'agency', field_name: 'agency_name', record_id: 'A', translation: 'Tránsito' }),
      T({ table_name: 'routes', field_name: 'route_long_name', record_id: 'R1', translation: 'Línea Azul' }),
      T({ table_name: 'pathways', field_name: 'signposted_as', record_id: 'P1', translation: 'Salida' }),
      T({ table_name: 'levels', field_name: 'level_name', record_id: 'L0', translation: 'Planta baja' }),
      T({ table_name: 'feed_info', field_name: 'feed_contact_url', record_id: undefined, translation: 'https://ayuda' }),
    ])).toEqual([]);
  });

  it('flags missing required values and malformed language codes', () => {
    expect(kinds([
      T({ translation: '' }),
      T({ language: '' }),
      T({ field_name: '' }),
      T({ language: 'Spanish' }),
    ])).toEqual([[0, 'missing-required'], [1, 'missing-required'], [2, 'missing-required'], [3, 'invalid-language']]);
  });

  it('enforces the record_id / field_value forms', () => {
    expect(kinds([
      T({ field_value: 'Main St' }),                                     // both
      T({ record_id: undefined }),                                       // neither
      T({ record_id: undefined, field_value: 'Main St', record_sub_id: '1' }), // sub id with value
    ])).toEqual([[0, 'both-forms'], [1, 'no-target'], [2, 'sub-id-with-value']]);
  });

  it('forbids any reference on feed_info', () => {
    expect(kinds([
      T({ table_name: 'feed_info', field_name: 'feed_contact_url', record_id: 'x' }),
      T({ table_name: 'feed_info', field_name: 'feed_contact_url', record_id: undefined, field_value: 'https://help' }),
    ])).toEqual([[0, 'feed-info-reference'], [1, 'feed-info-reference']]);
  });

  it('requires record_sub_id for stop_times and forbids it elsewhere', () => {
    expect(kinds([
      T({ table_name: 'stop_times', field_name: 'stop_headsign', record_id: 'T1' }),
      T({ record_sub_id: '1' }),
    ])).toEqual([[0, 'missing-sub-id'], [1, 'unexpected-sub-id']]);
  });

  it('resolves record_id (and stop_sequence) against the feed', () => {
    expect(kinds([
      T({ record_id: 'GONE' }),
      T({ table_name: 'stop_times', field_name: 'stop_headsign', record_id: 'T1', record_sub_id: '4' }),
      T({ table_name: 'stop_times', field_name: 'stop_headsign', record_id: 'T1', record_sub_id: '03' }), // "03" is sequence 3
      T({ table_name: 'trips', field_name: 'trip_headsign', record_id: 'NOPE' }),
    ])).toEqual([[0, 'missing-record'], [1, 'missing-record'], [3, 'missing-record']]);
  });

  it('marks attributions (not carried) and the overwritten publisher fields as not exportable', () => {
    expect(kinds([
      T({ table_name: 'attributions', field_name: 'organization_name', record_id: 'att1' }),
      T({ table_name: 'feed_info', field_name: 'feed_publisher_name', record_id: undefined }),
    ])).toEqual([[0, 'unsupported-table'], [1, 'publisher-overwritten']]);
  });

  it('keeps (but notes) unofficial tables/fields, non-text fields and unmatched values', () => {
    expect(kinds([
      T({ table_name: 'calendar', field_name: 'service_name', record_id: 'WK' }),
      T({ field_name: 'platform_name' }),
      T({ field_name: 'stop_lat' }),
      T({ record_id: undefined, field_value: 'Nowhere' }),
    ])).toEqual([[0, 'unofficial-table'], [1, 'unknown-field'], [2, 'untranslatable-field'], [3, 'unmatched-value']]);
  });

  it('flags duplicate primary keys, keeping the first good copy', () => {
    const rows = [T({}), T({ translation: 'Otra' }), T({ language: 'fr' })];
    expect(kinds(rows)).toEqual([[1, 'duplicate-key']]);
    // A broken first copy doesn't make the second a duplicate.
    expect(kinds([T({ record_id: 'GONE' }), T({ record_id: 'GONE', translation: 'x' })]))
      .toEqual([[0, 'missing-record'], [1, 'missing-record']]);
  });
});

describe('export selection + columns', () => {
  it('exportableTranslations drops exactly the omitted rows, in order', () => {
    const rows = [
      T({}),
      T({ record_id: 'GONE' }),
      T({ table_name: 'calendar', field_name: 'service_name', record_id: 'WK' }), // kept
      T({ language: 'fr', translation: 'Rue Principale' }),
      T({}), // duplicate
    ];
    expect(exportableTranslations(feed(rows))).toEqual([rows[0], rows[2], rows[3]]);
  });

  it('emits the optional reference columns only when a row uses them, in spec order', () => {
    expect(translationCsvColumns([T({ table_name: 'feed_info', record_id: undefined })]))
      .toEqual(['table_name', 'field_name', 'language', 'translation']);
    expect(translationCsvColumns([T({ record_id: undefined, field_value: 'x' }), T({})]))
      .toEqual(['table_name', 'field_name', 'language', 'translation', 'record_id', 'field_value']);
  });

  it('translationKey covers all six primary-key columns', () => {
    expect(translationKey(T({}))).not.toBe(translationKey(T({ record_sub_id: '1' })));
    expect(translationKey(T({}))).toBe(translationKey(T({ translation: 'different text' })));
  });
});

describe('cascade helpers', () => {
  it('renaming a trip re-points trips AND stop_times rows, never by-value rows', () => {
    const rows = [
      T({ table_name: 'trips', field_name: 'trip_headsign', record_id: 'T1' }),
      T({ table_name: 'stop_times', field_name: 'stop_headsign', record_id: 'T1', record_sub_id: '3' }),
      T({ table_name: 'trips', field_name: 'trip_headsign', record_id: undefined, field_value: 'T1' }),
      T({ record_id: 'T1' }), // a STOP that happens to share the id
    ];
    renameTranslationRecord(rows, 'trips', 'T1', 'T9');
    expect(rows.map((r) => r.record_id)).toEqual(['T9', 'T9', undefined, 'T1']);
  });

  it('withoutTranslationsFor returns the same array when nothing matches', () => {
    const rows = [T({})];
    expect(withoutTranslationsFor(rows, 'stops', new Set(['X']))).toBe(rows);
    expect(withoutTranslationsFor(rows, 'stops', new Set(['S1']))).toEqual([]);
  });
});
