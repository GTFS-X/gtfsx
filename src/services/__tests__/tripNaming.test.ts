import { describe, expect, it } from 'vitest';
import { mintTripId, mintTripIds, tripIdPrefixForRoute } from '../tripNaming';
import type { Route } from '../../types/gtfs';

const route = (over: Partial<Route>): Route => ({ route_id: 'r1', route_type: 3, ...over } as Route);

describe('tripIdPrefixForRoute', () => {
  it('prefers the short name, whitespace stripped', () => {
    expect(tripIdPrefixForRoute(route({ route_short_name: 'Blue', route_long_name: 'Blue Line' }))).toBe('Blue');
    expect(tripIdPrefixForRoute(route({ route_short_name: '10 X' }))).toBe('10X');
  });
  it('falls back to long name, then route_id, then T', () => {
    expect(tripIdPrefixForRoute(route({ route_long_name: 'Crosstown' }))).toBe('Crosstown');
    expect(tripIdPrefixForRoute(route({ route_id: '6850' }))).toBe('6850');
    expect(tripIdPrefixForRoute(undefined)).toBe('T');
  });
});

describe('mintTripId', () => {
  it('starts at 1 when no ids exist', () => {
    expect(mintTripId('Blue', new Set())).toBe('Blue-1');
  });

  it('takes the next number above the highest existing (next-highest, not gap-filling)', () => {
    // Existing B-1..B-3 → next mint is B-4.
    expect(mintTripId('B', new Set(['B-1', 'B-2', 'B-3']))).toBe('B-4');
    // Gaps are not filled — highest is 5, so next is 6 even though 2 and 4 are free.
    expect(mintTripId('B', new Set(['B-1', 'B-3', 'B-5']))).toBe('B-6');
  });

  it('both directions of a route share one sequence (prefix is route-level)', () => {
    // Outbound B-1, inbound B-2 already exist → the next trip in EITHER direction is B-3.
    expect(mintTripId('B', new Set(['B-1', 'B-2']))).toBe('B-3');
  });

  it('only counts ids matching the prefix exactly, ignoring other routes', () => {
    // "Brown-*" and "Blue-1x" must not bump the Blue sequence.
    expect(mintTripId('Blue', new Set(['Brown-9', 'Blue-1x', 'BlueX-4', 'Blue-2']))).toBe('Blue-3');
  });

  it('is deterministic for a given feed state', () => {
    const existing = new Set(['B-1', 'B-7']);
    expect(mintTripId('B', existing)).toBe(mintTripId('B', existing));
  });
});

describe('mintTripIds', () => {
  it('mints a unique sequential batch above the existing max', () => {
    expect(mintTripIds('Blue', 3, new Set(['Blue-1', 'Blue-2']))).toEqual(['Blue-3', 'Blue-4', 'Blue-5']);
  });
  it('batch entries never collide with each other or the existing set', () => {
    const ids = mintTripIds('B', 5, new Set(['B-1']));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.includes('B-1')).toBe(false);
  });
});
