import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UNIT_SYSTEM,
  feetToMeters,
  feetToShort,
  formatBufferMiles,
  formatBufferMilesAdjective,
  formatBufferMilesRange,
  formatDistance,
  formatShortDistance,
  formatSpeed,
  isUnitSystem,
  kmToMeters,
  longToMiles,
  milesToLong,
  milesToMeters,
  mphToSpeed,
  shortToFeet,
  speedToMph,
} from '../units';

describe('units: defaults', () => {
  it('defaults to imperial', () => {
    expect(DEFAULT_UNIT_SYSTEM).toBe('imperial');
  });
  it('recognises only the two systems', () => {
    expect(isUnitSystem('imperial')).toBe(true);
    expect(isUnitSystem('metric')).toBe(true);
    expect(isUnitSystem('si')).toBe(false);
    expect(isUnitSystem(null)).toBe(false);
  });
});

describe('formatShortDistance', () => {
  it('shows whole feet in imperial, with thousands separators', () => {
    expect(formatShortDistance(feetToMeters(1320), 'imperial')).toBe('1,320 ft');
    expect(formatShortDistance(feetToMeters(612.4), 'imperial')).toBe('612 ft');
  });
  it('shows whole meters in metric', () => {
    expect(formatShortDistance(402.336, 'metric')).toBe('402 m');
    expect(formatShortDistance(1234.5, 'metric')).toBe('1,235 m');
  });
  it('keeps 0 (co-located stops) instead of dropping it', () => {
    expect(formatShortDistance(0, 'imperial')).toBe('0 ft');
    expect(formatShortDistance(0, 'metric')).toBe('0 m');
  });
  it('rounds to a coarser step when asked', () => {
    expect(formatShortDistance(8, 'imperial', { roundStep: 5 })).toBe('25 ft');
    expect(formatShortDistance(3, 'imperial', { roundStep: 5 })).toBe('10 ft');
  });
});

describe('formatDistance', () => {
  it('shows miles / km to one decimal by default', () => {
    expect(formatDistance(kmToMeters(10), 'imperial')).toBe('6.2 mi');
    expect(formatDistance(kmToMeters(10), 'metric')).toBe('10.0 km');
  });
  it('honours decimals', () => {
    expect(formatDistance(milesToMeters(1.234), 'imperial', { decimals: 2 })).toBe('1.23 mi');
  });
  it('falls back to the short unit below 0.1 mi / 1 km when shortBelow is set', () => {
    expect(formatDistance(milesToMeters(0.05), 'imperial', { shortBelow: true })).toBe('264 ft');
    expect(formatDistance(milesToMeters(0.2), 'imperial', { decimals: 2, shortBelow: true })).toBe('0.20 mi');
    expect(formatDistance(850, 'metric', { shortBelow: true })).toBe('850 m');
    expect(formatDistance(1500, 'metric', { decimals: 2, shortBelow: true })).toBe('1.50 km');
  });
  it('without shortBelow, short distances stay in the long unit', () => {
    expect(formatDistance(100, 'metric')).toBe('0.1 km');
  });
});

describe('buffer labels', () => {
  it('imperial uses the quarter-mile fractions', () => {
    expect(formatBufferMiles(0.25, 'imperial')).toBe('1/4 mi');
    expect(formatBufferMiles(0.5, 'imperial')).toBe('1/2 mi');
    expect(formatBufferMiles(0.5, 'imperial', { glyph: true })).toBe('½ mi');
    expect(formatBufferMiles(0.75, 'imperial', { glyph: true })).toBe('¾ mi');
    expect(formatBufferMiles(2, 'imperial')).toBe('2 mi');
  });
  it('metric rounds the equivalent to 50 m', () => {
    expect(formatBufferMiles(0.25, 'metric')).toBe('400 m');
    expect(formatBufferMiles(0.5, 'metric')).toBe('800 m');
    expect(formatBufferMiles(0.75, 'metric')).toBe('1,200 m');
  });
  it('adjective and range forms', () => {
    expect(formatBufferMilesAdjective(0.25, 'imperial')).toBe('1/4-mile');
    expect(formatBufferMilesAdjective(0.5, 'metric')).toBe('800-meter');
    expect(formatBufferMilesRange(0.25, 0.5, 'imperial', { glyph: true })).toBe('¼–½ mi');
    expect(formatBufferMilesRange(0.25, 0.5, 'imperial', { dash: '-' })).toBe('1/4-1/2 mi');
    expect(formatBufferMilesRange(0.25, 0.5, 'metric')).toBe('400–800 m');
  });
});

describe('speed', () => {
  it('formats mph and km/h', () => {
    expect(formatSpeed(20, 'imperial')).toBe('20 mph');
    expect(formatSpeed(20, 'metric')).toBe('32 km/h');
    expect(formatSpeed(25, 'metric', { decimals: 1 })).toBe('40.2 km/h');
  });
  it('round-trips', () => {
    expect(speedToMph(mphToSpeed(17, 'metric'), 'metric')).toBeCloseTo(17, 10);
    expect(speedToMph(17, 'imperial')).toBe(17);
  });
});

describe('input conversions', () => {
  it('feet <-> short unit is exact in imperial', () => {
    expect(feetToShort(600, 'imperial')).toBe(600);
    expect(shortToFeet(600, 'imperial')).toBe(600);
  });
  it('feet <-> meters in metric', () => {
    expect(feetToShort(1000, 'metric')).toBeCloseTo(304.8, 10);
    expect(shortToFeet(304.8, 'metric')).toBeCloseTo(1000, 10);
  });
  it('miles <-> long unit', () => {
    expect(milesToLong(0.75, 'imperial')).toBe(0.75);
    expect(milesToLong(1, 'metric')).toBeCloseTo(1.609344, 10);
    expect(longToMiles(1.609344, 'metric')).toBeCloseTo(1, 10);
  });
});
