// "Shift trips…" (forum request: select several trips, move them all ±N min,
// e.g. every inbound trip +10 so blocking needs fewer vehicles). The pure plan
// (planShiftTrips), the block-conflict diff (newBlockOverlaps), the store write
// (shiftTrips, one undo step) and the selection helpers.
import { beforeEach, describe, expect, it } from 'vitest';
import { newBlockOverlaps, planShiftTrips, shiftTrips, SHIFT_MAX_MIN } from '../timetableBulkOps';
import { applyTripSelection, parseShiftMinutes, tripSelectionRange } from '../timetableGridHelpers';
import { useStore } from '../../../store';
import { historyDepths, historyTransaction, resetHistory, undo } from '../../../store/history';
import type { Frequency, StopTime, Trip } from '../../../types/gtfs';

const st = (trip_id: string, stop_sequence: number, arrival_time: string, departure_time = arrival_time): StopTime =>
  ({ trip_id, stop_id: `S${stop_sequence}`, stop_sequence, arrival_time, departure_time }) as StopTime;
const trip = (trip_id: string, extra: Partial<Trip> = {}): Trip =>
  ({ trip_id, route_id: 'R', service_id: 'WK', direction_id: 0, ...extra }) as Trip;
const ids = (...xs: string[]) => new Set(xs);

describe('planShiftTrips', () => {
  const stopTimes = [
    st('A', 1, '06:00:00'), st('A', 2, '06:10:00', '06:12:30'), st('A', 3, '06:20:00'),
    st('B', 1, '07:00:00'), st('B', 2, '07:10:00'),
    st('C', 1, '08:00:00'),
  ];

  it('moves every arrival and departure of the selected trips, keeping dwell and seconds', () => {
    const plan = planShiftTrips(stopTimes, [], ids('A', 'B'), 10);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const a = plan.stopTimes.filter((s) => s.trip_id === 'A');
    expect(a.map((s) => [s.arrival_time, s.departure_time])).toEqual([
      ['06:10:00', '06:10:00'], ['06:20:00', '06:22:30'], ['06:30:00', '06:30:00'],
    ]);
    expect(plan.stopTimes.filter((s) => s.trip_id === 'B').map((s) => s.arrival_time)).toEqual(['07:10:00', '07:20:00']);
    expect(plan.tripCount).toBe(2);
    expect(plan.stopTimeCount).toBe(5);
  });

  it('leaves unselected trips untouched (same object identity)', () => {
    const plan = planShiftTrips(stopTimes, [], ids('A'), 10);
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.stopTimes[5]).toBe(stopTimes[5]);
    expect(plan.stopTimes[3]).toBe(stopTimes[3]);
  });

  it('keeps blank (interpolated) times blank', () => {
    const plan = planShiftTrips([st('A', 1, '06:00:00'), st('A', 2, ''), st('A', 3, '06:20:00')], [], ids('A'), 5);
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.stopTimes.map((s) => s.arrival_time)).toEqual(['06:05:00', '', '06:25:00']);
    expect(plan.stopTimeCount).toBe(2);
  });

  it('crosses midnight into >24:00 GTFS times, and back', () => {
    const late = [st('N', 1, '23:55:00'), st('N', 2, '24:20:00', '24:21:00')];
    const fwd = planShiftTrips(late, [], ids('N'), 10);
    if (!fwd.ok) throw new Error(fwd.error);
    expect(fwd.stopTimes.map((s) => [s.arrival_time, s.departure_time])).toEqual([['24:05:00', '24:05:00'], ['24:30:00', '24:31:00']]);
    const back = planShiftTrips(fwd.stopTimes, [], ids('N'), -10);
    if (!back.ok) throw new Error(back.error);
    expect(back.stopTimes).toEqual(late);
  });

  it('rejects (never clamps) a shift that would go before 00:00, naming the trips', () => {
    const early = [st('E', 1, '00:05:00'), st('E', 2, '00:20:00'), st('F', 1, '06:00:00')];
    const plan = planShiftTrips(early, [], ids('E', 'F'), -10);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.offendingTripIds).toEqual(['E']);
    expect(plan.error).toMatch(/before 00:00/);
    expect(plan.error).toContain('E');
    // Exactly to midnight is fine.
    expect(planShiftTrips(early, [], ids('E'), -5).ok).toBe(true);
  });

  it('rejects zero, fractional, empty-selection and over-a-day shifts', () => {
    expect(planShiftTrips(stopTimes, [], ids('A'), 0).ok).toBe(false);
    expect(planShiftTrips(stopTimes, [], ids('A'), 2.5).ok).toBe(false);
    expect(planShiftTrips(stopTimes, [], ids(), 10).ok).toBe(false);
    expect(planShiftTrips(stopTimes, [], ids('A'), SHIFT_MAX_MIN + 1).ok).toBe(false);
    expect(planShiftTrips(stopTimes, [], ids('A'), SHIFT_MAX_MIN).ok).toBe(true);
  });

  it('moves a frequency template\'s windows with it (like Duplicate / Repeat)', () => {
    const freqs: Frequency[] = [
      { trip_id: 'A', start_time: '06:00:00', end_time: '09:00:00', headway_secs: 900, exact_times: 0 },
      { trip_id: 'A', start_time: '15:00:00', end_time: '23:50:00', headway_secs: 1200 },
      { trip_id: 'C', start_time: '08:00:00', end_time: '10:00:00', headway_secs: 600 },
    ];
    const plan = planShiftTrips(stopTimes, freqs, ids('A'), 15);
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.windowCount).toBe(2);
    expect(plan.frequencies[0]).toEqual({ ...freqs[0], start_time: '06:15:00', end_time: '09:15:00' });
    expect(plan.frequencies[1]).toMatchObject({ start_time: '15:15:00', end_time: '24:05:00', headway_secs: 1200 });
    expect(plan.frequencies[2]).toBe(freqs[2]);
  });

  it('a frequency window that would start before midnight blocks an earlier shift', () => {
    const freqs: Frequency[] = [{ trip_id: 'C', start_time: '00:05:00', end_time: '02:00:00', headway_secs: 600 }];
    const plan = planShiftTrips(stopTimes, freqs, ids('C'), -10);
    expect(plan.ok).toBe(false);
  });

  it('counts only trips that exist when given the feed\'s trip ids', () => {
    const plan = planShiftTrips(stopTimes, [], ids('A', 'ghost'), 5, ids('A', 'B', 'C'));
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.tripCount).toBe(1);
  });
});

describe('newBlockOverlaps', () => {
  // One vehicle (block X) runs A 06:00-06:30 then B 06:40-07:10.
  const trips = [trip('A', { block_id: 'X' }), trip('B', { block_id: 'X' }), trip('C')];
  const before = [st('A', 1, '06:00:00'), st('A', 2, '06:30:00'), st('B', 1, '06:40:00'), st('B', 2, '07:10:00'), st('C', 1, '06:00:00')];

  it('names an overlap the shift creates', () => {
    const plan = planShiftTrips(before, [], ids('A'), 15); // A now ends 06:45, after B starts
    if (!plan.ok) throw new Error(plan.error);
    const o = newBlockOverlaps(trips, [], before, plan.stopTimes);
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ blockId: 'X', serviceId: 'WK' });
    expect([o[0].tripA, o[0].tripB].sort()).toEqual(['A', 'B']);
  });

  it('is empty when the shift keeps the block feasible, or moves the whole block', () => {
    const small = planShiftTrips(before, [], ids('A'), 5);
    if (!small.ok) throw new Error(small.error);
    expect(newBlockOverlaps(trips, [], before, small.stopTimes)).toEqual([]);
    const both = planShiftTrips(before, [], ids('A', 'B'), 30);
    if (!both.ok) throw new Error(both.error);
    expect(newBlockOverlaps(trips, [], before, both.stopTimes)).toEqual([]);
  });

  it('does not re-report an overlap that already existed', () => {
    const clash = [st('A', 1, '06:00:00'), st('A', 2, '06:50:00'), st('B', 1, '06:40:00'), st('B', 2, '07:10:00')];
    const plan = planShiftTrips(clash, [], ids('C'), 5);
    if (!plan.ok) throw new Error(plan.error);
    expect(newBlockOverlaps(trips, [], clash, plan.stopTimes)).toEqual([]);
  });
});

describe('shiftTrips through the store', () => {
  const s = () => useStore.getState();
  beforeEach(() => {
    s().setTrips([trip('A', { block_id: 'X' }), trip('B', { block_id: 'X' }), trip('F')]);
    s().setStopTimes([st('A', 1, '06:00:00'), st('A', 2, '06:30:00'), st('B', 1, '07:00:00'), st('B', 2, '07:30:00'), st('F', 1, '08:00:00'), st('F', 2, '08:20:00')]);
    s().setFrequencies([{ trip_id: 'F', start_time: '08:00:00', end_time: '10:00:00', headway_secs: 900, exact_times: 0 }]);
    resetHistory();
  });

  it('shifts trips + frequency windows as ONE undo step, and never touches block_id', () => {
    const before = { stopTimes: s().stopTimes, frequencies: s().frequencies, trips: s().trips };
    // Same wrapping as the grid's withUndo (one historyTransaction).
    const plan = historyTransaction('shift trips', () => shiftTrips(ids('A', 'B', 'F'), 10));
    expect(plan.ok).toBe(true);
    expect(s().stopTimes.map((x) => x.arrival_time)).toEqual(['06:10:00', '06:40:00', '07:10:00', '07:40:00', '08:10:00', '08:30:00']);
    expect(s().frequencies[0]).toMatchObject({ start_time: '08:10:00', end_time: '10:10:00' });
    expect(s().trips.map((t) => t.block_id)).toEqual(['X', 'X', undefined]);
    expect(historyDepths().undo).toBe(1);
    undo();
    expect(s().stopTimes).toEqual(before.stopTimes);
    expect(s().frequencies).toEqual(before.frequencies);
    expect(historyDepths().undo).toBe(0);
  });

  it('a rejected shift writes nothing', () => {
    const before = s().stopTimes;
    const plan = historyTransaction('shift trips', () => shiftTrips(ids('A'), -400));
    expect(plan.ok).toBe(false);
    expect(s().stopTimes).toBe(before);
    expect(historyDepths().undo).toBe(0);
  });
});

describe('trip selection helpers', () => {
  const order = ['t1', 't2', 't3', 't4', 't5'];
  it('plain click toggles one; shift-click spans from the anchor, either direction', () => {
    expect(tripSelectionRange(order, 't2', 't4', false)).toEqual(['t4']);
    expect(tripSelectionRange(order, 't2', 't4', true)).toEqual(['t2', 't3', 't4']);
    expect(tripSelectionRange(order, 't5', 't3', true)).toEqual(['t3', 't4', 't5']);
    expect(tripSelectionRange(order, null, 't3', true)).toEqual(['t3']);
    expect(tripSelectionRange(order, 'gone', 't3', true)).toEqual(['t3']);
    expect(tripSelectionRange(order, 't1', 'missing', true)).toEqual([]);
  });

  it('applyTripSelection adds or removes a batch without mutating the old set', () => {
    const prev = new Set(['t1']);
    const next = applyTripSelection(prev, ['t2', 't3'], true);
    expect([...next].sort()).toEqual(['t1', 't2', 't3']);
    expect([...prev]).toEqual(['t1']);
    expect([...applyTripSelection(next, ['t1', 't3'], false)]).toEqual(['t2']);
  });

  it('parseShiftMinutes accepts signed whole minutes only', () => {
    expect(parseShiftMinutes('+10')).toBe(10);
    expect(parseShiftMinutes(' -5 ')).toBe(-5);
    expect(parseShiftMinutes('−15')).toBe(-15);
    expect(parseShiftMinutes('10')).toBe(10);
    expect(parseShiftMinutes('1.5')).toBeNull();
    expect(parseShiftMinutes('-')).toBeNull();
    expect(parseShiftMinutes('')).toBeNull();
  });
});
