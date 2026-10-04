import { useState } from 'react';
import { parseTimeframeTime } from './fareEditorHelpers';

/**
 * Text HH:MM:SS input for a timeframe start/end (C3-09). A native
 * `<input type="time">` can't hold 24:00:00 (the spec's end-of-day value) or
 * an unpadded imported "7:00:00", and rendered those blank. This shows the
 * stored value verbatim and commits on blur / Enter: blank clears it, a
 * parseable time is normalised, and anything else stays in the box flagged
 * red without touching the store.
 */
export function TimeframeTimeInput({
  value,
  onCommit,
  title,
  placeholder,
}: {
  value: string | undefined;
  onCommit: (next: string | undefined) => void;
  title: string;
  placeholder: string;
}) {
  // null = not editing; show the stored value.
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value ?? '';
  const invalid = draft != null && parseTimeframeTime(draft) === null;

  const commit = () => {
    if (draft == null) return;
    const parsed = parseTimeframeTime(draft);
    if (parsed === null) return; // keep the bad draft visible
    if (parsed !== (value || undefined)) onCommit(parsed);
    setDraft(null);
  };

  return (
    <input
      type="text"
      inputMode="numeric"
      value={shown}
      placeholder={placeholder}
      title={title}
      aria-invalid={invalid || undefined}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') setDraft(null);
      }}
      className={`px-2 py-1.5 border-2 rounded-lg text-xs bg-white font-mono focus:outline-none ${
        invalid ? 'border-red-400 focus:border-red-500' : 'border-sand focus:border-coral'
      }`}
    />
  );
}
