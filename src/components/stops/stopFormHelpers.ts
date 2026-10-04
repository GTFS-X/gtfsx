import type { Stop } from '../../types/gtfs';

/**
 * Parse a lat/lon text draft. Returns null for anything that isn't a complete,
 * in-range coordinate (blank, '-', '1.', 'abc', 91), so a half-typed value is
 * never written to the stop. The old `Number(e.target.value)` turned a cleared
 * field or a leading '-' into 0 and persisted it.
 */
export function parseCoordDraft(raw: string, kind: 'lat' | 'lon'): number | null {
  const t = raw.trim();
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  const limit = kind === 'lat' ? 90 : 180;
  if (n < -limit || n > limit) return null;
  return n;
}

/**
 * Valid parent_station candidates for a stop (GTFS stops.txt): a boarding area
 * (4) hangs off a platform (location_type 0, preferring platforms in the same
 * station); stops, entrances and generic nodes (0, 2, 3) hang off a station
 * (1). Stations have no parent. The stop's current parent stays listed even if
 * it no longer fits, so the select can render it.
 */
export function parentStationCandidates(stop: Stop, allStops: readonly Stop[]): Stop[] {
  const type = stop.location_type ?? 0;
  if (type === 1) return [];
  const wantType = type === 4 ? 0 : 1;
  const out = allStops.filter((s) =>
    s.stop_id !== stop.stop_id
    && ((s.location_type ?? 0) === wantType || s.stop_id === stop.parent_station));
  const byName = (a: Stop, b: Stop) => (a.stop_name || '').localeCompare(b.stop_name || '');
  if (type !== 4) return out.sort(byName);
  // Boarding areas: platforms that already belong to the same station as this
  // boarding area's current platform come first.
  const currentParent = allStops.find((s) => s.stop_id === stop.parent_station);
  const station = currentParent?.parent_station;
  const rank = (s: Stop) => (station && s.parent_station === station ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || byName(a, b));
}

/** GTFS requires parent_station for entrances, generic nodes and boarding areas. */
export function parentStationRequired(locationType: number | undefined): boolean {
  return locationType === 2 || locationType === 3 || locationType === 4;
}

/** Enter / Space activate a `role="button"` element, as they do a real button. */
export function isActivationKey(key: string): boolean {
  return key === 'Enter' || key === ' ' || key === 'Spacebar';
}
