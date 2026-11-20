// translations.txt — spec tables, rule checks, and the helpers shared by the
// importer, exporter, validator, store cascades and the editor UI.
//
// Pure module: no store import, no browser-only globals, so it runs in the
// import Web Worker, the tsx editor-test harness and vitest alike.
//
// Spec: https://gtfs.org/documentation/schedule/reference/#translationstxt
//
// The one analysis (`analyzeTranslations`) feeds BOTH the validator and the
// exporter, so "what the panel warns about" and "what the export leaves out"
// can never drift apart. Nothing here ever blocks an export: rows that would
// make translations.txt invalid are omitted from the zip (and warned about),
// while they stay in the feed state so nothing a user imported is silently
// lost from the editor.
import type {
  Agency, FeedInfo, Level, Pathway, Route, Stop, StopTime, Translation, Trip,
} from '../types/gtfs';

export type TranslationTableName =
  | 'agency' | 'stops' | 'routes' | 'trips' | 'stop_times'
  | 'pathways' | 'levels' | 'feed_info' | 'attributions';

export type TranslatableKind = 'text' | 'url' | 'email' | 'phone';

export interface TranslatableField {
  field: string;
  label: string;
  kind: TranslatableKind;
  /** Offered by the per-entity editors. Every translatable field is accepted
   *  by the feed-level table; this just keeps the per-entity menus short. */
  common?: boolean;
}

export interface TranslationTableSpec {
  table: TranslationTableName;
  label: string;
  /** The field record_id names (first field of the table's primary key);
   *  null for feed_info, where record_id is forbidden. */
  recordKey: string | null;
  /** The field record_sub_id names; only stop_times has one (stop_sequence). */
  subKey: string | null;
  /** Fields whose spec type is Text, URL, Email or Phone number — the only ones
   *  the spec says may be translated. */
  translatable: TranslatableField[];
  /** Every other field the spec defines on the table. Translating one of these
   *  is a "should not", so it is kept and warned about rather than dropped. */
  otherFields: string[];
  /** False when GTFS·X doesn't carry the file itself (attributions.txt), so a
   *  translation of it can't be resolved and isn't exported. */
  modeled: boolean;
}

export const TRANSLATION_TABLES: TranslationTableSpec[] = [
  {
    table: 'agency', label: 'Agency', recordKey: 'agency_id', subKey: null, modeled: true,
    translatable: [
      { field: 'agency_name', label: 'Agency name', kind: 'text', common: true },
      { field: 'agency_url', label: 'Agency URL', kind: 'url', common: true },
      { field: 'agency_fare_url', label: 'Fare URL', kind: 'url', common: true },
      { field: 'agency_phone', label: 'Phone', kind: 'phone', common: true },
      { field: 'agency_email', label: 'Email', kind: 'email', common: true },
    ],
    otherFields: ['agency_id', 'agency_timezone', 'agency_lang', 'cemv_support'],
  },
  {
    table: 'stops', label: 'Stops', recordKey: 'stop_id', subKey: null, modeled: true,
    translatable: [
      { field: 'stop_name', label: 'Stop name', kind: 'text', common: true },
      { field: 'tts_stop_name', label: 'Text-to-speech name', kind: 'text', common: true },
      { field: 'stop_desc', label: 'Description', kind: 'text', common: true },
      { field: 'stop_url', label: 'Stop URL', kind: 'url', common: true },
      { field: 'platform_code', label: 'Platform code', kind: 'text' },
      { field: 'stop_code', label: 'Stop code', kind: 'text' },
    ],
    otherFields: [
      'stop_id', 'stop_lat', 'stop_lon', 'zone_id', 'location_type', 'parent_station',
      'stop_timezone', 'wheelchair_boarding', 'level_id', 'stop_access',
    ],
  },
  {
    table: 'routes', label: 'Routes', recordKey: 'route_id', subKey: null, modeled: true,
    translatable: [
      { field: 'route_short_name', label: 'Short name', kind: 'text', common: true },
      { field: 'route_long_name', label: 'Long name', kind: 'text', common: true },
      { field: 'route_desc', label: 'Description', kind: 'text', common: true },
      { field: 'route_url', label: 'Route URL', kind: 'url', common: true },
    ],
    otherFields: [
      'route_id', 'agency_id', 'route_type', 'route_color', 'route_text_color',
      'route_sort_order', 'continuous_pickup', 'continuous_drop_off', 'network_id',
      'cemv_support',
    ],
  },
  {
    table: 'trips', label: 'Trips', recordKey: 'trip_id', subKey: null, modeled: true,
    translatable: [
      { field: 'trip_headsign', label: 'Headsign', kind: 'text', common: true },
      { field: 'trip_short_name', label: 'Trip short name', kind: 'text', common: true },
    ],
    otherFields: [
      'route_id', 'service_id', 'trip_id', 'direction_id', 'block_id', 'shape_id',
      'wheelchair_accessible', 'bikes_allowed', 'cars_allowed',
    ],
  },
  {
    table: 'stop_times', label: 'Stop times', recordKey: 'trip_id', subKey: 'stop_sequence', modeled: true,
    translatable: [
      { field: 'stop_headsign', label: 'Stop headsign', kind: 'text', common: true },
    ],
    otherFields: [
      'trip_id', 'arrival_time', 'departure_time', 'stop_id', 'location_group_id',
      'location_id', 'stop_sequence', 'start_pickup_drop_off_window',
      'end_pickup_drop_off_window', 'pickup_type', 'drop_off_type', 'continuous_pickup',
      'continuous_drop_off', 'shape_dist_traveled', 'timepoint',
      'pickup_booking_rule_id', 'drop_off_booking_rule_id',
    ],
  },
  {
    table: 'pathways', label: 'Pathways', recordKey: 'pathway_id', subKey: null, modeled: true,
    translatable: [
      { field: 'signposted_as', label: 'Signposted as', kind: 'text', common: true },
      { field: 'reversed_signposted_as', label: 'Reverse signposted as', kind: 'text', common: true },
    ],
    otherFields: [
      'pathway_id', 'from_stop_id', 'to_stop_id', 'pathway_mode', 'is_bidirectional',
      'length', 'traversal_time', 'stair_count', 'max_slope', 'min_width',
    ],
  },
  {
    table: 'levels', label: 'Levels', recordKey: 'level_id', subKey: null, modeled: true,
    translatable: [
      { field: 'level_name', label: 'Level name', kind: 'text', common: true },
    ],
    otherFields: ['level_id', 'level_index'],
  },
  {
    table: 'feed_info', label: 'Feed info', recordKey: null, subKey: null, modeled: true,
    translatable: [
      { field: 'feed_contact_url', label: 'Contact URL', kind: 'url', common: true },
      { field: 'feed_contact_email', label: 'Contact email', kind: 'email', common: true },
      { field: 'feed_version', label: 'Feed version', kind: 'text' },
    ],
    // feed_publisher_name / feed_publisher_url are Text/URL in the spec, but
    // GTFS·X always publishes the feed as "GTFS·X" (gtfsExport buildFeedInfoRow),
    // so a translation of the imported publisher would be attached to the wrong
    // value. They're handled by the 'publisher-overwritten' rule instead.
    otherFields: ['feed_lang', 'default_lang', 'feed_start_date', 'feed_end_date'],
  },
  {
    table: 'attributions', label: 'Attributions', recordKey: 'attribution_id', subKey: null, modeled: false,
    translatable: [
      { field: 'organization_name', label: 'Organization name', kind: 'text' },
      { field: 'attribution_url', label: 'Attribution URL', kind: 'url' },
      { field: 'attribution_email', label: 'Attribution email', kind: 'email' },
      { field: 'attribution_phone', label: 'Attribution phone', kind: 'phone' },
    ],
    otherFields: [
      'attribution_id', 'agency_id', 'route_id', 'trip_id', 'is_producer', 'is_operator',
      'is_authority',
    ],
  },
];

export const TABLE_SPEC: Record<TranslationTableName, TranslationTableSpec> = Object.fromEntries(
  TRANSLATION_TABLES.map((t) => [t.table, t]),
) as Record<TranslationTableName, TranslationTableSpec>;

export function isSpecTable(table: string): table is TranslationTableName {
  return Object.prototype.hasOwnProperty.call(TABLE_SPEC, table);
}

export function fieldLabel(table: string, field: string): string {
  if (!isSpecTable(table)) return field;
  return TABLE_SPEC[table].translatable.find((f) => f.field === field)?.label ?? field;
}

// ── Language codes (IETF BCP 47) ───────────────────────────────────────────

/** Common tags offered by the language picker. Free entry is always allowed. */
export const COMMON_LANGUAGES: { code: string; name: string }[] = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'fr-CA', name: 'French (Canada)' },
  { code: 'de', name: 'German' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'pt-BR', name: 'Portuguese (Brazil)' },
  { code: 'nl', name: 'Dutch' },
  { code: 'zh-Hans', name: 'Chinese (Simplified)' },
  { code: 'zh-Hant', name: 'Chinese (Traditional)' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'tl', name: 'Tagalog' },
  { code: 'ar', name: 'Arabic' },
  { code: 'ru', name: 'Russian' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'pl', name: 'Polish' },
  { code: 'hi', name: 'Hindi' },
  { code: 'ht', name: 'Haitian Creole' },
  { code: 'so', name: 'Somali' },
  { code: 'am', name: 'Amharic' },
  { code: 'fa', name: 'Persian' },
  { code: 'he', name: 'Hebrew' },
  { code: 'sv', name: 'Swedish' },
  { code: 'nv', name: 'Navajo' },
  { code: 'ca', name: 'Catalan' },
  { code: 'eu', name: 'Basque' },
  { code: 'cy', name: 'Welsh' },
];

/** `mul` (ISO 639-2 "multiple languages") — valid only as feed_info.feed_lang,
 *  for a feed whose ORIGINAL text is in several languages. */
export const MULTILINGUAL_FEED_LANG = 'mul';

/** True when `tag` is a well-formed BCP 47 language tag. Uses the platform's
 *  own BCP 47 parser (Intl.getCanonicalLocales throws RangeError on a
 *  malformed tag), plus a 2–3 letter primary subtag, so "es", "fr-CA",
 *  "zh-Hant-TW" and "mul" pass while "Spanish", "en_US" and "" don't. */
export function isWellFormedLanguageTag(tag: string | undefined | null): boolean {
  const t = (tag ?? '').trim();
  if (!t || t !== tag) return false;
  // BCP 47 syntax allows a 5–8 letter primary subtag, but that range is
  // reserved and nothing is registered in it — in practice it's a language
  // NAME typed into the field ("Spanish"). Real primary subtags are ISO 639
  // codes: 2 or 3 letters.
  if (!/^[A-Za-z]{2,3}(-|$)/.test(t)) return false;
  try {
    return Intl.getCanonicalLocales(t).length === 1;
  } catch {
    return false;
  }
}

/** True when two tags name the same language or one is a more specific form
 *  of the other ("de" ~ "de-AT"), case-insensitively — the fallback apps use
 *  when matching a rider's language to a translation. */
export function languagesOverlap(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (!x || !y) return false;
  return x === y || x.startsWith(`${y}-`) || y.startsWith(`${x}-`);
}

let displayNames: Intl.DisplayNames | null | undefined;
/** Human name for a language tag ("es" → "Spanish"), falling back to the tag. */
export function languageName(tag: string): string {
  const known = COMMON_LANGUAGES.find((l) => l.code.toLowerCase() === tag.toLowerCase());
  if (known) return known.name;
  if (tag === MULTILINGUAL_FEED_LANG) return 'Multiple languages';
  if (displayNames === undefined) {
    try {
      displayNames = new Intl.DisplayNames(['en'], { type: 'language' });
    } catch {
      displayNames = null;
    }
  }
  if (displayNames && isWellFormedLanguageTag(tag)) {
    try {
      const n = displayNames.of(tag);
      if (n && n !== tag) return n;
    } catch { /* fall through */ }
  }
  return tag;
}

// ── Row identity ───────────────────────────────────────────────────────────

/** Normalize an optional cell: blank → undefined (the CSV and the UI both
 *  produce '' for "not set"). */
export function blankToUndefined(v: string | undefined | null): string | undefined {
  return v == null || v === '' ? undefined : v;
}

/** The spec's primary key: (table_name, field_name, language, record_id,
 *  record_sub_id, field_value). */
export function translationKey(t: Translation): string {
  return [
    t.table_name, t.field_name, t.language,
    t.record_id ?? '', t.record_sub_id ?? '', t.field_value ?? '',
  ].join('\u0000');
}

/** Which form a row uses to name its target. */
export type TranslationForm = 'record' | 'value' | 'feed';
export function translationForm(t: Translation): TranslationForm {
  if (t.table_name === 'feed_info') return 'feed';
  return t.field_value != null && t.field_value !== '' ? 'value' : 'record';
}

// ── Feed context ───────────────────────────────────────────────────────────

/** The slice of feed state the rules need (structurally satisfied by AppStore
 *  and by ImportData). */
export interface TranslationFeed {
  agencies: Agency[];
  stops: Stop[];
  routes: Route[];
  trips: Trip[];
  stopTimes: StopTime[];
  pathways: Pathway[];
  levels: Level[];
  feedInfo: FeedInfo | null;
  translations: Translation[];
}

type Row = Record<string, unknown>;

function tableRows(feed: TranslationFeed, table: TranslationTableName): Row[] {
  switch (table) {
    case 'agency': return feed.agencies as unknown as Row[];
    case 'stops': return feed.stops as unknown as Row[];
    case 'routes': return feed.routes as unknown as Row[];
    case 'trips': return feed.trips as unknown as Row[];
    case 'stop_times': return feed.stopTimes as unknown as Row[];
    case 'pathways': return feed.pathways as unknown as Row[];
    case 'levels': return feed.levels as unknown as Row[];
    case 'feed_info': return feed.feedInfo ? [feed.feedInfo as unknown as Row] : [];
    case 'attributions': return [];
  }
}

const cell = (v: unknown): string => (v == null ? '' : String(v));

/** Lazily-built lookups over the feed: record ids per table, stop_times keys,
 *  and the set of values a (table, field) takes (for field_value matching). */
class FeedIndex {
  private ids = new Map<TranslationTableName, Set<string>>();
  private values = new Map<string, Set<string>>();
  private stopTimeKeys: Set<string> | null = null;
  private feed: TranslationFeed;
  constructor(feed: TranslationFeed) { this.feed = feed; }

  hasRecord(table: TranslationTableName, id: string): boolean {
    let set = this.ids.get(table);
    if (!set) {
      const key = TABLE_SPEC[table].recordKey;
      set = new Set(key ? tableRows(this.feed, table).map((r) => cell(r[key])) : []);
      this.ids.set(table, set);
    }
    return set.has(id);
  }

  hasStopTime(tripId: string, seq: string): boolean {
    if (!this.stopTimeKeys) {
      this.stopTimeKeys = new Set(this.feed.stopTimes.map((st) => `${st.trip_id}\u0000${st.stop_sequence}`));
    }
    // stop_sequence is a non-negative integer; "03" and "3" name the same row.
    const n = Number(seq);
    const norm = Number.isFinite(n) && seq.trim() !== '' ? String(n) : seq;
    return this.stopTimeKeys.has(`${tripId}\u0000${norm}`);
  }

  hasValue(table: TranslationTableName, field: string, value: string): boolean {
    const k = `${table}\u0000${field}`;
    let set = this.values.get(k);
    if (!set) {
      set = new Set(tableRows(this.feed, table).map((r) => cell(r[field])).filter((v) => v !== ''));
      this.values.set(k, set);
    }
    return set.has(value);
  }
}

// ── Rule analysis ──────────────────────────────────────────────────────────

/**
 * One kind of problem. `omit` = the row is left out of the exported
 * translations.txt (it would make the file invalid); the rest are kept and
 * only warned about (the spec allows them, or only says "should not").
 */
export type TranslationIssueKind =
  | 'missing-required'      // table_name / field_name / language / translation blank
  | 'invalid-language'      // language isn't a well-formed BCP 47 tag
  | 'feed-info-reference'   // record_id / record_sub_id / field_value set on feed_info
  | 'both-forms'            // record_id AND field_value both set
  | 'no-target'             // neither record_id nor field_value
  | 'sub-id-with-value'     // record_sub_id alongside field_value
  | 'missing-sub-id'        // stop_times by record without record_sub_id
  | 'unexpected-sub-id'     // record_sub_id on a table that has none
  | 'missing-record'        // record_id (+ sub id) names no row
  | 'unsupported-table'     // attributions — GTFS·X doesn't carry attributions.txt
  | 'duplicate-key'         // same primary key as an earlier row
  | 'publisher-overwritten' // feed_info publisher fields — GTFS·X rewrites them on export
  | 'unofficial-table'      // table_name isn't one of the spec's tables
  | 'unknown-field'         // field_name isn't a field of that spec table
  | 'untranslatable-field'  // a spec field whose type shouldn't be translated
  | 'unmatched-value';      // field_value matches no row's value

export const OMITTED_ISSUES: ReadonlySet<TranslationIssueKind> = new Set<TranslationIssueKind>([
  'missing-required', 'invalid-language', 'feed-info-reference', 'both-forms', 'no-target',
  'sub-id-with-value', 'missing-sub-id', 'unexpected-sub-id', 'missing-record',
  'unsupported-table', 'duplicate-key', 'publisher-overwritten',
]);

export interface TranslationIssue {
  index: number;
  kind: TranslationIssueKind;
}

/**
 * Check every translations.txt rule against the feed. Returns at most one
 * issue per row — the first (most fundamental) rule it breaks — so a row is
 * never reported twice. Duplicate keys are checked last and only among rows
 * that are otherwise exportable, so the first good copy of a key is the one
 * that survives.
 */
export function analyzeTranslations(feed: TranslationFeed): TranslationIssue[] {
  const issues: TranslationIssue[] = [];
  const idx = new FeedIndex(feed);
  const seen = new Set<string>();

  feed.translations.forEach((t, index) => {
    const kind = firstIssue(t, idx);
    if (kind && OMITTED_ISSUES.has(kind)) {
      issues.push({ index, kind });
      return;
    }
    const key = translationKey(t);
    if (seen.has(key)) {
      issues.push({ index, kind: 'duplicate-key' });
      return;
    }
    seen.add(key);
    if (kind) issues.push({ index, kind });
  });
  return issues;
}

/** feed_info fields the exporter always overwrites with GTFS·X's own values. */
export const PUBLISHER_FIELDS: ReadonlySet<string> = new Set(['feed_publisher_name', 'feed_publisher_url']);

function firstIssue(t: Translation, idx: FeedIndex): TranslationIssueKind | null {
  if (!t.table_name || !t.field_name || !t.language || t.translation == null || t.translation === '') {
    return 'missing-required';
  }
  if (!isWellFormedLanguageTag(t.language)) return 'invalid-language';

  const recordId = blankToUndefined(t.record_id);
  const subId = blankToUndefined(t.record_sub_id);
  const fieldValue = blankToUndefined(t.field_value);

  if (t.table_name === 'feed_info') {
    if (recordId || subId || fieldValue) return 'feed-info-reference';
  } else {
    if (recordId && fieldValue) return 'both-forms';
    if (!recordId && !fieldValue) return 'no-target';
    if (fieldValue && subId) return 'sub-id-with-value';
  }

  if (!isSpecTable(t.table_name)) return 'unofficial-table';
  const spec = TABLE_SPEC[t.table_name];

  if (recordId) {
    if (spec.subKey && !subId) return 'missing-sub-id';
    if (!spec.subKey && subId) return 'unexpected-sub-id';
  }
  if (!spec.modeled) return 'unsupported-table';

  if (recordId) {
    const found = spec.subKey
      ? idx.hasStopTime(recordId, subId!)
      : idx.hasRecord(spec.table, recordId);
    if (!found) return 'missing-record';
  }

  if (spec.table === 'feed_info' && PUBLISHER_FIELDS.has(t.field_name)) return 'publisher-overwritten';

  const translatable = spec.translatable.some((f) => f.field === t.field_name);
  if (!translatable) {
    return spec.otherFields.includes(t.field_name) ? 'untranslatable-field' : 'unknown-field';
  }
  if (fieldValue && !idx.hasValue(spec.table, t.field_name, fieldValue)) return 'unmatched-value';
  return null;
}

/** The rows the exporter writes: everything except the ones `analyzeTranslations`
 *  marks for omission. Order is preserved. */
export function exportableTranslations(feed: TranslationFeed): Translation[] {
  if (feed.translations.length === 0) return [];
  const omit = new Set(
    analyzeTranslations(feed).filter((i) => OMITTED_ISSUES.has(i.kind)).map((i) => i.index),
  );
  return feed.translations.filter((_, i) => !omit.has(i));
}

/** Indices of rows the exporter would leave out — what the one-click
 *  "remove invalid translations" fix deletes. */
export function omittedTranslationIndices(feed: TranslationFeed): number[] {
  return analyzeTranslations(feed).filter((i) => OMITTED_ISSUES.has(i.kind)).map((i) => i.index);
}

/** translations.txt columns, in spec order. The three optional reference
 *  columns are emitted only when some row uses them. */
export const TRANSLATION_COLUMNS = [
  'table_name', 'field_name', 'language', 'translation', 'record_id', 'record_sub_id', 'field_value',
] as const;

export function translationCsvColumns(rows: Translation[]): string[] {
  return TRANSLATION_COLUMNS.filter((c, i) =>
    i < 4 || rows.some((r) => (r[c] ?? '') !== ''),
  );
}

// ── Parsing ────────────────────────────────────────────────────────────────

/** Map raw translations.txt CSV rows to Translation entities. Lossless: every
 *  row is kept (validation explains the broken ones); only the blank/absent
 *  optional reference columns normalize to undefined. Values are not trimmed
 *  — a translation's exact text, and field_value's exact match, matter. */
export function parseTranslationRows(rows: Record<string, string | undefined>[]): Translation[] {
  return rows
    .filter((r) => Object.values(r).some((v) => v != null && v !== ''))
    .map((r) => {
      const t: Translation = {
        table_name: r.table_name ?? '',
        field_name: r.field_name ?? '',
        language: r.language ?? '',
        translation: r.translation ?? '',
      };
      const recordId = blankToUndefined(r.record_id);
      const subId = blankToUndefined(r.record_sub_id);
      const fieldValue = blankToUndefined(r.field_value);
      if (recordId !== undefined) t.record_id = recordId;
      if (subId !== undefined) t.record_sub_id = subId;
      if (fieldValue !== undefined) t.field_value = fieldValue;
      return t;
    });
}

// ── Referential-integrity cascades (used by the store slices) ──────────────

/** Tables whose record_id is a trip_id. Renaming or deleting a trip touches both. */
const TRIP_KEYED: ReadonlySet<string> = new Set(['trips', 'stop_times']);

function matchesTable(t: Translation, table: TranslationTableName): boolean {
  return table === 'trips' ? TRIP_KEYED.has(t.table_name) : t.table_name === table;
}

/** Re-point record-based translations at a renamed id (mutates in place — call
 *  on an Immer draft). For trips this covers stop_times rows too, whose
 *  record_id is also the trip_id. By-value rows are untouched: they name a
 *  value, not a record. */
export function renameTranslationRecord(
  translations: Translation[] | undefined,
  table: TranslationTableName,
  oldId: string,
  newId: string,
): void {
  if (!translations || oldId === newId || oldId === '') return;
  for (const t of translations) {
    if (t.record_id === oldId && matchesTable(t, table)) t.record_id = newId;
  }
}

/** Translations that name one of `ids` in `table` (trips include stop_times). */
export function translationsForRecords(
  translations: Translation[] | undefined,
  table: TranslationTableName,
  ids: ReadonlySet<string>,
): Translation[] {
  if (!translations || ids.size === 0) return [];
  return translations.filter((t) => t.record_id != null && ids.has(t.record_id) && matchesTable(t, table));
}

/** Drop the translations of deleted records. Returns the surviving list (a new
 *  array when anything was removed, the same one otherwise). */
export function withoutTranslationsFor(
  translations: Translation[] | undefined,
  table: TranslationTableName,
  ids: ReadonlySet<string>,
): Translation[] {
  const list = translations ?? [];
  if (ids.size === 0) return list;
  const next = list.filter((t) => !(t.record_id != null && ids.has(t.record_id) && matchesTable(t, table)));
  return next.length === list.length ? list : next;
}
