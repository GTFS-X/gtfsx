import { useMemo, useState } from 'react';
import { useStore, type AppStore } from '../../store';
import type { Translation } from '../../types/gtfs';
import {
  TABLE_SPEC,
  TRANSLATION_TABLES,
  OMITTED_ISSUES,
  analyzeTranslations,
  fieldLabel,
  isSpecTable,
  isWellFormedLanguageTag,
  languageName,
  translationForm,
  translationKey,
  type TranslationIssueKind,
} from '../../services/translations';
import { FormField } from '../ui/FormField';
import { Modal } from '../ui/Modal';
import { Segmented } from '../ui/Segmented';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { RailDivider, RailSubHeading } from '../ui/RailHeadings';
import { AuthButton } from '../auth/AuthButton';
import { LanguagePicker } from './LanguagePicker';

const PAGE = 100;

const ISSUE_LABEL: Record<TranslationIssueKind, string> = {
  'missing-required': 'Missing a required value',
  'invalid-language': 'Invalid language code',
  'feed-info-reference': 'feed_info can’t name a record or value',
  'both-forms': 'Sets both record_id and field_value',
  'no-target': 'Names no record or value',
  'sub-id-with-value': 'record_sub_id can’t go with field_value',
  'missing-sub-id': 'Needs record_sub_id (stop_sequence)',
  'unexpected-sub-id': 'record_sub_id only applies to stop_times',
  'missing-record': 'Record doesn’t exist',
  'unsupported-table': 'attributions.txt isn’t carried by GTFS·X',
  'duplicate-key': 'Duplicate of an earlier row',
  'publisher-overwritten': 'Publisher is always GTFS·X on export',
  'unofficial-table': 'Not a GTFS table',
  'unknown-field': 'Not a field of this table',
  'untranslatable-field': 'Field type shouldn’t be translated',
  'unmatched-value': 'No record has this value',
};

/** A human description of what a row translates. */
function describeTarget(s: AppStore, t: Translation): string {
  const form = translationForm(t);
  if (form === 'feed') return 'Feed info';
  if (form === 'value') return `Every “${t.field_value}”`;
  const id = t.record_id ?? '';
  switch (t.table_name) {
    case 'agency': {
      const a = s.agencies.find((x) => x.agency_id === id);
      return a ? `${a.agency_name || id}` : id;
    }
    case 'stops': {
      const st = s.stops.find((x) => x.stop_id === id);
      return st ? `${st.stop_name || id} · ${id}` : id;
    }
    case 'routes': {
      const r = s.routes.find((x) => x.route_id === id);
      return r ? `${r.route_short_name || r.route_long_name || id} · ${id}` : id;
    }
    case 'trips': {
      const tr = s.trips.find((x) => x.trip_id === id);
      return tr?.trip_headsign ? `${id} · ${tr.trip_headsign}` : id;
    }
    case 'stop_times':
      return `Trip ${id}, stop #${t.record_sub_id ?? '?'}`;
    case 'levels': {
      const l = s.levels.find((x) => x.level_id === id);
      return l?.level_name ? `${l.level_name} · ${id}` : id;
    }
    default:
      return t.record_sub_id ? `${id} #${t.record_sub_id}` : id;
  }
}

/** Record choices for the editor's record picker. */
function recordOptions(s: AppStore, table: string): { id: string; label: string }[] {
  switch (table) {
    case 'agency': return s.agencies.filter((a) => a.agency_id).map((a) => ({ id: a.agency_id, label: a.agency_name }));
    case 'stops': return s.stops.map((x) => ({ id: x.stop_id, label: x.stop_name }));
    case 'routes': return s.routes.map((r) => ({ id: r.route_id, label: r.route_short_name || r.route_long_name }));
    case 'trips':
    case 'stop_times': return s.trips.map((t) => ({ id: t.trip_id, label: t.trip_headsign ?? '' }));
    case 'pathways': return s.pathways.map((p) => ({ id: p.pathway_id, label: p.signposted_as ?? '' }));
    case 'levels': return s.levels.map((l) => ({ id: l.level_id, label: l.level_name ?? '' }));
    default: return [];
  }
}

/** Distinct values of a field, for the "every matching value" picker. */
function fieldValues(s: AppStore, table: string, field: string): string[] {
  const rows: Record<string, unknown>[] = (() => {
    switch (table) {
      case 'agency': return s.agencies as unknown as Record<string, unknown>[];
      case 'stops': return s.stops as unknown as Record<string, unknown>[];
      case 'routes': return s.routes as unknown as Record<string, unknown>[];
      case 'trips': return s.trips as unknown as Record<string, unknown>[];
      case 'stop_times': return s.stopTimes as unknown as Record<string, unknown>[];
      case 'pathways': return s.pathways as unknown as Record<string, unknown>[];
      case 'levels': return s.levels as unknown as Record<string, unknown>[];
      default: return [];
    }
  })();
  const out = new Set<string>();
  for (const r of rows) {
    const v = r[field];
    if (v != null && v !== '') out.add(String(v));
    if (out.size >= 500) break;
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

/**
 * Feed-level Translations section: the feed/default language, then every
 * translations.txt row with language/table filters, add/edit/delete, and the
 * reason a row isn't exported when it isn't.
 */
export function TranslationsPanel() {
  const s = useStore();
  const { translations, feedInfo, updateFeedInfo } = s;
  const [langFilter, setLangFilter] = useState('');
  const [tableFilter, setTableFilter] = useState('');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);
  // index being edited; -1 = new row; null = closed
  const [editing, setEditing] = useState<number | null>(null);

  const issues = useMemo(() => {
    const m = new Map<number, TranslationIssueKind>();
    for (const i of analyzeTranslations(s)) m.set(i.index, i.kind);
    return m;
    // analyzeTranslations reads only these keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.translations, s.agencies, s.stops, s.routes, s.trips, s.stopTimes, s.pathways, s.levels, s.feedInfo]);

  const languages = useMemo(
    () => [...new Set(translations.map((t) => t.language))].sort(),
    [translations],
  );
  const tables = useMemo(
    () => [...new Set(translations.map((t) => t.table_name))].sort(),
    [translations],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out: number[] = [];
    translations.forEach((t, i) => {
      if (langFilter && t.language !== langFilter) return;
      if (tableFilter && t.table_name !== tableFilter) return;
      if (q && ![t.translation, t.field_value, t.record_id, t.field_name]
        .some((v) => v && v.toLowerCase().includes(q))) return;
      out.push(i);
    });
    return out;
  }, [translations, langFilter, tableFilter, query]);

  const omittedCount = [...issues.values()].filter((k) => OMITTED_ISSUES.has(k)).length;

  return (
    <div data-testid="translations-panel">
      <p className="text-sm text-warm-gray mb-4">
        Give riders stop names, route names, headsigns and agency details in other languages.
        GTFS·X writes them to <code>translations.txt</code>. You can also translate one stop, route or
        agency from its own panel.
      </p>

      <div className="grid grid-cols-1 min-[420px]:grid-cols-2 gap-3">
        <FormField label="Feed language" containerClassName="" testId="field-translations-feed-lang">
          <LanguagePicker
            value={feedInfo?.feed_lang ?? ''}
            onChange={(v) => updateFeedInfo({ feed_lang: v })}
            allowMultilingual
            placeholder="e.g. en"
            ariaLabel="Feed language"
          />
        </FormField>
        <FormField label="Default language" containerClassName="" testId="field-translations-default-lang">
          <LanguagePicker
            value={feedInfo?.default_lang ?? ''}
            onChange={(v) => updateFeedInfo({ default_lang: v || undefined })}
            placeholder="Optional"
            ariaLabel="Default language"
          />
        </FormField>
      </div>
      <p className="text-[11px] text-warm-gray mt-1.5 leading-snug">
        <strong>Feed language</strong> is the language your names are written in (use <code>mul</code> if
        they mix languages). <strong>Default language</strong> is what apps show riders whose language
        they don&rsquo;t know.
      </p>

      <RailDivider />
      <RailSubHeading
        count={translations.length}
        action={
          <Button variant="primary" onClick={() => setEditing(-1)} data-testid="add-translation">
            + Add
          </Button>
        }
      >
        Translations
      </RailSubHeading>

      {translations.length === 0 ? (
        <EmptyState
          icon="🌐"
          title="No translations yet"
          description="Add one here, or open a stop, route or the agency and use its Translations box."
          actionLabel="Add translation"
          onAction={() => setEditing(-1)}
        />
      ) : (
        <>
          <div className="flex flex-wrap gap-2 mb-3">
            <select
              aria-label="Filter by language"
              value={langFilter}
              onChange={(e) => { setLangFilter(e.target.value); setLimit(PAGE); }}
              className="flex-1 min-w-[120px] px-2 py-1.5 border-2 border-sand rounded-lg text-xs bg-cream focus:outline-none focus:border-coral"
            >
              <option value="">All languages</option>
              {languages.map((l) => (
                <option key={l} value={l}>{languageName(l)} ({l})</option>
              ))}
            </select>
            <select
              aria-label="Filter by table"
              value={tableFilter}
              onChange={(e) => { setTableFilter(e.target.value); setLimit(PAGE); }}
              className="flex-1 min-w-[120px] px-2 py-1.5 border-2 border-sand rounded-lg text-xs bg-cream focus:outline-none focus:border-coral"
            >
              <option value="">All tables</option>
              {tables.map((t) => (
                <option key={t} value={t}>{isSpecTable(t) ? TABLE_SPEC[t].label : t}</option>
              ))}
            </select>
            <input
              type="search"
              aria-label="Search translations"
              placeholder="Search…"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setLimit(PAGE); }}
              className="w-full px-2 py-1.5 border-2 border-sand rounded-lg text-xs bg-cream focus:outline-none focus:border-coral"
            />
          </div>

          {omittedCount > 0 && (
            <div className="mb-3 rounded-lg border border-amber-200 bg-gold-light px-3 py-2 text-xs text-amber-700 flex items-center justify-between gap-2">
              <span>
                {omittedCount} translation{omittedCount === 1 ? '' : 's'} can&rsquo;t be exported (see the
                notes below). They stay here until you fix or remove them.
              </span>
              <button
                type="button"
                className="shrink-0 font-bold hover:underline"
                onClick={() => s.removeTranslationsAt(
                  [...issues.entries()].filter(([, k]) => OMITTED_ISSUES.has(k)).map(([i]) => i),
                )}
              >
                Remove
              </button>
            </div>
          )}

          <ul className="space-y-1.5" data-testid="translations-list">
            {filtered.slice(0, limit).map((i) => {
              const t = translations[i];
              const issue = issues.get(i);
              const omitted = issue ? OMITTED_ISSUES.has(issue) : false;
              return (
                <li key={`${i}-${translationKey(t)}`}>
                  <button
                    type="button"
                    onClick={() => setEditing(i)}
                    className="w-full text-left rounded-lg border border-sand bg-white px-3 py-2 hover:border-coral transition-colors"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[11px] text-warm-gray truncate">
                        {isSpecTable(t.table_name) ? TABLE_SPEC[t.table_name].label : t.table_name}
                        {' · '}{fieldLabel(t.table_name, t.field_name)}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] font-bold uppercase tracking-wide rounded bg-teal-light text-teal px-1.5 py-0.5">
                        {t.language || '?'}
                      </span>
                    </div>
                    <div className="text-[12px] text-brown truncate">{describeTarget(s, t)}</div>
                    <div className="text-sm text-dark-brown break-words" lang={t.language}>
                      {t.translation || <em className="text-warm-gray">(empty)</em>}
                    </div>
                    {issue && (
                      <div className={`text-[11px] mt-0.5 ${omitted ? 'text-red-600' : 'text-amber-700'}`}>
                        {omitted ? 'Not exported: ' : ''}{ISSUE_LABEL[issue]}
                      </div>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          {filtered.length === 0 && (
            <p className="text-sm text-warm-gray text-center py-4">No translations match these filters.</p>
          )}
          {filtered.length > limit && (
            <button
              type="button"
              onClick={() => setLimit((l) => l + PAGE)}
              className="mt-2 w-full py-2 text-sm text-coral font-semibold hover:underline"
            >
              Show more ({filtered.length - limit} more)
            </button>
          )}
        </>
      )}

      {editing !== null && (
        <TranslationDialog
          index={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

type Form = 'record' | 'value';

/** Add / edit one translations.txt row. */
function TranslationDialog({ index, onClose }: { index: number; onClose: () => void }) {
  const s = useStore();
  const existing = index >= 0 ? s.translations[index] : undefined;
  const [table, setTable] = useState(existing?.table_name ?? 'stops');
  const [field, setField] = useState(existing?.field_name ?? 'stop_name');
  const [form, setForm] = useState<Form>(existing?.field_value ? 'value' : 'record');
  const [recordId, setRecordId] = useState(existing?.record_id ?? '');
  const [recordSubId, setRecordSubId] = useState(existing?.record_sub_id ?? '');
  const [fieldValue, setFieldValue] = useState(existing?.field_value ?? '');
  const [language, setLanguage] = useState(existing?.language ?? '');
  const [text, setText] = useState(existing?.translation ?? '');

  const spec = isSpecTable(table) ? TABLE_SPEC[table] : null;
  const isFeed = table === 'feed_info';
  const fieldChoices = spec ? spec.translatable.map((f) => f.field) : [];
  if (field && !fieldChoices.includes(field)) fieldChoices.push(field);
  const tableChoices = TRANSLATION_TABLES.filter((t) => t.modeled).map((t) => t.table as string);
  if (!tableChoices.includes(table)) tableChoices.push(table);

  const records = useMemo(() => recordOptions(s, table), [s, table]);
  const values = useMemo(() => (form === 'value' ? fieldValues(s, table, field) : []), [s, table, field, form]);
  const sequences = useMemo(
    () => (table === 'stop_times' && recordId
      ? s.stopTimes.filter((st) => st.trip_id === recordId).map((st) => {
          const stop = s.stops.find((x) => x.stop_id === st.stop_id);
          return { id: String(st.stop_sequence), label: stop?.stop_name ?? st.stop_id };
        })
      : []),
    [s, table, recordId],
  );

  const row: Translation = { table_name: table, field_name: field, language: language.trim(), translation: text };
  if (!isFeed && form === 'record') {
    row.record_id = recordId.trim();
    if (table === 'stop_times') row.record_sub_id = recordSubId.trim();
  }
  if (!isFeed && form === 'value') row.field_value = fieldValue;

  const duplicateAt = s.translations.findIndex(
    (t, i) => i !== index && translationKey(t) === translationKey(row),
  );
  const problems: string[] = [];
  if (!table || !field) problems.push('Choose a table and field.');
  if (!isWellFormedLanguageTag(row.language)) problems.push('Enter a valid language code.');
  if (!text) problems.push('Enter the translation.');
  if (!isFeed && form === 'record' && !row.record_id) problems.push('Choose the record to translate.');
  if (table === 'stop_times' && form === 'record' && !row.record_sub_id) problems.push('Enter the stop_sequence.');
  if (!isFeed && form === 'value' && !fieldValue) problems.push('Enter the value to translate.');
  if (duplicateAt !== -1) problems.push('This record/value already has a translation in that language.');

  const save = () => {
    if (problems.length) return;
    if (existing) {
      s.updateTranslationAt(index, {
        ...row,
        record_id: row.record_id ?? '',
        record_sub_id: row.record_sub_id ?? '',
        field_value: row.field_value ?? '',
      });
    } else {
      s.addTranslation(row);
    }
    onClose();
  };

  const recordListId = 'translation-record-options';
  const valueListId = 'translation-value-options';
  const seqListId = 'translation-seq-options';

  return (
    <Modal
      open
      onClose={onClose}
      maxWidthClassName="max-w-md"
      title={existing ? 'Edit translation' : 'Add translation'}
      footer={
        <div className="flex flex-wrap justify-end gap-2 w-full">
          {existing && (
            <AuthButton
              variant="ghost"
              className="mr-auto !text-red-600"
              onClick={() => { s.removeTranslationAt(index); onClose(); }}
            >
              Delete
            </AuthButton>
          )}
          <AuthButton variant="secondary" onClick={onClose}>Cancel</AuthButton>
          <AuthButton variant="primary" onClick={save} disabled={problems.length > 0} data-testid="save-translation">
            Save
          </AuthButton>
        </div>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Table" containerClassName="">
          <select
            value={table}
            onChange={(e) => {
              const next = e.target.value;
              setTable(next);
              const first = isSpecTable(next) ? TABLE_SPEC[next].translatable[0]?.field : undefined;
              if (first) setField(first);
              setRecordId(''); setRecordSubId(''); setFieldValue('');
            }}
            className="w-full px-2 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral"
          >
            {tableChoices.map((t) => (
              <option key={t} value={t}>{isSpecTable(t) ? TABLE_SPEC[t].label : t}</option>
            ))}
          </select>
        </FormField>
        <FormField label="Field" containerClassName="">
          <select
            value={field}
            onChange={(e) => { setField(e.target.value); setFieldValue(''); }}
            className="w-full px-2 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral"
          >
            {fieldChoices.map((f) => (
              <option key={f} value={f}>{fieldLabel(table, f)}</option>
            ))}
          </select>
        </FormField>
      </div>

      {!isFeed && (
        <div className="mt-3">
          <Segmented
            value={form === 'record' ? 0 : 1}
            onChange={(i) => setForm(i === 0 ? 'record' : 'value')}
            options={['One record', 'Every matching value']}
            aria-label="What to translate"
          />
          <p className="text-[11px] text-warm-gray mt-1">
            {form === 'record'
              ? 'Translates this field on one record (record_id).'
              : 'Translates the field everywhere it has exactly this text (field_value) — handy for headsigns.'}
          </p>
        </div>
      )}

      {!isFeed && form === 'record' && (
        <div className={`mt-3 grid gap-3 ${table === 'stop_times' ? 'grid-cols-2' : 'grid-cols-1'}`}>
          <FormField label={table === 'stop_times' ? 'Trip' : 'Record'} containerClassName="">
            <input
              type="text"
              list={recordListId}
              value={recordId}
              onChange={(e) => setRecordId(e.target.value)}
              placeholder={spec?.recordKey ?? 'record_id'}
              data-testid="translation-record-id"
              className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm font-mono bg-cream focus:outline-none focus:border-coral focus:bg-white"
            />
            <datalist id={recordListId}>
              {records.slice(0, 2000).map((r) => (
                <option key={r.id} value={r.id}>{r.label}</option>
              ))}
            </datalist>
          </FormField>
          {table === 'stop_times' && (
            <FormField label="Stop sequence" containerClassName="">
              <input
                type="text"
                inputMode="numeric"
                list={seqListId}
                value={recordSubId}
                onChange={(e) => setRecordSubId(e.target.value)}
                placeholder="stop_sequence"
                className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm font-mono bg-cream focus:outline-none focus:border-coral focus:bg-white"
              />
              <datalist id={seqListId}>
                {sequences.map((q) => (
                  <option key={q.id} value={q.id}>{q.label}</option>
                ))}
              </datalist>
            </FormField>
          )}
        </div>
      )}

      {!isFeed && form === 'value' && (
        <FormField label="Original text" containerClassName="mt-3">
          <input
            type="text"
            list={valueListId}
            value={fieldValue}
            onChange={(e) => setFieldValue(e.target.value)}
            placeholder="e.g. Downtown"
            data-testid="translation-field-value"
            className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral focus:bg-white"
          />
          <datalist id={valueListId}>
            {values.map((v) => <option key={v} value={v} />)}
          </datalist>
        </FormField>
      )}

      <FormField label="Language" containerClassName="mt-3">
        <LanguagePicker value={language} onChange={setLanguage} ariaLabel="Language" testId="translation-language" />
      </FormField>
      <FormField label="Translation" containerClassName="mt-3">
        <input
          type="text"
          lang={row.language || undefined}
          value={text}
          onChange={(e) => setText(e.target.value)}
          data-testid="translation-text"
          className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral focus:bg-white"
        />
      </FormField>

      {problems.length > 0 && (language || text || recordId || fieldValue) && (
        <p className="mt-2 text-[11px] text-red-500">{problems[0]}</p>
      )}
    </Modal>
  );
}
