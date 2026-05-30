// PII / secret redaction for error logs (NF-72). Worker logs land in Cloudflare
// Workers Observability, which captures console.* output verbatim — so we scrub
// the few things that realistically leak into an error message or stack trace
// before logging: user emails, auth tokens, known secret-key formats, the
// session cookie, and sensitive query-string params.
//
// Deliberately targeted (not a blanket "redact any long string") so normal
// stack-trace lines, file paths, and request IDs survive intact and stay
// debuggable. errorDetail() is the convenience wrapper the worker's error
// sinks use; other modules can adopt it when they log error contents.

const PATTERNS: Array<[RegExp, string]> = [
  // Email addresses.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  // Authorization header values: "Bearer <token>", "Basic <creds>".
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]'],
  // Stripe-style secret/key formats: sk_live_…, pk_test_…, rk_live_…, whsec_….
  // Keep the live/test designator (handy in logs); redact only the secret tail.
  [/\b((?:sk|pk|rk)_(?:live|test)_|whsec_)[A-Za-z0-9]{6,}/g, '$1[redacted]'],
  // Our session cookie value.
  [/gb_session=[^;\s"']+/g, 'gb_session=[redacted]'],
  // Sensitive query-string params (verify/magic tokens, passwords, api keys…).
  [/([?&](?:token|password|secret|api[_-]?key|key|code|access_token|refresh_token)=)[^&\s"']+/gi, '$1[redacted]'],
];

export function redactPii(input: string): string {
  let out = input;
  for (const [re, replacement] of PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

// Turn an unknown thrown value into a redacted, loggable string. Prefers the
// stack (most useful for debugging) and falls back to the message / String().
export function errorDetail(err: unknown): string {
  if (err instanceof Error) {
    return redactPii(err.stack ?? `${err.name}: ${err.message}`);
  }
  return redactPii(typeof err === 'string' ? err : safeStringify(err));
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
