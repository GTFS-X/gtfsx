// translations.txt validation messages + the one-click Remove fix.
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../store';
import { resetEditorState } from '../../db/serverPersistence';
import { runValidation, VALIDATION_CODES } from '../validation';
import { applyValidationFix, getValidationFix } from '../validationFixes';
import type { Translation } from '../../types/gtfs';

const s = () => useStore.getState();
const tr = (t: Partial<Translation>): Translation => ({
  table_name: 'stops', field_name: 'stop_name', language: 'es', translation: 'Uno', record_id: 'S1', ...t,
});

function seed(translations: Translation[], feedLang: string | null = 'en') {
  resetEditorState();
  s().setAgencies([{ agency_id: 'A', agency_name: 'A', agency_url: 'https://a.test', agency_timezone: 'America/Denver' }]);
  s().setStops([{ stop_id: 'S1', stop_name: 'One', stop_lat: 45, stop_lon: -111, location_type: 0, wheelchair_boarding: 0 }]);
  s().setFeedInfo(feedLang === null ? null : { feed_publisher_name: 'x', feed_publisher_url: 'https://x', feed_lang: feedLang });
  s().setTranslations(translations);
}

const translationMsgs = () => runValidation(s()).filter((m) =>
  m.entity_type === 'translation' || /language|default_lang|translations/i.test(m.message));

beforeEach(() => seed([]));

describe('translation validation', () => {
  it('a valid feed with translations raises nothing', () => {
    seed([tr({})]);
    expect(translationMsgs()).toEqual([]);
  });

  it('aggregates one warning per rule, with a count and examples, never an error', () => {
    seed([tr({ record_id: 'GONE' }), tr({ record_id: 'GONE2' }), tr({ language: 'Spanish' }), tr({}), tr({})]);
    const msgs = translationMsgs();
    expect(msgs.every((m) => m.severity === 'warning')).toBe(true);
    const missing = msgs.find((m) => m.message.startsWith("Translations pointing at a record that doesn't exist"));
    expect(missing?.message).toContain('(2)');
    expect(missing?.message).toContain('stops "GONE" stop_name (es)');
    expect(missing?.message).toContain('left out of the exported translations.txt');
    expect(missing?.fix).toEqual({ id: 'remove-invalid-translations' });
    expect(missing?.code).toBeUndefined(); // export-affecting rules aren't dismissible
    expect(msgs.some((m) => m.message.startsWith("Translations whose language isn't a valid"))).toBe(true);
    expect(msgs.some((m) => m.message.startsWith('Translations repeating'))).toBe(true);
  });

  it('flags invalid table/field combinations as dismissible notes, and unmatched values', () => {
    seed([
      tr({ table_name: 'calendar', field_name: 'service_name', record_id: 'WK' }),
      tr({ field_name: 'stop_lat' }),
      tr({ record_id: undefined, field_value: 'Nowhere' }),
    ]);
    const msgs = translationMsgs();
    const codes = msgs.map((m) => m.code);
    expect(codes.filter((c) => c === VALIDATION_CODES.translationUnofficial)).toHaveLength(2);
    expect(codes).toContain(VALIDATION_CODES.translationUnmatchedValue);
    expect(msgs.every((m) => !m.fix)).toBe(true);
  });

  it('warns when translations exist but feed_lang is missing', () => {
    seed([tr({})], null);
    const m = translationMsgs().find((x) => x.message.includes('no feed language'));
    expect(m?.entity_type).toBe('agency');
    seed([], null);
    expect(translationMsgs().some((x) => x.message.includes('no feed language'))).toBe(false);
  });

  it('checks feed_lang / default_lang codes and the default_lang ↔ translations interplay', () => {
    seed([tr({})]);
    s().updateFeedInfo({ feed_lang: 'English', default_lang: 'fr' });
    const msgs = translationMsgs().map((m) => m.message);
    expect(msgs.some((m) => m.includes('Feed language "English" isn\'t a valid'))).toBe(true);
    expect(msgs.some((m) => m.startsWith('default_lang is "fr"'))).toBe(true);

    // A regional translation satisfies a base default_lang ("es" ~ "es-MX").
    s().updateFeedInfo({ feed_lang: 'en', default_lang: 'es' });
    s().setTranslations([tr({ language: 'es-MX' })]);
    expect(translationMsgs().some((m) => m.message.startsWith('default_lang'))).toBe(false);
  });

  it('flags feed_lang=mul with no translations', () => {
    seed([], 'mul');
    expect(translationMsgs().some((m) => m.message.includes('"mul"'))).toBe(true);
    seed([tr({})], 'mul');
    expect(translationMsgs().some((m) => m.message.includes('"mul"'))).toBe(false);
  });
});

describe('remove-invalid-translations fix', () => {
  it('removes exactly the not-exported rows, and undo restores them', () => {
    const rows = [tr({}), tr({ record_id: 'GONE' }), tr({ table_name: 'calendar', field_name: 'service_name', record_id: 'WK' }), tr({})];
    seed(rows);
    const msg = translationMsgs().find((m) => m.fix?.id === 'remove-invalid-translations')!;
    expect(getValidationFix('remove-invalid-translations')).toBeTruthy();
    const result = applyValidationFix(msg)!;
    expect(result.changed).toBe(true);
    expect(s().translations).toEqual([rows[0], rows[2]]); // unofficial row kept
    expect(translationMsgs().some((m) => m.fix)).toBe(false);
    result.undo();
    expect(s().translations).toEqual(rows);
  });
});
