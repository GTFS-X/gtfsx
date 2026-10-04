// Sanitizers for feed text rendered into the server-side embed pages.
//
// Published feed data is author-controlled, so every value that lands in an
// attribute with its own grammar (href, style) is validated here rather than
// trusted. JSON interpolated into inline scripts goes through
// worker/util/safeJson.ts instead.

const HEX6 = /^[0-9a-fA-F]{6}$/;

/**
 * A GTFS color (6 hex digits, no '#') or `fallback`. Surrounding whitespace is
 * tolerated, since real feeds carry it ("005B95 "); anything else (CSS
 * declarations, named colors, short hex) falls back.
 */
export function safeHex(raw: string | null | undefined, fallback: string): string {
  const v = (raw ?? '').trim();
  return HEX6.test(v) ? v : fallback;
}

/** An http(s) URL suitable for an href, normalized; null for anything else. */
export function safeLinkHref(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString();
  } catch {
    // not an absolute URL
  }
  return null;
}

/**
 * The dialable part of a phone number for a `tel:` href: digits, '+', and the
 * usual separators (whitespace dropped). Null when nothing dialable is left.
 */
export function safeTelHref(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^0-9+()\-.]/g, '');
  return /[0-9]/.test(cleaned) ? `tel:${cleaned}` : null;
}

/**
 * decodeURIComponent that returns null for malformed percent-encoding instead
 * of throwing URIError.
 */
export function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}
