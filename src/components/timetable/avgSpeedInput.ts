// "Average speed" field of the Generate-trips drawer. The value is stored and
// threaded through the run-time estimate in mph (estimateRunSecs's native
// unit); these helpers only translate to/from the number a person types, in
// their unit preference (mph imperial, km/h metric).
import { mphToSpeed, speedToMph, speedUnit, type UnitSystem } from '../../utils/units';
import { MAX_AVG_SPEED_MPH, MIN_AVG_SPEED_MPH } from '../../services/timetableGen';

/** Accepted range in the display unit — whole numbers, rounded inward so a
 *  value at either end converts back inside the mph range. */
export function avgSpeedBounds(system: UnitSystem): { min: number; max: number } {
  return {
    min: Math.ceil(mphToSpeed(MIN_AVG_SPEED_MPH, system) - 1e-9),
    max: Math.floor(mphToSpeed(MAX_AVG_SPEED_MPH, system) + 1e-9),
  };
}

/** mph → the input's text in the display unit (≤ 1 decimal, no trailing ".0"). */
export function formatAvgSpeedInput(mph: number, system: UnitSystem): string {
  return String(Math.round(mphToSpeed(mph, system) * 10) / 10);
}

export type AvgSpeedParse = { ok: true; mph: number } | { ok: false; error: string };

/** Parse typed text (display unit) → mph, enforcing {@link avgSpeedBounds}. */
export function parseAvgSpeedInput(text: string, system: UnitSystem): AvgSpeedParse {
  const { min, max } = avgSpeedBounds(system);
  const n = Number(text.trim());
  if (text.trim() === '' || !Number.isFinite(n) || n < min || n > max) {
    return { ok: false, error: `Average speed must be between ${min} and ${max} ${speedUnit(system)}.` };
  }
  return { ok: true, mph: speedToMph(n, system) };
}
