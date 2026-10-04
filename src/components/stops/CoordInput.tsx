import { useEffect, useState } from 'react';
import { parseCoordDraft } from './stopFormHelpers';

/**
 * Latitude / longitude text field with a local draft. The store is written only
 * when the draft is a complete, in-range number, so clearing the field or
 * typing a leading '-' no longer writes 0 (and no longer snaps the text back to
 * "0" mid-typing). An invalid draft reverts to the stored value on blur. A
 * change from elsewhere (map drag, Snap) replaces the draft.
 */
export function CoordInput({
  value,
  kind,
  onCommit,
  className,
}: {
  value: number;
  kind: 'lat' | 'lon';
  onCommit: (n: number) => void;
  className?: string;
}) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    // Keep a draft that already means this value ("-111.0" vs -111) so the
    // user's own keystrokes aren't rewritten.
    setDraft((d) => (parseCoordDraft(d, kind) === value ? d : String(value)));
  }, [value, kind]);

  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={kind === 'lat' ? 'Latitude' : 'Longitude'}
      value={draft}
      onChange={(e) => {
        const raw = e.target.value;
        setDraft(raw);
        const n = parseCoordDraft(raw, kind);
        if (n !== null && n !== value) onCommit(n);
      }}
      onBlur={() => {
        if (parseCoordDraft(draft, kind) === null) setDraft(String(value));
      }}
      className={className}
    />
  );
}
