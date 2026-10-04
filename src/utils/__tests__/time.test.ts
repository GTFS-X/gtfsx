// S2-14 (rounding/clamping), S2-19 (mm/ss > 59), C2-02 (overnight suffix
// round trip) for utils/time.
import { describe, expect, it } from 'vitest';
import { formatTimeShort, normalizeTimeInput, secondsToGtfsTime } from '../time';

describe('secondsToGtfsTime', () => {
  it('rounds fractional seconds and clamps negatives', () => {
    expect(secondsToGtfsTime(90.6)).toBe('00:01:31');
    expect(secondsToGtfsTime(28867.5)).toBe('08:01:08');
    expect(secondsToGtfsTime(-5)).toBe('00:00:00');
    expect(secondsToGtfsTime(25 * 3600)).toBe('25:00:00');
  });
});

describe('normalizeTimeInput', () => {
  it('rejects minutes or seconds above 59', () => {
    expect(normalizeTimeInput('7:75')).toBe('');
    expect(normalizeTimeInput('7:30:99')).toBe('');
    expect(normalizeTimeInput('25:30')).toBe('25:30:00');
  });

  it('round-trips the overnight display form', () => {
    for (const t of ['25:30:00', '24:00:00', '49:05:00']) {
      expect(normalizeTimeInput(formatTimeShort(t))).toBe(t);
    }
    expect(normalizeTimeInput('01:35 +1d')).toBe('25:35:00');
    expect(normalizeTimeInput('+1 04:30')).toBe('28:30:00');
  });
});
