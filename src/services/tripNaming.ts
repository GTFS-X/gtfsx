// Pithy, collision-safe trip_id minting for NEWLY created trips. One shared
// scheme across every create path (Generate, Repeat, Duplicate, + Add trip,
// copy-from-service) so new trips read like "Blue-1", "Blue-2", … instead of
// verbose ids like "6850-d0-weekday-0600" or "1blue700".
//
// Scheme: `${prefix}-${N}` where the prefix is the route's short name (the
// obvious, unambiguous choice — bare initials collide across routes, e.g. Blue
// vs Brown) and N is the next number ABOVE the highest existing `${prefix}-<n>`
// in the whole feed (next-highest, not gap-filling). Both directions of a route
// share the sequence (the prefix is route-level, not direction-level). Never
// renames existing or imported trips — only mints ids for new ones.

import type { Route } from '../types/gtfs';

/** The route's pithy trip-id prefix: its short name (whitespace stripped), else
 *  a compact long name, else the route_id, else 'T'. */
export function tripIdPrefixForRoute(
  route: Pick<Route, 'route_short_name' | 'route_long_name' | 'route_id'> | undefined | null,
): string {
  const raw = (route?.route_short_name || route?.route_long_name || route?.route_id || 'T').trim();
  const compact = raw.replace(/\s+/g, '');
  return compact || 'T';
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The next free sequence number for `${prefix}-<n>`: one above the highest
 *  existing such id (0 → 1 when none exist). */
function nextTripNumber(prefix: string, existing: Set<string>): number {
  const re = new RegExp(`^${escapeRegExp(prefix)}-(\\d+)$`);
  let max = 0;
  for (const id of existing) {
    const m = re.exec(id);
    if (m) {
      const n = Number(m[1]);
      if (n > max) max = n;
    }
  }
  return max + 1;
}

/** Mint one pithy trip id unique against `existing`. Deterministic for a given
 *  feed state. */
export function mintTripId(prefix: string, existing: Set<string>): string {
  let n = nextTripNumber(prefix, existing);
  let id = `${prefix}-${n}`;
  // Defensive: `${prefix}-${max+1}` is free by construction, but a non-numeric
  // collision (e.g. someone literally named a trip "Blue-1x") can't recur here;
  // still, guard so a mint never returns a taken id.
  while (existing.has(id)) { n += 1; id = `${prefix}-${n}`; }
  return id;
}

/** Mint `count` sequential ids, each unique against `existing` AND the others in
 *  the batch. */
export function mintTripIds(prefix: string, count: number, existing: Set<string>): string[] {
  const seen = new Set(existing);
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = mintTripId(prefix, seen);
    seen.add(id);
    out.push(id);
  }
  return out;
}
