import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import { featureEnabled } from '../../store/featuresSlice';
import type { Translation } from '../../types/gtfs';
import {
  isWellFormedLanguageTag,
  languageName,
  translationKey,
  type TranslationTableName,
} from '../../services/translations';
import { RailDivider, RailSubHeading } from '../ui/RailHeadings';
import { Button } from '../ui/Button';
import { pendingAfterEdit } from './pendingLanguages';
import { LanguagePicker } from './LanguagePicker';

/** One translatable value: a field of one record, or every occurrence of an
 *  exact value (field_value form). */
export interface TranslationTarget {
  /** React key, unique within the editor. */
  id: string;
  label: string;
  /** The original text, shown as the input placeholder. */
  original: string;
  table: TranslationTableName;
  field: string;
  recordId?: string;
  recordSubId?: string;
  fieldValue?: string;
}

function refOf(t: TranslationTarget, language: string): Translation {
  const row: Translation = { table_name: t.table, field_name: t.field, language, translation: '' };
  if (t.recordId !== undefined) row.record_id = t.recordId;
  if (t.recordSubId !== undefined) row.record_sub_id = t.recordSubId;
  if (t.fieldValue !== undefined) row.field_value = t.fieldValue;
  return row;
}

interface TranslationsEditorProps {
  title: string;
  targets: TranslationTarget[];
  /** Short explanation under the heading. */
  hint?: string;
  /** Leading divider (true inside a rail panel that has content above). */
  divider?: boolean;
}

/**
 * Per-entity translations box, used on the agency, route, stop and feed-info
 * panels: one card per language, one input per translatable field. Typing
 * writes the translations.txt row; clearing a box deletes it. Hidden unless
 * the Translations feature is on for this feed (Settings, or auto-on when the
 * imported feed already has translations).
 */
export function TranslationsEditor({ title, targets, hint, divider = true }: TranslationsEditorProps) {
  const enabled = useStore((s) => featureEnabled(s, 'translations'));
  const translations = useStore((s) => s.translations);
  const upsertTranslation = useStore((s) => s.upsertTranslation);
  const removeTranslationsAt = useStore((s) => s.removeTranslationsAt);
  const feedLang = useStore((s) => s.feedInfo?.feed_lang ?? '');

  // Languages the user added here but hasn't typed a translation in yet — the
  // card has to stay open even though no row exists for it.
  const [pending, setPending] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [newLang, setNewLang] = useState('');

  const keys = useMemo(() => {
    const m = new Map<string, number>();
    translations.forEach((t, i) => m.set(translationKey(t), i));
    return m;
  }, [translations]);

  const languages = useMemo(() => {
    const seen: string[] = [];
    for (const target of targets) {
      for (const t of translations) {
        if (
          t.table_name === target.table && t.field_name === target.field &&
          (t.record_id ?? '') === (target.recordId ?? '') &&
          (t.record_sub_id ?? '') === (target.recordSubId ?? '') &&
          (t.field_value ?? '') === (target.fieldValue ?? '') &&
          !seen.includes(t.language)
        ) seen.push(t.language);
      }
    }
    for (const p of pending) if (!seen.includes(p)) seen.push(p);
    return seen;
  }, [targets, translations, pending]);

  if (!enabled || targets.length === 0) return null;

  const valueFor = (target: TranslationTarget, language: string) => {
    const i = keys.get(translationKey(refOf(target, language)));
    return i === undefined ? '' : translations[i].translation;
  };

  const removeLanguage = (language: string) => {
    const drop: number[] = [];
    for (const target of targets) {
      const i = keys.get(translationKey(refOf(target, language)));
      if (i !== undefined) drop.push(i);
    }
    removeTranslationsAt(drop);
    setPending((p) => p.filter((l) => l !== language));
  };

  const trimmedNew = newLang.trim();
  const canAdd = isWellFormedLanguageTag(trimmedNew) && !languages.includes(trimmedNew);
  const addLanguage = () => {
    if (!canAdd) return;
    setPending((p) => [...p, trimmedNew]);
    setNewLang('');
    setAdding(false);
  };

  return (
    <div data-testid="entity-translations">
      {divider && <RailDivider />}
      <RailSubHeading count={languages.length || undefined}>{title}</RailSubHeading>
      {hint && <p className="text-[11px] text-warm-gray -mt-1 mb-3 leading-snug">{hint}</p>}

      {languages.map((language) => (
        <div key={language} className="mb-3 rounded-lg border border-sand bg-white p-3">
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="min-w-0">
              <span className="font-semibold text-sm text-dark-brown">{languageName(language)}</span>
              <span className="ml-2 font-mono text-[11px] text-warm-gray">{language}</span>
              {feedLang && language.toLowerCase() === feedLang.toLowerCase() && (
                <span className="ml-2 text-[10px] text-amber-700">same as feed language</span>
              )}
            </div>
            <button
              type="button"
              onClick={() => removeLanguage(language)}
              className="shrink-0 text-[11px] font-semibold text-red-600 hover:underline"
              aria-label={`Remove ${languageName(language)} translations`}
            >
              Remove
            </button>
          </div>
          {targets.map((target) => (
            <div key={target.id} className="mb-2 last:mb-0">
              <label className="block text-[10px] text-warm-gray mb-0.5">
                {target.label}
                {target.original && (
                  <span className="ml-1 text-warm-gray/70 normal-case">— “{target.original}”</span>
                )}
              </label>
              <input
                type="text"
                lang={language}
                value={valueFor(target, language)}
                onChange={(e) => {
                  const value = e.target.value;
                  // Clearing deletes the row; keep the card open (C3-14).
                  setPending((p) => pendingAfterEdit(p, language, value));
                  upsertTranslation({ ...refOf(target, language), translation: value });
                }}
                placeholder={target.original || 'Translation'}
                data-testid={`translation-${target.id}-${language}`}
                className="w-full px-3 py-1.5 border-2 border-sand rounded-lg text-sm text-dark-brown bg-cream focus:outline-none focus:border-coral focus:bg-white"
              />
            </div>
          ))}
        </div>
      ))}

      {adding ? (
        <div className="flex items-start gap-2">
          <LanguagePicker
            value={newLang}
            onChange={setNewLang}
            ariaLabel="Language to add"
            testId="add-translation-language"
            className="flex-1 min-w-0"
          />
          <Button variant="primary" onClick={addLanguage} disabled={!canAdd} className="mt-1">Add</Button>
          <Button variant="ghost" onClick={() => { setAdding(false); setNewLang(''); }} className="mt-1">Cancel</Button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="w-full py-2 rounded-lg border-2 border-dashed border-sand text-warm-gray text-sm font-medium hover:border-coral hover:text-coral transition-colors"
        >
          + Add language
        </button>
      )}
    </div>
  );
}
