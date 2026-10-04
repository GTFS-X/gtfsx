// Blocks editor helpers: Quick Block / Unblock as one undo step (C2-27) and the
// list view's overlap set matching the Gantt's (C2-22).
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../../store';
import { undo, resetHistory, historyDepths } from '../../../store/history';
import { applyBlockAssignment, commitBlockAssignment, blockOverlapTripIds } from '../blockAssign';
import { findBlockOverlaps } from '../../../services/blockBuilder';
import type { StopTime, Trip } from '../../../types/gtfs';

const s = () => useStore.getState();

function trip(id: string, block?: string, service = 'WK'): Trip {
  return { trip_id: id, route_id: 'R', service_id: service, direction_id: 0, block_id: block } as Trip;
}
function st(tripId: string, seq: number, time: string): StopTime {
  return { trip_id: tripId, stop_id: `S${seq}`, stop_sequence: seq, arrival_time: time, departure_time: time } as StopTime;
}

beforeEach(() => {
  s().setTrips([]);
  s().setStopTimes([]);
  s().setFrequencies([]);
  resetHistory();
});

describe('applyBlockAssignment', () => {
  it('clears a stale block_id on a scope trip the builder left out', () => {
    const trips = [trip('A', 'OLD'), trip('B', 'OLD'), trip('OUT', 'KEEP')];
    const next = applyBlockAssignment(trips, new Set(['A', 'B']), new Map([['A', 'B1']]));
    expect(next?.map((t) => t.block_id)).toEqual(['B1', undefined, 'KEEP']);
  });

  it('returns null when nothing changes', () => {
    const trips = [trip('A', 'B1'), trip('B')];
    expect(applyBlockAssignment(trips, new Set(['A', 'B']), new Map([['A', 'B1']]))).toBeNull();
  });
});

describe('commitBlockAssignment', () => {
  it('Quick Block over many trips is ONE undo step that restores every block_id', () => {
    const trips = Array.from({ length: 150 }, (_, i) => trip(`T${i}`, i === 0 ? 'STALE' : undefined));
    s().setTrips(trips);
    resetHistory();
    const assignment = new Map(trips.slice(1).map((t, i) => [t.trip_id, `B${i % 5}`]));
    expect(commitBlockAssignment('quick block', new Set(trips.map((t) => t.trip_id)), assignment)).toBe(true);
    expect(historyDepths().undo).toBe(1);
    expect(s().trips[0].block_id).toBeUndefined(); // untimed T0 lost its stale id
    expect(s().trips[1].block_id).toBe('B0');

    expect(undo()).toBe('quick block');
    expect(s().trips[0].block_id).toBe('STALE');
    expect(s().trips.slice(1).every((t) => !t.block_id)).toBe(true);
  });

  it('Unblock all is ONE undo step', () => {
    s().setTrips([trip('A', 'B1'), trip('B', 'B1'), trip('C', 'B2')]);
    resetHistory();
    commitBlockAssignment('unblock all', new Set(['A', 'B', 'C']), new Map());
    expect(s().trips.every((t) => !t.block_id)).toBe(true);
    expect(historyDepths().undo).toBe(1);
    undo();
    expect(s().trips.map((t) => t.block_id)).toEqual(['B1', 'B1', 'B2']);
  });
});

describe('blockOverlapTripIds', () => {
  it('matches the Gantt overlap set and ignores a frequency template carrying a block_id', () => {
    const trips = [trip('A', 'B1'), trip('B', 'B1'), trip('F', 'B1'), trip('C', 'B2')];
    const stopTimes = [
      st('A', 1, '08:00:00'), st('A', 2, '09:00:00'),
      st('B', 1, '08:30:00'), st('B', 2, '09:30:00'), // overlaps A
      st('F', 1, '08:10:00'), st('F', 2, '08:40:00'), // frequency template inside A's span
      st('C', 1, '08:00:00'), st('C', 2, '09:00:00'),
    ];
    const freqs = [{ trip_id: 'F', start_time: '06:00:00', end_time: '10:00:00', headway_secs: 600 }];
    const flagged = blockOverlapTripIds(trips, stopTimes, freqs);
    const gantt = new Set<string>();
    for (const o of findBlockOverlaps(trips.filter((t) => t.trip_id !== 'F'), stopTimes)) {
      gantt.add(o.tripA); gantt.add(o.tripB);
    }
    expect([...flagged].sort()).toEqual([...gantt].sort());
    expect([...flagged].sort()).toEqual(['A', 'B']);
  });

  it('uses numeric times, so an unpadded 9:00:00 orders before 10:00:00', () => {
    const trips = [trip('A', 'B1'), trip('B', 'B1')];
    const stopTimes = [
      st('A', 1, '9:00:00'), st('A', 2, '9:50:00'),
      st('B', 1, '10:00:00'), st('B', 2, '10:30:00'),
    ];
    expect(blockOverlapTripIds(trips, stopTimes, []).size).toBe(0);
  });
});
