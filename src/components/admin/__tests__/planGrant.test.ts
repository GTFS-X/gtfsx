import { describe, it, expect } from 'vitest';
import {
  EXPIRY_OPTIONS,
  customDateToTimestamp,
  describeExpiry,
  expiryToTimestamp,
} from '../planGrant';

describe('expiryToTimestamp', () => {
  const now = Date.UTC(2026, 5, 22, 12, 0, 0); // fixed reference
  const DAY = 24 * 60 * 60 * 1000;

  it('adds the given number of days to now', () => {
    expect(expiryToTimestamp(14, now)).toBe(now + 14 * DAY);
    expect(expiryToTimestamp(30, now)).toBe(now + 30 * DAY);
    expect(expiryToTimestamp(90, now)).toBe(now + 90 * DAY);
  });

  it('returns null for a null day count (no expiry)', () => {
    expect(expiryToTimestamp(null, now)).toBeNull();
  });

  it('defaults to Date.now() when no reference is passed', () => {
    const before = Date.now();
    const ts = expiryToTimestamp(1)!;
    const after = Date.now();
    expect(ts).toBeGreaterThanOrEqual(before + DAY);
    expect(ts).toBeLessThanOrEqual(after + DAY);
  });
});

describe('EXPIRY_OPTIONS', () => {
  it('offers the documented quick picks plus an open-ended option', () => {
    expect(EXPIRY_OPTIONS.map((o) => o.days)).toEqual([14, 30, 60, 90, null]);
  });
});

describe('customDateToTimestamp', () => {
  it('parses a YYYY-MM-DD value to an end-of-day timestamp', () => {
    const ts = customDateToTimestamp('2026-07-01');
    expect(ts).not.toBeNull();
    const d = new Date(ts!);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(6); // July (0-indexed)
    expect(d.getDate()).toBe(1);
    expect(d.getHours()).toBe(23); // end-of-day, local
  });

  it('returns null for empty or invalid input', () => {
    expect(customDateToTimestamp('')).toBeNull();
    expect(customDateToTimestamp('not-a-date')).toBeNull();
  });
});

describe('describeExpiry', () => {
  it('says "No expiry" for null/undefined', () => {
    expect(describeExpiry(null)).toBe('No expiry');
    expect(describeExpiry(undefined)).toBe('No expiry');
  });

  it('formats a timestamp as "Expires <date>"', () => {
    const ts = Date.UTC(2026, 6, 1, 12, 0, 0);
    expect(describeExpiry(ts)).toMatch(/^Expires /);
  });
});
