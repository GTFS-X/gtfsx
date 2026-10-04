// Serialize JSON for embedding inside an inline <script> element (including
// <script type="application/ld+json">).
//
// JSON.stringify does not escape '<', '>' or '&', so a string value containing
// a closing script tag (or an HTML comment opener) would end the script element
// early and let the rest of the value be parsed as markup. U+2028/U+2029 are
// legal in JSON strings but were line terminators in pre-ES2019 JavaScript.
// Each is replaced with its \uXXXX escape, which decodes to the identical
// value in both JavaScript and JSON.

const SCRIPT_UNSAFE = /[<>&\u2028\u2029]/g;

function escapeChar(ch: string): string {
  return `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
}

/** Escape an already-serialized JSON string for an inline script. */
export function escapeJsonForScript(json: string): string {
  return json.replace(SCRIPT_UNSAFE, escapeChar);
}

/** JSON.stringify(value), made safe to interpolate into an inline script. */
export function safeJsonForScript(value: unknown): string {
  return escapeJsonForScript(JSON.stringify(value) ?? 'null');
}
