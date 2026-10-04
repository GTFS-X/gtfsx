// Validator rule fixes: single block-overlap message (S1-25), Fares v2 per spec
// (C3-07, C3-08/NEW-5, C3-09), VALIDATION_INPUT_KEYS (C3-11), O(n) decreasing-
// distance check (S2-15), translations-fix undo (S2-24).
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../store';
import { runValidation, VALIDATION_INPUT_KEYS } from '../validation';
import { findDecreasingStopTimeDistances } from '../validationQuality';
import { getValidationFix } from '../validationFixes';
import type { FareTransferRule, StopTime, Trip } from '../../types/gtfs';

function reset() {
  const s = useStore.getState();
  s.setAgencies([{ agency_id: 'A', agency_name: 'A', agency_url: 'https://x.test', agency_timezone: 'America/Denver' }]);
  s.setCalendars([{ service_id: 'WK', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0, start_date: '20260101', end_date: '20991231' }]);
  s.setCalendarDates([]);
  s.setRoutes([{ route_id: 'R', agency_id: 'A', route_short_name: 'R', route_long_name: '', route_type: 3, route_color: '000000', route_text_color: 'FFFFFF' }]);
  s.setStops([
    { stop_id: 'a', stop_name: 'a', stop_lat: 45, stop_lon: -111, location_type: 0, wheelchair_boarding: 1 },
    { stop_id: 'b', stop_name: 'b', stop_lat: 45.01, stop_lon: -111, location_type: 0, wheelchair_boarding: 1 },
  ]);
  s.setTrips([]); s.setStopTimes([]); s.setFlexZones([]);
  s.setFareProducts([]); s.setFareLegRules([]); s.setFareTransferRules([]); s.setTimeframes([]);
  s.setRiderCategories([]); s.setFareMedia([]); s.setTranslations([]);
}
beforeEach(reset);

const errors = () => runValidation(useStore.getState()).filter((m) => m.severity === 'error').map((m) => m.message);

describe('S1-25 block overlaps', () => {
  it('two overlapping trips in "Block 12" yield exactly one message naming the whole block id', () => {
    const s = useStore.getState();
    s.setTrips([
      { trip_id: 't1', route_id: 'R', service_id: 'WK', direction_id: 0, block_id: 'Block 12' },
      { trip_id: 't2', route_id: 'R', service_id: 'WK', direction_id: 0, block_id: 'Block 12' },
    ]);
    const st = (t: string, a: string, b: string): StopTime[] => [
      { trip_id: t, stop_id: 'a', stop_sequence: 1, arrival_time: a, departure_time: a },
      { trip_id: t, stop_id: 'b', stop_sequence: 2, arrival_time: b, departure_time: b },
    ];
    s.setStopTimes([...st('t1', '08:00:00', '09:00:00'), ...st('t2', '08:30:00', '09:30:00')]);
    const overlap = runValidation(useStore.getState()).filter((m) => /overlap/i.test(m.message));
    expect(overlap).toHaveLength(1);
    expect(overlap[0].message).toContain('Block 12');
  });
});

describe('Fares v2', () => {
  beforeEach(() => {
    const s = useStore.getState();
    s.setFareProducts([{ fare_product_id: 'P', amount: '2', currency: 'USD' }]);
    s.setFareLegRules([{ leg_group_id: 'L1', fare_product_id: 'P' }, { leg_group_id: 'L2', fare_product_id: 'P' }]);
  });
  const withRule = (r: Partial<FareTransferRule>) =>
    useStore.getState().setFareTransferRules([{ fare_transfer_type: 0, from_leg_group_id: 'L1', to_leg_group_id: 'L2', ...r }]);

  it('a type-1 or type-2 transfer rule needs no product (C3-07)', () => {
    withRule({ fare_transfer_type: 1 });
    expect(errors()).toEqual([]);
    withRule({ fare_transfer_type: 2 });
    expect(errors()).toEqual([]);
  });

  it('duration_limit and duration_limit_type come as a pair; type 3 is valid', () => {
    withRule({ duration_limit: 600 });
    expect(errors().some((m) => /duration_limit_type/.test(m))).toBe(true);
    withRule({ duration_limit_type: 1 });
    expect(errors().some((m) => /without a duration_limit/.test(m))).toBe(true);
    withRule({ duration_limit: 600, duration_limit_type: 3 });
    expect(errors()).toEqual([]);
  });

  it('transfer_count is required within one leg group and forbidden across groups', () => {
    withRule({ to_leg_group_id: 'L1' });
    expect(errors().some((m) => /no transfer_count/.test(m))).toBe(true);
    withRule({ to_leg_group_id: 'L1', transfer_count: -1 });
    expect(errors()).toEqual([]);
    withRule({ to_leg_group_id: 'L1', transfer_count: 0 });
    expect(errors().some((m) => /transfer_count 0/.test(m))).toBe(true);
    withRule({ transfer_count: 2 });
    expect(errors().some((m) => /forbidden/.test(m))).toBe(true);
  });

  it('adult and senior rows of one product are not duplicates (C3-08 / NEW-5)', () => {
    const s = useStore.getState();
    s.setRiderCategories([
      { rider_category_id: 'adult', rider_category_name: 'Adult' },
      { rider_category_id: 'senior', rider_category_name: 'Senior' },
    ]);
    s.setFareProducts([
      { fare_product_id: 'P', amount: '2', currency: 'USD', rider_category_id: 'adult' },
      { fare_product_id: 'P', amount: '1', currency: 'USD', rider_category_id: 'senior' },
    ]);
    expect(errors()).toEqual([]);
    s.setFareProducts([
      { fare_product_id: 'P', amount: '2', currency: 'USD', rider_category_id: 'adult' },
      { fare_product_id: 'P', amount: '3', currency: 'USD', rider_category_id: 'adult' },
    ]);
    expect(errors().some((m) => /defined 2 times/.test(m))).toBe(true);
  });

  it('timeframes: start/end pairing and ≤ 24:00:00 (C3-09)', () => {
    const s = useStore.getState();
    s.setTimeframes([{ timeframe_group_id: 'PEAK', service_id: 'WK', start_time: '07:00:00' }]);
    expect(errors().some((m) => /without end_time/.test(m))).toBe(true);
    s.setTimeframes([{ timeframe_group_id: 'PEAK', service_id: 'WK', start_time: '07:00:00', end_time: '24:00:00' }]);
    expect(errors()).toEqual([]);
    s.setTimeframes([{ timeframe_group_id: 'PEAK', service_id: 'WK', start_time: '07:00:00', end_time: '25:00:00' }]);
    expect(errors().some((m) => /at most 24:00:00/.test(m))).toBe(true);
  });
});

describe('C3-11 VALIDATION_INPUT_KEYS', () => {
  it('names real store keys, including translations and feedInfo', () => {
    const state = useStore.getState() as unknown as Record<string, unknown>;
    for (const k of VALIDATION_INPUT_KEYS) expect(k in state).toBe(true);
    expect(VALIDATION_INPUT_KEYS).toContain('translations');
    expect(VALIDATION_INPUT_KEYS).toContain('feedInfo');
  });
});

describe('S2-15 findDecreasingStopTimeDistances is linear', () => {
  it('handles 30k trips quickly and keeps trip order', () => {
    const trips: Trip[] = [];
    const sts: StopTime[] = [];
    for (let i = 0; i < 30_000; i++) {
      trips.push({ trip_id: `t${i}`, route_id: 'R', service_id: 'WK', direction_id: 0 });
      sts.push(
        { trip_id: `t${i}`, stop_id: 'a', stop_sequence: 1, arrival_time: '', departure_time: '', shape_dist_traveled: 10 },
        { trip_id: `t${i}`, stop_id: 'b', stop_sequence: 2, arrival_time: '', departure_time: '', shape_dist_traveled: i % 1000 === 0 ? 5 : 20 },
      );
    }
    const t0 = performance.now();
    const out = findDecreasingStopTimeDistances(trips, sts);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(out.map((f) => f.trip_id).slice(0, 3)).toEqual(['t0', 't1000', 't2000']);
  });
});

describe('S2-24 translations fix undo', () => {
  it('re-inserts only the removed rows, keeping later edits', () => {
    const s = useStore.getState();
    s.setTranslations([
      { table_name: 'routes', field_name: 'route_long_name', language: 'es', translation: 'Uno', record_id: 'R' },
      { table_name: 'routes', field_name: 'route_long_name', language: 'fr', translation: 'X', record_id: 'NOPE' },
    ]);
    const result = getValidationFix('remove-invalid-translations')!.apply!({ id: '1', severity: 'warning', message: '' });
    expect(useStore.getState().translations).toHaveLength(1);
    useStore.getState().addTranslation({ table_name: 'routes', field_name: 'route_long_name', language: 'de', translation: 'Eins', record_id: 'R' });
    result.undo?.();
    const langs = useStore.getState().translations.map((t) => t.language);
    expect(langs).toEqual(['es', 'fr', 'de']);
  });
});
