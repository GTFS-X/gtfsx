// historyTransaction (S1-19) and the undo payload budget (S1-22).
//
// Before the transaction API, every store write was its own undo entry: a
// merge import of 150 trips pushed 150 entries, which both split one user
// action across 150 undos and (past HISTORY_LIMIT = 100) evicted all of the
// history before it.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../index';
import {
  historyTransaction, undo, redo, resetHistory, historyDepths, runWithoutHistory,
  setHistoryPayloadBudget, HISTORY_LIMIT, HISTORY_PAYLOAD_BUDGET, useHistoryUi,
} from '../history';
import type { Stop, Trip, StopTime } from '../../types/gtfs';

const s = () => useStore.getState();

function stop(id: string): Stop {
  return { stop_id: id, stop_name: id, stop_lat: 45, stop_lon: -111, location_type: 0 } as Stop;
}
function trip(id: string): Trip {
  return { trip_id: id, route_id: 'R', service_id: 'WK', direction_id: 0 } as Trip;
}

beforeEach(() => {
  s().setStops([]);
  s().setTrips([]);
  s().setStopTimes([]);
  resetHistory();
});
afterEach(() => {
  setHistoryPayloadBudget(HISTORY_PAYLOAD_BUDGET);
});

describe('historyTransaction', () => {
  it('records a 150-entity, many-write change as ONE undo step', () => {
    s().addStop(stop('pre'));
    expect(historyDepths().undo).toBe(1);

    historyTransaction('merge feed', () => {
      for (let i = 0; i < 150; i++) {
        s().addTrip(trip(`T${i}`));
        s().addStop(stop(`S${i}`));
      }
    });
    expect(s().trips).toHaveLength(150);
    expect(historyDepths().undo).toBe(2); // pre-existing entry survived
    expect(useHistoryUi.getState().undoLabel).toBe('merge feed');

    expect(undo()).toBe('merge feed');
    expect(s().trips).toHaveLength(0);
    expect(s().stops.map((x) => x.stop_id)).toEqual(['pre']);

    expect(redo()).toBe('merge feed');
    expect(s().trips).toHaveLength(150);
    expect(s().stops).toHaveLength(151);

    // The pre-transaction history is still there underneath.
    undo();
    undo();
    expect(s().stops).toHaveLength(0);
  });

  it('records nothing when fn changes no feed data, and returns fn’s value', () => {
    const v = historyTransaction('noop', () => 42);
    expect(v).toBe(42);
    expect(historyDepths().undo).toBe(0);
  });

  it('nested transactions collapse into the outer one', () => {
    historyTransaction('outer', () => {
      s().addStop(stop('a'));
      historyTransaction('inner', () => { s().addStop(stop('b')); });
      s().addStop(stop('c'));
    });
    expect(historyDepths().undo).toBe(1);
    undo();
    expect(s().stops).toHaveLength(0);
  });

  it('inside runWithoutHistory it records nothing', () => {
    runWithoutHistory(() => historyTransaction('x', () => s().addStop(stop('a'))));
    expect(s().stops).toHaveLength(1);
    expect(historyDepths().undo).toBe(0);
  });

  it('records what fn changed before throwing, and rethrows', () => {
    expect(() => historyTransaction('boom', () => {
      s().addStop(stop('a'));
      throw new Error('boom');
    })).toThrow('boom');
    expect(historyDepths().undo).toBe(1);
    undo();
    expect(s().stops).toHaveLength(0);
    // Recording resumes afterwards.
    s().addStop(stop('b'));
    expect(historyDepths().undo).toBe(1);
  });

  it('a new edit after a transaction clears redo, and undo marks the store dirty', () => {
    historyTransaction('t', () => s().addStop(stop('a')));
    undo();
    expect(historyDepths().redo).toBe(1);
    s().markSaved();
    redo();
    expect(s().isDirty).toBe(true);
    s().addStop(stop('b'));
    expect(historyDepths().redo).toBe(0);
  });
});

describe('undo payload budget (S1-22)', () => {
  function bulkReplace(n: number, tag: string) {
    const row: StopTime = { trip_id: tag, stop_id: 'S', stop_sequence: 0, arrival_time: '', departure_time: '' };
    s().setStopTimes(new Array(n).fill(row));
  }

  it('evicts the oldest entries once retained array payloads exceed the budget', () => {
    setHistoryPayloadBudget(1_000_000);
    for (let i = 0; i < 50; i++) bulkReplace(100_000, `b${i}`);
    // Each entry pins ~200k elements (new array + the one it replaced).
    expect(historyDepths().undo).toBeLessThan(50);
    expect(historyDepths().undo).toBeGreaterThan(0);
    expect(historyDepths().undo).toBeLessThanOrEqual(5);
    // The latest step is still undoable.
    undo();
    expect(s().stopTimes[0].trip_id).toBe('b48');
  });

  it('ordinary small edits still keep the full HISTORY_LIMIT depth', () => {
    setHistoryPayloadBudget(1_000_000);
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) s().addStop(stop(`s${i}`));
    expect(historyDepths().undo).toBe(HISTORY_LIMIT);
  });
});
