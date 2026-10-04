// Pure helpers shared by the fare editors (GTFS-Fares v1 and v2). Kept out of
// the .tsx files so they can be unit-tested without a DOM.
import type {
  FareLegRule,
  FareProduct,
  FareRule,
  FareTransferRule,
  Timeframe,
} from '../../types/gtfs';
import type { FareV2RemovalResult } from '../../store/fareV2Slice';
import { gtfsTimeToSeconds, normalizeTimeInput } from '../../utils/time';

// ── v1 fare types (encoded as a fare_id prefix) ──────────────────────────────

export const FARE_TYPES = ['Regular', 'Reduced', 'Senior', 'Student', 'Free'] as const;
export type FareType = (typeof FARE_TYPES)[number];

// GTFS spec has no fare_type field; we encode the type as a fare_id prefix
// (e.g. "senior-fare1") so the choice survives export/import. "Regular" is
// the default and stays prefix-less so feeds without typed fares look natural.
const TYPE_PREFIXES: Record<Exclude<FareType, 'Regular'>, string> = {
  Reduced: 'reduced',
  Senior: 'senior',
  Student: 'student',
  Free: 'free',
};

export function parseFareType(fareId: string): FareType {
  const first = fareId.split('-')[0]?.toLowerCase() ?? '';
  for (const [type, prefix] of Object.entries(TYPE_PREFIXES)) {
    if (first === prefix) return type as FareType;
  }
  return 'Regular';
}

/** Swap the fare_id's type prefix. Prefix matching is case-insensitive, like
 *  parseFareType, so an imported "Senior-1" is recognised and rewritten. */
export function applyTypePrefix(fareId: string, newType: FareType): string {
  // Strip any existing recognized prefix first.
  let suffix = fareId;
  const lower = fareId.toLowerCase();
  for (const prefix of Object.values(TYPE_PREFIXES)) {
    if (lower.startsWith(prefix + '-')) {
      suffix = fareId.slice(prefix.length + 1);
      break;
    }
  }
  if (newType === 'Regular') return suffix;
  return `${TYPE_PREFIXES[newType]}-${suffix}`;
}

export function ensureUniqueFareId(base: string, existing: readonly string[], self: string): string {
  if (base === self) return base;
  if (!existing.includes(base)) return base;
  for (let n = 2; ; n++) {
    const cand = `${base}-${n}`;
    if (!existing.includes(cand)) return cand;
  }
}

// ── v1 fare_rules ────────────────────────────────────────────────────────────

/** A fare_rules row that scopes a fare to a route and nothing else. Zone-pair
 *  (origin/destination) and contains rules are not route rules, even when a
 *  route_id is also present. */
export function isRouteRule(r: FareRule): boolean {
  return !!r.route_id && !r.origin_id && !r.destination_id && !r.contains_id;
}

/** Indices (into fareRules) of the route rules for one fare. */
export function routeRuleIndices(fareRules: readonly FareRule[], fareId: string): number[] {
  const out: number[] = [];
  fareRules.forEach((r, i) => { if (r.fare_id === fareId && isRouteRule(r)) out.push(i); });
  return out;
}

// ── Fares v2 delete refusals ─────────────────────────────────────────────────

interface RemovalContext {
  fareLegRules: readonly FareLegRule[];
  fareTransferRules: readonly FareTransferRule[];
  fareProducts: readonly FareProduct[];
}

const MAX_LISTED = 4;

function listed(labels: string[]): string {
  const uniq = [...new Set(labels)];
  if (uniq.length <= MAX_LISTED) return uniq.join(', ');
  return `${uniq.slice(0, MAX_LISTED).join(', ')} and ${uniq.length - MAX_LISTED} more`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function legRuleLabel(rule: FareLegRule | undefined, index: number): string {
  if (!rule) return `leg rule #${index + 1}`;
  return rule.leg_group_id ? `group ${rule.leg_group_id}` : `leg rule #${index + 1}`;
}

export function transferRuleLabel(rule: FareTransferRule | undefined, index: number): string {
  if (!rule) return `transfer rule #${index + 1}`;
  return `${rule.from_leg_group_id || 'any'} → ${rule.to_leg_group_id || 'any'}`;
}

export function productRowLabel(p: FareProduct | undefined, index: number): string {
  if (!p) return `product row #${index + 1}`;
  const scope = [p.rider_category_id, p.fare_media_id].filter(Boolean).join(' / ');
  return scope ? `${p.fare_product_id} (${scope})` : p.fare_product_id;
}

/**
 * Turn a refused Fares v2 delete into a sentence naming what is in the way,
 * e.g. `Can't delete this area: it is used by 2 leg rules (group LG1, leg rule
 * #3). Change or remove those first.` Returns null when the delete went through.
 */
export function describeRemovalBlockers(
  subject: string,
  result: FareV2RemovalResult,
  ctx: RemovalContext,
): string | null {
  if (result.removed) return null;
  const parts: string[] = [];
  if (result.fareLegRules.length) {
    parts.push(`${plural(result.fareLegRules.length, 'leg rule', 'leg rules')} (${
      listed(result.fareLegRules.map((i) => legRuleLabel(ctx.fareLegRules[i], i)))})`);
  }
  if (result.fareTransferRules.length) {
    parts.push(`${plural(result.fareTransferRules.length, 'transfer rule', 'transfer rules')} (${
      listed(result.fareTransferRules.map((i) => transferRuleLabel(ctx.fareTransferRules[i], i)))})`);
  }
  if (result.fareProducts.length) {
    parts.push(`${plural(result.fareProducts.length, 'fare product', 'fare products')} (${
      listed(result.fareProducts.map((i) => productRowLabel(ctx.fareProducts[i], i)))})`);
  }
  const used = parts.length === 0 ? 'other fare rows'
    : parts.length === 1 ? parts[0]
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `Can't delete ${subject}: it is used by ${used}. Change or remove those first.`;
}

// ── Fares v2 products (composite key) ────────────────────────────────────────

export interface ProductGroup {
  id: string;
  rows: { product: FareProduct; index: number }[];
}

/** Group fare_products rows by fare_product_id in first-seen order, keeping
 *  each row's index into fareProducts. One product id may have a row per
 *  rider category / fare medium (primary key is the triple). */
export function groupProductRows(products: readonly FareProduct[]): ProductGroup[] {
  const m = new Map<string, ProductGroup>();
  products.forEach((product, index) => {
    let g = m.get(product.fare_product_id);
    if (!g) { g = { id: product.fare_product_id, rows: [] }; m.set(product.fare_product_id, g); }
    g.rows.push({ product, index });
  });
  return [...m.values()];
}

/** Distinct product ids, for pickers in the leg/transfer editors. */
export function uniqueProductIds(products: readonly FareProduct[]): FareProduct[] {
  const seen = new Set<string>();
  return products.filter((p) => {
    if (seen.has(p.fare_product_id)) return false;
    seen.add(p.fare_product_id);
    return true;
  });
}

/** True when applying `updates` to row `index` would duplicate another row's
 *  (fare_product_id, rider_category_id, fare_media_id). */
export function productRowCollides(
  products: readonly FareProduct[],
  index: number,
  updates: Partial<FareProduct>,
): boolean {
  const row = products[index];
  if (!row) return false;
  const next = { ...row, ...updates };
  return products.some((p, i) => i !== index
    && p.fare_product_id === next.fare_product_id
    && (p.rider_category_id ?? '') === (next.rider_category_id ?? '')
    && (p.fare_media_id ?? '') === (next.fare_media_id ?? ''));
}

// ── Fares v2 transfer rules (spec enums) ─────────────────────────────────────

export const TRANSFER_TYPES: { value: 0 | 1 | 2; label: string; hint: string }[] = [
  {
    value: 0,
    label: 'Pay first leg + transfer product (A + AB)',
    hint: 'The rider pays the first leg plus this rule’s product. Use for a transfer fee or an upgrade charge.',
  },
  {
    value: 1,
    label: 'Pay both legs + transfer product (A + AB + B)',
    hint: 'The rider pays both legs plus this rule’s product. Leave the product empty when the transfer adds nothing.',
  },
  {
    value: 2,
    label: 'Transfer product replaces both legs (AB)',
    hint: 'The rider pays only this rule’s product for the combined journey. Leave it empty for a free combined trip.',
  },
];

export const DURATION_TYPES: { value: 0 | 1 | 2 | 3; label: string }[] = [
  { value: 0, label: 'Departure of current leg → arrival of next leg' },
  { value: 1, label: 'Departure of current leg → departure of next leg' },
  { value: 2, label: 'Arrival of current leg → departure of next leg' },
  { value: 3, label: 'Arrival of current leg → arrival of next leg' },
];

export function transferTypeLabel(t: number): string {
  return TRANSFER_TYPES.find((x) => x.value === t)?.label ?? `Type ${t}`;
}

/** Inline hints for a transfer rule's conditionally-required fields (mirrors
 *  the validator's checks so the editor explains them where they're set). */
export function transferRuleHints(rule: FareTransferRule): string[] {
  const out: string[] = [];
  const sameGroup = !!rule.from_leg_group_id && rule.from_leg_group_id === rule.to_leg_group_id;
  if (sameGroup && rule.transfer_count == null) {
    out.push('Transfer count is required when From and To are the same leg group (-1 = unlimited).');
  }
  if (!sameGroup && rule.transfer_count != null) {
    out.push('Transfer count is only allowed when From and To are the same leg group.');
  }
  if (rule.transfer_count != null && (rule.transfer_count === 0 || rule.transfer_count < -1)) {
    out.push('Transfer count must be -1 (unlimited) or 1 or more.');
  }
  if (rule.duration_limit != null && rule.duration_limit_type == null) {
    out.push('Pick a duration limit type: it is required when a duration limit is set.');
  }
  if (rule.duration_limit == null && rule.duration_limit_type != null) {
    out.push('Duration limit type is only allowed with a duration limit.');
  }
  return out;
}

// ── Fares v2 timeframes ──────────────────────────────────────────────────────

/**
 * Parse a typed timeframe time. Returns undefined for blank (= service day
 * start/end), the normalised HH:MM:SS string, or null when it can't be parsed
 * or is past 24:00:00 (the spec's maximum for timeframes).
 */
export function parseTimeframeTime(raw: string): string | undefined | null {
  if (!raw.trim()) return undefined;
  const t = normalizeTimeInput(raw);
  if (!t) return null;
  if (gtfsTimeToSeconds(t) > 24 * 3600) return null;
  return t;
}

/** Problem with a timeframe row's start/end pair, or null. */
export function timeframeRowIssue(tf: Timeframe): string | null {
  const hasStart = !!tf.start_time;
  const hasEnd = !!tf.end_time;
  if (hasStart !== hasEnd) {
    return 'Set both start and end, or leave both blank for the whole service day.';
  }
  for (const t of [tf.start_time, tf.end_time]) {
    if (t && gtfsTimeToSeconds(t) > 24 * 3600) return 'Times can be at most 24:00:00.';
  }
  return null;
}
