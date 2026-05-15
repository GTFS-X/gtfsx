import type { Env } from '../env';
import type { AuthorDto, ForumProfileDto } from './types';

// MD5 is used by Gravatar — not for security, only as an identifier. Web Crypto
// doesn't expose MD5, so we ship a tiny implementation. ~30 lines is cheaper
// than a dependency.

export async function md5Hex(input: string): Promise<string> {
  // Use a JS MD5; Crypto.subtle doesn't support it.
  return md5(input);
}

export function slugify(input: string, fallback = 'thread'): string {
  const slug = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')        // strip combining marks
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || fallback;
}

export async function userAuthorDto(
  env: Env,
  userId: string,
): Promise<AuthorDto> {
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.display_name as account_display_name,
            f.forum_display_name, f.gravatar_opt_out
       FROM user u
       LEFT JOIN forum_user_state f ON f.user_id = u.id
       WHERE u.id = ?`,
  )
    .bind(userId)
    .first<{
      id: string;
      email: string;
      account_display_name: string;
      forum_display_name: string | null;
      gravatar_opt_out: number | null;
    }>();

  if (!row) {
    return { id: userId, displayName: 'Deleted user', gravatarHash: null };
  }

  const displayName = row.forum_display_name?.trim() || row.account_display_name || 'Member';
  const gravatarHash = row.gravatar_opt_out ? null : await md5Hex(row.email.trim().toLowerCase());

  return { id: row.id, displayName, gravatarHash };
}

export async function loadForumProfile(env: Env, userId: string, isStaff: boolean): Promise<ForumProfileDto> {
  const row = await env.DB.prepare(
    `SELECT u.email, u.display_name as account_display_name,
            f.forum_display_name, f.gravatar_opt_out,
            f.email_pref_replies, f.email_pref_subscribed, f.email_pref_mark_solved,
            f.email_pref_admin_alerts, f.email_pref_all_off
       FROM user u
       LEFT JOIN forum_user_state f ON f.user_id = u.id
       WHERE u.id = ?`,
  )
    .bind(userId)
    .first<{
      email: string;
      account_display_name: string;
      forum_display_name: string | null;
      gravatar_opt_out: number | null;
      email_pref_replies: number | null;
      email_pref_subscribed: number | null;
      email_pref_mark_solved: number | null;
      email_pref_admin_alerts: number | null;
      email_pref_all_off: number | null;
    }>();

  if (!row) {
    throw new Error(`User ${userId} not found while loading forum profile`);
  }

  const optOut = row.gravatar_opt_out === 1;
  const hash = optOut ? null : await md5Hex(row.email.trim().toLowerCase());

  return {
    userId,
    displayName: row.forum_display_name,
    gravatarHash: hash,
    gravatarOptOut: optOut,
    emailPrefs: {
      replies: row.email_pref_replies !== 0,
      subscribed: row.email_pref_subscribed !== 0,
      markSolved: row.email_pref_mark_solved !== 0,
      adminAlerts: row.email_pref_admin_alerts !== 0,
      allOff: row.email_pref_all_off === 1,
    },
    isStaff,
    needsDisplayName: !row.forum_display_name || !row.forum_display_name.trim(),
  };
}

// True if this user can write to the forum right now: has a forum display name
// set and isn't banned. Used by every state-changing endpoint.
export async function canWriteToForum(env: Env, userId: string): Promise<{ ok: boolean; reason?: 'needs_display_name' | 'banned' }> {
  const row = await env.DB.prepare(
    `SELECT forum_display_name, banned_until FROM forum_user_state WHERE user_id = ?`,
  )
    .bind(userId)
    .first<{ forum_display_name: string | null; banned_until: number | null }>();

  if (!row || !row.forum_display_name || !row.forum_display_name.trim()) {
    return { ok: false, reason: 'needs_display_name' };
  }
  if (row.banned_until && row.banned_until > Date.now()) {
    return { ok: false, reason: 'banned' };
  }
  return { ok: true };
}

// ─── MD5 implementation (RFC 1321) ──────────────────────────────────────────
// Public-domain port. Returns lowercase hex. ~80 lines is cheaper than a
// dependency, and gravatar requires MD5 specifically.

function md5(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const words = bytesToWords(bytes);
  const bitLen = bytes.length * 8;
  // Append 0x80, pad with zeros to 56 mod 64, then append 64-bit bit length.
  words[bitLen >>> 5] |= 0x80 << (bitLen & 31);
  // 14 = position of length field in last 16-word block.
  const padIdx = (((bitLen + 64) >>> 9) << 4) + 14;
  while (words.length <= padIdx + 1) words.push(0);
  words[padIdx] = bitLen;
  words[padIdx + 1] = 0;

  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;

  for (let i = 0; i < words.length; i += 16) {
    const aa = a, bb = b, cc = c, dd = d;

    a = ff(a, b, c, d, words[i + 0], 7, -680876936);
    d = ff(d, a, b, c, words[i + 1], 12, -389564586);
    c = ff(c, d, a, b, words[i + 2], 17, 606105819);
    b = ff(b, c, d, a, words[i + 3], 22, -1044525330);
    a = ff(a, b, c, d, words[i + 4], 7, -176418897);
    d = ff(d, a, b, c, words[i + 5], 12, 1200080426);
    c = ff(c, d, a, b, words[i + 6], 17, -1473231341);
    b = ff(b, c, d, a, words[i + 7], 22, -45705983);
    a = ff(a, b, c, d, words[i + 8], 7, 1770035416);
    d = ff(d, a, b, c, words[i + 9], 12, -1958414417);
    c = ff(c, d, a, b, words[i + 10], 17, -42063);
    b = ff(b, c, d, a, words[i + 11], 22, -1990404162);
    a = ff(a, b, c, d, words[i + 12], 7, 1804603682);
    d = ff(d, a, b, c, words[i + 13], 12, -40341101);
    c = ff(c, d, a, b, words[i + 14], 17, -1502002290);
    b = ff(b, c, d, a, words[i + 15], 22, 1236535329);

    a = gg(a, b, c, d, words[i + 1], 5, -165796510);
    d = gg(d, a, b, c, words[i + 6], 9, -1069501632);
    c = gg(c, d, a, b, words[i + 11], 14, 643717713);
    b = gg(b, c, d, a, words[i + 0], 20, -373897302);
    a = gg(a, b, c, d, words[i + 5], 5, -701558691);
    d = gg(d, a, b, c, words[i + 10], 9, 38016083);
    c = gg(c, d, a, b, words[i + 15], 14, -660478335);
    b = gg(b, c, d, a, words[i + 4], 20, -405537848);
    a = gg(a, b, c, d, words[i + 9], 5, 568446438);
    d = gg(d, a, b, c, words[i + 14], 9, -1019803690);
    c = gg(c, d, a, b, words[i + 3], 14, -187363961);
    b = gg(b, c, d, a, words[i + 8], 20, 1163531501);
    a = gg(a, b, c, d, words[i + 13], 5, -1444681467);
    d = gg(d, a, b, c, words[i + 2], 9, -51403784);
    c = gg(c, d, a, b, words[i + 7], 14, 1735328473);
    b = gg(b, c, d, a, words[i + 12], 20, -1926607734);

    a = hh(a, b, c, d, words[i + 5], 4, -378558);
    d = hh(d, a, b, c, words[i + 8], 11, -2022574463);
    c = hh(c, d, a, b, words[i + 11], 16, 1839030562);
    b = hh(b, c, d, a, words[i + 14], 23, -35309556);
    a = hh(a, b, c, d, words[i + 1], 4, -1530992060);
    d = hh(d, a, b, c, words[i + 4], 11, 1272893353);
    c = hh(c, d, a, b, words[i + 7], 16, -155497632);
    b = hh(b, c, d, a, words[i + 10], 23, -1094730640);
    a = hh(a, b, c, d, words[i + 13], 4, 681279174);
    d = hh(d, a, b, c, words[i + 0], 11, -358537222);
    c = hh(c, d, a, b, words[i + 3], 16, -722521979);
    b = hh(b, c, d, a, words[i + 6], 23, 76029189);
    a = hh(a, b, c, d, words[i + 9], 4, -640364487);
    d = hh(d, a, b, c, words[i + 12], 11, -421815835);
    c = hh(c, d, a, b, words[i + 15], 16, 530742520);
    b = hh(b, c, d, a, words[i + 2], 23, -995338651);

    a = ii(a, b, c, d, words[i + 0], 6, -198630844);
    d = ii(d, a, b, c, words[i + 7], 10, 1126891415);
    c = ii(c, d, a, b, words[i + 14], 15, -1416354905);
    b = ii(b, c, d, a, words[i + 5], 21, -57434055);
    a = ii(a, b, c, d, words[i + 12], 6, 1700485571);
    d = ii(d, a, b, c, words[i + 3], 10, -1894986606);
    c = ii(c, d, a, b, words[i + 10], 15, -1051523);
    b = ii(b, c, d, a, words[i + 1], 21, -2054922799);
    a = ii(a, b, c, d, words[i + 8], 6, 1873313359);
    d = ii(d, a, b, c, words[i + 15], 10, -30611744);
    c = ii(c, d, a, b, words[i + 6], 15, -1560198380);
    b = ii(b, c, d, a, words[i + 13], 21, 1309151649);
    a = ii(a, b, c, d, words[i + 4], 6, -145523070);
    d = ii(d, a, b, c, words[i + 11], 10, -1120210379);
    c = ii(c, d, a, b, words[i + 2], 15, 718787259);
    b = ii(b, c, d, a, words[i + 9], 21, -343485551);

    a = add32(a, aa);
    b = add32(b, bb);
    c = add32(c, cc);
    d = add32(d, dd);
  }
  return wordToHex(a) + wordToHex(b) + wordToHex(c) + wordToHex(d);
}

function bytesToWords(bytes: Uint8Array): number[] {
  const words: number[] = [];
  for (let i = 0; i < bytes.length; i += 4) {
    words.push(
      (bytes[i] ?? 0)
      | ((bytes[i + 1] ?? 0) << 8)
      | ((bytes[i + 2] ?? 0) << 16)
      | ((bytes[i + 3] ?? 0) << 24),
    );
  }
  return words;
}

function wordToHex(n: number): string {
  let out = '';
  for (let i = 0; i < 4; i++) {
    const b = (n >>> (i * 8)) & 0xff;
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}

function add32(a: number, b: number): number {
  return (a + b) | 0;
}

function cmn(q: number, a: number, b: number, x: number, s: number, t: number): number {
  const sum = add32(add32(a, q), add32(x, t));
  return add32((sum << s) | (sum >>> (32 - s)), b);
}

function ff(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number {
  return cmn((b & c) | (~b & d), a, b, x, s, t);
}

function gg(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number {
  return cmn((b & d) | (c & ~d), a, b, x, s, t);
}

function hh(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number {
  return cmn(b ^ c ^ d, a, b, x, s, t);
}

function ii(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number {
  return cmn(c ^ (b | ~d), a, b, x, s, t);
}
