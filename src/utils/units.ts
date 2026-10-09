// Display units for distances and speeds (issue #76).
//
// Everything the app computes or stores stays in its native unit (GTFS
// meters, the analysis code's feet and miles, km for shape length). These
// helpers only turn a number into the label a person reads, in whichever
// system they picked. Imperial is the default.

export type UnitSystem = 'imperial' | 'metric';

export const DEFAULT_UNIT_SYSTEM: UnitSystem = 'imperial';

export const METERS_PER_FOOT = 0.3048;
export const METERS_PER_MILE = 1609.344;
export const METERS_PER_KM = 1000;

/** Long-distance readouts drop to the short unit below these. */
const IMPERIAL_SHORT_BELOW_MI = 0.1; // 528 ft
const METRIC_SHORT_BELOW_KM = 1; // 1,000 m

export function isUnitSystem(v: unknown): v is UnitSystem {
  return v === 'imperial' || v === 'metric';
}

export function feetToMeters(ft: number): number {
  return ft * METERS_PER_FOOT;
}
export function milesToMeters(mi: number): number {
  return mi * METERS_PER_MILE;
}
export function kmToMeters(km: number): number {
  return km * METERS_PER_KM;
}

function roundTo(n: number, step: number): number {
  return step > 0 ? Math.round(n / step) * step : n;
}

/* ── short distances: feet / meters ─────────────────────────────────── */

/** Unit label for short distances (stop spacing, thresholds). */
export function shortUnit(system: UnitSystem): 'ft' | 'm' {
  return system === 'metric' ? 'm' : 'ft';
}

/** Meters → the short unit's number (feet or meters), unrounded. */
export function metersToShort(meters: number, system: UnitSystem): number {
  return system === 'metric' ? meters : meters / METERS_PER_FOOT;
}

/** Short unit's number (feet or meters) → meters. */
export function shortToMeters(value: number, system: UnitSystem): number {
  return system === 'metric' ? value : value * METERS_PER_FOOT;
}

/** Feet (the stop-analysis code's native unit) → the short unit's number. */
export function feetToShort(ft: number, system: UnitSystem): number {
  return system === 'metric' ? feetToMeters(ft) : ft; // no float round-trip for ft
}

/** The short unit's number → feet. Inverse of {@link feetToShort}. */
export function shortToFeet(value: number, system: UnitSystem): number {
  return system === 'metric' ? value / METERS_PER_FOOT : value;
}

/**
 * A short distance as whole feet or meters, e.g. "1,320 ft" / "402 m". Never
 * switches up to miles/km — stop spacing reads best in one unit.
 * `roundStep` rounds to a coarser step (e.g. 5 → "~25 ft").
 */
export function formatShortDistance(
  meters: number,
  system: UnitSystem,
  opts: { roundStep?: number } = {},
): string {
  const n = roundTo(Math.round(metersToShort(meters, system)), opts.roundStep ?? 1);
  return `${n.toLocaleString('en-US')} ${shortUnit(system)}`;
}

/* ── long distances: miles / km ─────────────────────────────────────── */

/** Unit label for long distances. */
export function longUnit(system: UnitSystem): 'mi' | 'km' {
  return system === 'metric' ? 'km' : 'mi';
}

/** Spelled-out long unit, for prose and form hints ("miles" / "km"). */
export function longUnitWord(system: UnitSystem): 'miles' | 'km' {
  return system === 'metric' ? 'km' : 'miles';
}

export function metersToLong(meters: number, system: UnitSystem): number {
  return meters / (system === 'metric' ? METERS_PER_KM : METERS_PER_MILE);
}

export function longToMeters(value: number, system: UnitSystem): number {
  return value * (system === 'metric' ? METERS_PER_KM : METERS_PER_MILE);
}

/** Miles → the long unit's number (miles or km). */
export function milesToLong(mi: number, system: UnitSystem): number {
  return system === 'metric' ? milesToMeters(mi) / METERS_PER_KM : mi;
}

/** The long unit's number → miles. Inverse of {@link milesToLong}. */
export function longToMiles(value: number, system: UnitSystem): number {
  return system === 'metric' ? (value * METERS_PER_KM) / METERS_PER_MILE : value;
}

/**
 * A long distance in miles or km, e.g. "4.2 mi" / "6.8 km".
 *
 * With `shortBelow: true`, distances under 0.1 mi (imperial) or 1 km (metric)
 * are shown in the short unit instead ("350 ft" / "850 m").
 */
export function formatDistance(
  meters: number,
  system: UnitSystem,
  opts: { decimals?: number; shortBelow?: boolean } = {},
): string {
  const { decimals = 1, shortBelow = false } = opts;
  const long = metersToLong(meters, system);
  const threshold = system === 'metric' ? METRIC_SHORT_BELOW_KM : IMPERIAL_SHORT_BELOW_MI;
  if (shortBelow && Math.abs(long) < threshold) {
    return formatShortDistance(meters, system);
  }
  return `${long.toFixed(decimals)} ${longUnit(system)}`;
}

/* ── walk-buffer labels (¼ mi / ½ mi) ───────────────────────────────── */

const MILE_FRACTIONS: Record<number, { slash: string; glyph: string }> = {
  0.25: { slash: '1/4', glyph: '¼' },
  0.5: { slash: '1/2', glyph: '½' },
  0.75: { slash: '3/4', glyph: '¾' },
};

/**
 * A planning-buffer distance given in miles: "1/4 mi" (or "¼ mi" with
 * `glyph`) in imperial; the metric equivalent rounded to 50 m ("400 m") in
 * metric, since the buffers are quarter-mile conventions, not exact metric
 * distances.
 */
export function formatBufferMiles(
  miles: number,
  system: UnitSystem,
  opts: { glyph?: boolean } = {},
): string {
  if (system === 'metric') {
    return `${roundTo(milesToMeters(miles), 50).toLocaleString('en-US')} m`;
  }
  const frac = MILE_FRACTIONS[miles];
  return `${frac ? (opts.glyph ? frac.glyph : frac.slash) : miles} mi`;
}

/** Adjective form for prose: "1/4-mile" / "400-meter". */
export function formatBufferMilesAdjective(miles: number, system: UnitSystem): string {
  if (system === 'metric') return `${roundTo(milesToMeters(miles), 50)}-meter`;
  const frac = MILE_FRACTIONS[miles];
  return `${frac ? frac.slash : miles}-mile`;
}

/** A buffer range: "¼–½ mi" / "400–800 m". */
export function formatBufferMilesRange(
  lo: number,
  hi: number,
  system: UnitSystem,
  opts: { glyph?: boolean; dash?: string } = {},
): string {
  const dash = opts.dash ?? '–';
  const strip = (s: string) => s.replace(/ (mi|m)$/, '');
  const unit = system === 'metric' ? 'm' : 'mi';
  return `${strip(formatBufferMiles(lo, system, opts))}${dash}${strip(formatBufferMiles(hi, system, opts))} ${unit}`;
}

/* ── speed ──────────────────────────────────────────────────────────── */

export function speedUnit(system: UnitSystem): 'mph' | 'km/h' {
  return system === 'metric' ? 'km/h' : 'mph';
}

/** Miles per hour → the speed unit's number (mph or km/h). */
export function mphToSpeed(mph: number, system: UnitSystem): number {
  return system === 'metric' ? (mph * METERS_PER_MILE) / METERS_PER_KM : mph;
}

/** The speed unit's number → mph. Inverse of {@link mphToSpeed}. */
export function speedToMph(value: number, system: UnitSystem): number {
  return system === 'metric' ? (value * METERS_PER_KM) / METERS_PER_MILE : value;
}

/** A speed given in mph, e.g. "20 mph" / "32 km/h". */
export function formatSpeed(mph: number, system: UnitSystem, opts: { decimals?: number } = {}): string {
  return `${mphToSpeed(mph, system).toFixed(opts.decimals ?? 0)} ${speedUnit(system)}`;
}

/* ── persistence ────────────────────────────────────────────────────── */

export const UNIT_SYSTEM_STORAGE_KEY = 'gb_unit_system';

export function loadUnitSystem(): UnitSystem {
  try {
    if (typeof window === 'undefined') return DEFAULT_UNIT_SYSTEM;
    const raw = window.localStorage.getItem(UNIT_SYSTEM_STORAGE_KEY);
    return isUnitSystem(raw) ? raw : DEFAULT_UNIT_SYSTEM;
  } catch {
    return DEFAULT_UNIT_SYSTEM;
  }
}

export function persistUnitSystem(system: UnitSystem): void {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(UNIT_SYSTEM_STORAGE_KEY, system);
  } catch {
    // localStorage blocked (private mode etc.) — the choice lasts the session.
  }
}
