import { useId } from 'react';
import {
  COMMON_LANGUAGES,
  MULTILINGUAL_FEED_LANG,
  isWellFormedLanguageTag,
  languageName,
} from '../../services/translations';

interface LanguagePickerProps {
  value: string;
  onChange: (value: string) => void;
  /** Offer `mul` (multiple languages) — only meaningful for feed_lang. */
  allowMultilingual?: boolean;
  placeholder?: string;
  /** Accessible label when the picker has no visible <label>. */
  ariaLabel?: string;
  testId?: string;
  className?: string;
}

/**
 * IETF BCP 47 language picker: a text input with a suggestion list of common
 * tags (native <datalist>, so free entry always works and it behaves on
 * phones), plus a live hint naming the language — or flagging a malformed tag.
 */
export function LanguagePicker({
  value,
  onChange,
  allowMultilingual,
  placeholder = 'e.g. es, fr-CA',
  ariaLabel,
  testId,
  className = '',
}: LanguagePickerProps) {
  const listId = useId();
  const trimmed = value.trim();
  const valid = trimmed === '' || isWellFormedLanguageTag(trimmed);
  return (
    <div className={className}>
      <input
        type="text"
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-invalid={!valid}
        data-testid={testId}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        className={`w-full px-3 py-2 border-2 rounded-lg text-sm font-mono text-dark-brown bg-cream transition-colors focus:outline-none focus:border-coral focus:bg-white ${
          valid ? 'border-sand' : 'border-red-400 bg-red-50'
        }`}
      />
      <datalist id={listId}>
        {allowMultilingual && (
          <option value={MULTILINGUAL_FEED_LANG}>Multiple languages (original text is mixed)</option>
        )}
        {COMMON_LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>{l.name}</option>
        ))}
      </datalist>
      {trimmed !== '' && (
        <p className={`text-[11px] mt-1 ${valid ? 'text-warm-gray' : 'text-red-500'}`}>
          {valid
            ? languageName(trimmed)
            : `"${trimmed}" isn't a valid language code. Use a BCP 47 tag like "es", "fr-CA" or "zh-Hant".`}
        </p>
      )}
    </div>
  );
}
