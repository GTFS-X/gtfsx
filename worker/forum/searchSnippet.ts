import { escapeHtml } from './markdown';

// Search-snippet formatting. snippet() returns the indexed text verbatim
// (raw user titles / markdown), so matches are delimited with private-use
// sentinels, the whole snippet is HTML-escaped, and only then are the
// sentinels replaced with <mark> tags. Sentinels typed by a user can at most
// add an extra empty or unbalanced <mark>; they cannot introduce other markup.

export const SNIPPET_MARK_OPEN = '\uE000';
export const SNIPPET_MARK_CLOSE = '\uE001';

export function formatSearchSnippet(raw: string | null | undefined): string {
  if (!raw) return '';
  return escapeHtml(raw)
    .split(SNIPPET_MARK_OPEN).join('<mark>')
    .split(SNIPPET_MARK_CLOSE).join('</mark>');
}
