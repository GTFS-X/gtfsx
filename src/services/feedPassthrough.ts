// Round-trip for the parts of an imported feed the editor does not model.
//
// Two mechanisms, both store-free (this module runs inside the import Web
// Worker as well as on the main thread):
//
//  1. PASSTHROUGH FILES — any file in the imported ZIP that the editor neither
//     reads nor writes (calendar_attributes.txt, realtime_routes.txt, a README,
//     a PDF…) is kept verbatim with the feed and written back, byte for byte,
//     into every exported ZIP. Text that is valid UTF-8 is held as a string (so
//     the saved working state stays readable and compresses well); anything
//     else is held as base64. Either way the bytes written on export are the
//     bytes that were imported.
//
//  2. EXTRA COLUMNS — on the simple one-row-per-entity files (EXTRA_COLUMN_FILES),
//     columns the editor does not model are kept PER ROW on the entity itself,
//     under `_extra`. Because they ride on the entity: rows created in the
//     editor have none (blank cells on export), deleted rows take theirs with
//     them, and an id rename keeps them attached. `_`-prefixed keys are already
//     stripped from CSV output, so `_extra` never leaks as a column of its own;
//     the exporter flattens it back into columns (withExtraColumns).
//
// The rule in both cases: the modeled data wins. A passthrough file whose name
// the editor writes, or an extra column the editor now models, is dropped at
// export rather than written twice.

/** One unmodelled file, kept verbatim. `name` is the path inside the ZIP,
 *  relative to the feed root (a feed nested in a subfolder is flattened to the
 *  root on export, and its extra files move with it). */
export interface PassthroughFile {
  name: string;
  encoding: 'utf8' | 'base64';
  data: string;
}

/** Combined size of the files kept verbatim. They live in the working state
 *  (IndexedDB, the cloud save, every snapshot), so an archive that ships a
 *  large unrelated attachment must not balloon the feed state. Files past the
 *  budget are reported and dropped, as before. */
export const PASSTHROUGH_MAX_BYTES = 20 * 1024 * 1024;

/** OS clutter that is never feed content. */
export function isJunkZipEntry(path: string): boolean {
  if (/(^|\/)__MACOSX\//.test(path)) return true;
  const base = path.split('/').pop() ?? path;
  if (!base) return true;
  if (base.startsWith('.')) return true; // .DS_Store, ._foo, .gitkeep
  return /^(thumbs\.db|desktop\.ini)$/i.test(base);
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Keep `bytes` as text when they are valid UTF-8 (a BOM included: ignoreBOM
 *  keeps it in the string so re-encoding reproduces it), else as base64. */
export function encodePassthroughFile(name: string, bytes: Uint8Array): PassthroughFile {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return { name, encoding: 'utf8', data: text };
  } catch {
    return { name, encoding: 'base64', data: bytesToBase64(bytes) };
  }
}

export function passthroughBytes(file: PassthroughFile): Uint8Array {
  return file.encoding === 'base64'
    ? base64ToBytes(file.data)
    : new TextEncoder().encode(file.data);
}

/** A stored entry that is safe to write into a ZIP: well-formed, a relative
 *  path with no `..` segments, and not OS clutter. Guards against a corrupt or
 *  hand-edited saved state. */
export function isWritablePassthrough(f: unknown): f is PassthroughFile {
  if (!f || typeof f !== 'object') return false;
  const { name, encoding, data } = f as Partial<PassthroughFile>;
  if (typeof name !== 'string' || typeof data !== 'string') return false;
  if (encoding !== 'utf8' && encoding !== 'base64') return false;
  if (!name || name.startsWith('/') || name.split('/').some((seg) => seg === '..' || seg === '')) return false;
  return !isJunkZipEntry(name);
}

/** Files whose unmodelled columns are kept per row (see module comment). They
 *  are the files whose rows map one-to-one onto a stored entity that the
 *  exporter writes back row for row. Others (shapes, feed_info, translations,
 *  the Flex and Fares tables) still report unmodelled columns as dropped. */
export const EXTRA_COLUMN_FILES: ReadonlySet<string> = new Set([
  'agency.txt', 'routes.txt', 'stops.txt', 'trips.txt', 'stop_times.txt',
  'calendar.txt', 'calendar_dates.txt',
]);

export const EXTRA_KEY = '_extra';

/** The columns of `row` the editor doesn't model, as `{ _extra: {...} }` to
 *  spread into the entity — or `{}` when there are none, so entities from a
 *  feed without custom columns carry no extra key at all (no memory cost on a
 *  multi-million-row stop_times). Blank cells are not stored: a row without a
 *  value exports as a blank cell anyway. */
export function extraColumnsOf(
  row: Record<string, unknown>,
  known: ReadonlySet<string>,
): { _extra?: Record<string, string> } {
  let extra: Record<string, string> | undefined;
  for (const key of Object.keys(row)) {
    if (key === '__parsed_extra') continue; // PapaParse: cells beyond the header
    const col = key.trim();
    if (!col || known.has(col)) continue;
    const v = row[key];
    if (v === undefined || v === null || v === '') continue;
    (extra ??= {})[col] = String(v);
  }
  return extra ? { _extra: extra } : {};
}

/** Flatten an entity's `_extra` columns onto its already-cleaned CSV row.
 *  A column the row already carries, or one the editor models for this file,
 *  wins over the stored copy. */
export function withExtraColumns(
  clean: Record<string, unknown>,
  entity: object,
  known: ReadonlySet<string>,
): Record<string, unknown> {
  const extra = (entity as { _extra?: unknown })._extra;
  if (!extra || typeof extra !== 'object') return clean;
  for (const [k, v] of Object.entries(extra as Record<string, unknown>)) {
    if (k in clean || known.has(k) || k.startsWith('_')) continue;
    clean[k] = v;
  }
  return clean;
}
