// Parse a forum search snippet into plain-text segments for rendering as React
// text nodes. The worker HTML-escapes the snippet and adds only <mark>/</mark>
// around matched terms; this splits on exactly those two tags and decodes the
// entities escapeHtml emits. Anything else that looks like markup stays text,
// so the snippet is never handed to innerHTML.

export interface SnippetSegment {
  text: string;
  mark: boolean;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

function decode(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m);
}

export function parseSearchSnippet(snippet: string): SnippetSegment[] {
  const out: SnippetSegment[] = [];
  let mark = false;
  for (const part of snippet.split(/(<mark>|<\/mark>)/)) {
    if (part === '<mark>') {
      mark = true;
      continue;
    }
    if (part === '</mark>') {
      mark = false;
      continue;
    }
    if (part) out.push({ text: decode(part), mark });
  }
  return out;
}
