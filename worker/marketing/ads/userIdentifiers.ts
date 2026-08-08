// Hashed user identifiers for Google's Data Manager API.
//
// The Data Manager `events:ingest` contract lets an event carry, alongside its
// ad click id, a `userData.userIdentifiers[]` list. We send exactly one kind of
// identifier: a customer email, normalized per Google's rules and hashed with
// SHA-256, hex-encoded. That is the single field this module owns.
//
//   Event.userData.userIdentifiers[].emailAddress = hex(sha256(normalized))
//
// Two hard rules that live here rather than at the call sites:
//   1. A plaintext email NEVER leaves this module. Callers hand in a raw
//      address and get back a hex digest (or null); nothing else is exposed.
//   2. A malformed or absent address yields `null`, never an empty string and
//      never an unhashed value. The uploader then simply omits `userData` for
//      that row — a missing identifier is fine, a wrong one is not.
//
// Normalization (https://developers.google.com/data-manager/api/devguides/concepts/formatting):
//   - trim surrounding whitespace, lowercase the whole address;
//   - ONLY for gmail.com / googlemail.com: drop '+' and everything after it in
//     the local part, and strip every '.' from the local part;
//   - every other domain keeps its dots and '+' tags untouched (case-folding
//     only) — `user.name+nyc@example.com` stays exactly that.
//
// Pinned worked examples (verified against `shasum -a 256`; see the unit tests):
//   cloudy.sanfrancisco+shopping@gmail.com
//     → cloudysanfrancisco@gmail.com
//     → 223ebda6f6889b1494551ba902d9d381daf2f642bae055888e96343d53e9f9c4
//   User.Name+NYC@Example.com
//     → user.name+nyc@example.com
//     → f109a2a632fbcea5fc82049f50beed3d8621bf9034399f437fb622222acccdac
//
// `crypto.subtle` is available in both workerd and Node ≥ 18, so this module is
// shared unchanged by the Worker and by scripts/oci-diagnose.ts.

/** Domains whose local part Google normalizes by stripping dots and '+' tags. */
const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * A deliberately conservative shape check, applied AFTER trimming. We are not
 * trying to be an RFC 5322 validator — we are trying to make sure we never hash
 * something that obviously is not an address (and so never send Google a
 * confidently-wrong identifier). Interior whitespace is rejected rather than
 * squeezed out: silently rewriting `a b@c.com` into `ab@c.com` would invent an
 * address nobody typed.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/** 64 lowercase hex characters — the only thing we will put on the wire. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Google's email normalization. Returns null when the input is absent or does
 * not look like an address, so callers can distinguish "no identifier" from
 * "identifier of an empty string".
 */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (!EMAIL_SHAPE.test(email)) return null;
  const at = email.lastIndexOf('@');
  const domain = email.slice(at + 1);
  let local = email.slice(0, at);
  if (GMAIL_DOMAINS.has(domain)) {
    // Order is irrelevant (dot-stripping can neither create nor remove a '+'),
    // but we drop the tag first so the dot-strip works on the shorter string.
    local = local.split('+')[0].replace(/\./g, '');
  }
  // `+tag@gmail.com` normalizes to an empty local part — not an address.
  if (local.length === 0) return null;
  return `${local}@${domain}`;
}

/** Lowercase hex of a digest buffer. */
function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * SHA-256 of the normalized address, hex-encoded — the exact value that goes
 * into `userData.userIdentifiers[].emailAddress` under a top-level
 * `encoding: "HEX"`. Returns null for an absent or malformed address.
 */
export async function hashEmailHex(raw: string | null | undefined): Promise<string | null> {
  const normalized = normalizeEmail(raw);
  if (normalized === null) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return toHex(digest);
}

/** True only for a well-formed lowercase SHA-256 hex digest. */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

/**
 * Log-safe rendering of a hash. Never log a full digest: it is a stable
 * pseudonymous identifier, and anyone holding a candidate address can confirm a
 * match against it. Mirrors how the diagnostic redacts click ids — short prefix
 * plus length, nothing reversible.
 */
export function redactHash(hash: string | null | undefined): string {
  if (!hash) return '(none)';
  return `${hash.slice(0, 8)}…[${hash.length} chars]`;
}
