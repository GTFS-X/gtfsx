// Text insertion for the forum Composer, kept pure so it can be unit-tested.
//
// Inserts each snippet on its own line at the selection [start, end) of
// `text`, and returns the new text plus the caret position just after the
// last inserted snippet.

export function insertSnippets(
  text: string,
  start: number,
  end: number,
  snippets: string[],
): { next: string; caret: number } {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const sep = before && !before.endsWith('\n') ? '\n' : '';
  const block = snippets.map((s) => `${s}\n`).join('');
  return { next: `${before}${sep}${block}${after}`, caret: before.length + sep.length + block.length };
}
