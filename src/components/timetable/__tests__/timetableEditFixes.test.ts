// Regression tests for the timetable editor fixes in the codebase review
// (C2-01, C2-03, C2-04, C2-05, C2-06, C2-07, C2-08, C2-10, C2-11, C2-12,
// C2-13, C2-19, C2-25, C2-26). The frontend suite runs in a node environment
// without a DOM, so interaction logic is exercised through the pure helpers the
// components call, store-level ops through the real store, and the drawers
// through react-dom/server static markup.
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  cascadePrevTime, cellCommitDecision, cellEditUpdate, checkFrequencyDrawer, computeRowErrors,
  frequencyTimeLabel, lastTimedTrip, needsDefaultCalendar, planCascade, resolveActiveServiceId,
  rowTimeValue, sortTripsByStart, timepointSeqs, tripStartSec,
} from '../timetableGridHelpers';
import { copyTripsToService, repeatTrip, withContinuousOverride } from '../timetableBulkOps';
import { FrequencyDrawer, RepeatDrawer } from '../TimetableDrawers';
import { allServiceIds } from '../../../services/serviceIds';
import { formatTimeShort, gtfsTimeToSeconds } from '../../../utils/time';
import { useStore } from '../../../store';
import { historyDepths, historyTransaction, resetHistory, undo } from '../../../store/history';
import type { CalendarDate, StopTime, Trip } from '../../../types/gtfs';

const read = (f: string) => readFileSync(fileURLToPath(new URL(`../${f}`, import.meta.url)), 'utf8');

/* ─────────── C2-01 / C2-11: focus + blur must not rewrite a stop_time ─────────── */
describe('cellCommitDecision (C2-01, C2-11)', () => {
  it('skips when the text is what the cell showed on focus (focus/blur, Tab-through)', () => {
    // 08:05:30 displays as "08:05"; committing that would drop the seconds.
    const shown = formatTimeShort('08:05:30');
    expect(cellCommitDecision(shown, shown)).toEqual({ kind: 'skip' });
    expect(cellCommitDecision(` ${shown} `, shown)).toEqual({ kind: 'skip' });
  });

  it('skips a blank half that stays blank (no accidental clear of the other half)', () => {
    expect(cellCommitDecision('', '')).toEqual({ kind: 'skip' });
  });

  it('still commits an explicit retype, a clear, and flags garbage', () => {
    expect(cellCommitDecision('08:07', '08:05')).toEqual({ kind: 'commit', value: '08:07:00' });
    expect(cellCommitDecision('', '08:05')).toEqual({ kind: 'commit', value: '' });
    expect(cellCommitDecision('abc', '08:05')).toEqual({ kind: 'invalid' });
  });

  it('an overnight cell left as displayed is not rewritten', () => {
    const shown = formatTimeShort('25:30:00'); // "01:30 +1d"
    expect(cellCommitDecision(shown, shown)).toEqual({ kind: 'skip' });
  });
});

describe('cellEditUpdate (C2-01 dwell, C2-11 one-half clear)', () => {
  it("'both' keeps an existing dwell by shifting the departure by the same delta", () => {
    expect(cellEditUpdate({ arrival_time: '08:00:00', departure_time: '08:03:00' }, 'both', '08:10:00'))
      .toEqual({ arrival_time: '08:10:00', departure_time: '08:13:00' });
  });

  it("'both' on a zero-dwell stop sets both", () => {
    expect(cellEditUpdate({ arrival_time: '08:00:00', departure_time: '08:00:00' }, 'both', '08:10:00'))
      .toEqual({ arrival_time: '08:10:00', departure_time: '08:10:00' });
  });

  it("'both' with '' clears the cell", () => {
    expect(cellEditUpdate({ arrival_time: '08:00:00', departure_time: '08:03:00' }, 'both', ''))
      .toEqual({ arrival_time: '', departure_time: '' });
  });

  it('clearing one half collapses onto the other half instead of wiping both', () => {
    const st = { arrival_time: '08:00:00', departure_time: '08:03:00' };
    expect(cellEditUpdate(st, 'arrival_time', '')).toEqual({ arrival_time: '08:03:00', departure_time: '08:03:00' });
    expect(cellEditUpdate(st, 'departure_time', '')).toEqual({ arrival_time: '08:00:00', departure_time: '08:00:00' });
  });

  it('setting one half keeps the other', () => {
    const st = { arrival_time: '08:00:00', departure_time: '08:03:00' };
    expect(cellEditUpdate(st, 'departure_time', '08:05:00')).toEqual({ arrival_time: '08:00:00', departure_time: '08:05:00' });
    expect(cellEditUpdate(st, 'arrival_time', '07:58:00')).toEqual({ arrival_time: '07:58:00', departure_time: '08:03:00' });
  });
});

/* ─────────── C2-08: cascade delta from the edited field ─────────── */
describe('cascadePrevTime (C2-08)', () => {
  it('a departure edit 08:05 → 08:07 (arrival 08:00) offers +2 min, not +7', () => {
    const st = { arrival_time: '08:00:00', departure_time: '08:05:00' };
    const prev = cascadePrevTime(st, 'departure_time');
    const plan = planCascade({
      orderedTripIds: ['A', 'B'], editedTripId: 'A',
      prevSec: gtfsTimeToSeconds(prev), newSec: gtfsTimeToSeconds('08:07:00'), hasTimeAt: () => true,
    });
    expect(plan?.deltaMin).toBe(2);
  });

  it('arrival / single edits still measure from the arrival', () => {
    const st = { arrival_time: '08:00:00', departure_time: '08:05:00' };
    expect(cascadePrevTime(st, 'arrival_time')).toBe('08:00:00');
    expect(cascadePrevTime(st, 'both')).toBe('08:00:00');
    expect(cascadePrevTime({ arrival_time: '', departure_time: '08:05:00' }, 'arrival_time')).toBe('08:05:00');
  });
});

/* ─────────── C2-12: row-order check ─────────── */
describe('computeRowErrors / rowTimeValue (C2-12)', () => {
  it('equal consecutive times are legal', () => {
    expect(computeRowErrors(['08:00:00', '08:00:00'])).toEqual([false, false]);
  });
  it('a departure before its own arrival is flagged', () => {
    expect(computeRowErrors(['08:10:00/08:05:00'])).toEqual([true]);
  });
  it('a next arrival before the previous departure is flagged', () => {
    expect(computeRowErrors(['08:05:00/08:10:00', '08:07:00'])).toEqual([false, true]);
  });
  it('the pane passes the real arr/dep pair, so the pair branch is live', () => {
    expect(rowTimeValue({ arrival_time: '08:05:00', departure_time: '08:10:00' })).toBe('08:05:00/08:10:00');
    expect(rowTimeValue({ arrival_time: '08:05:00', departure_time: '08:05:00' })).toBe('08:05:00');
    expect(rowTimeValue({ arrival_time: '', departure_time: '08:05:00' })).toBe('08:05:00');
    expect(rowTimeValue(undefined)).toBeNull();
    const pane = read('TimetableGridPane.tsx');
    expect(pane).toMatch(/rowTimeValue\(findStopTime\(/);
  });
});

/* ─────────── C2-07 / C2-26: numeric ordering, Repeat-last target ─────────── */
function st(trip: string, seq: number, t: string): StopTime {
  return { trip_id: trip, stop_id: `S${seq}`, stop_sequence: seq, arrival_time: t, departure_time: t };
}

describe('trip ordering (C2-07)', () => {
  it('orders an unpadded 8:05:00 before 10:00:00, untimed last', () => {
    const byTrip = new Map<string, StopTime[]>([
      ['late', [st('late', 1, '10:00:00')]],
      ['early', [st('early', 1, '8:05:00')]],
      ['blank', [st('blank', 1, '')]],
    ]);
    const trips = [{ trip_id: 'blank' }, { trip_id: 'late' }, { trip_id: 'early' }];
    const sorted = sortTripsByStart(trips, (id) => tripStartSec(byTrip.get(id)));
    expect(sorted.map((t) => t.trip_id)).toEqual(['early', 'late', 'blank']);
  });

  it('start is the lowest-sequence timed stop, departure preferred', () => {
    expect(tripStartSec([
      { stop_sequence: 3, arrival_time: '07:00:00', departure_time: '07:00:00' },
      { stop_sequence: 1, arrival_time: '08:00:00', departure_time: '08:02:00' },
    ])).toBe(gtfsTimeToSeconds('08:02:00'));
    expect(tripStartSec([])).toBeNull();
  });

  it('the hook sorts numerically (no localeCompare on times)', () => {
    const hook = read('useTimetableData.ts');
    expect(hook).not.toMatch(/arrival_time\.localeCompare/);
    expect(hook).toMatch(/sortTripsByStart\(/);
  });
});

describe('Repeat last trip (C2-26)', () => {
  it('skips a trailing blank trip and copies the last timed one', () => {
    const starts: Record<string, number | null> = { A: 3600, B: 7200, blank: null };
    const got = lastTimedTrip([{ trip_id: 'A' }, { trip_id: 'B' }, { trip_id: 'blank' }], (id) => starts[id]);
    expect(got).toEqual({ trip: { trip_id: 'B' }, startSec: 7200 });
    expect(lastTimedTrip([{ trip_id: 'blank' }], () => null)).toBeNull();
  });

  it('previews an overnight start correctly (25:30 + 30 min → 02:00 +1d)', () => {
    const html = renderToStaticMarkup(createElement(RepeatDrawer, {
      lastSec: gtfsTimeToSeconds('25:30:00'), tripCount: 3, onApply: () => {}, onCancel: () => {},
    }));
    expect(html).toContain('02:00 +1d');
    expect(html).toContain('after the 01:30 +1d trip');
  });

  it('is disabled when no trip is timed', () => {
    const html = renderToStaticMarkup(createElement(RepeatDrawer, {
      lastSec: null, tripCount: 2, onApply: () => {}, onCancel: () => {},
    }));
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Add 4 trips<\/button>/);
  });
});

/* ─────────── C2-13: timepoint columns per pane, by sequence ─────────── */
describe('timepointSeqs (C2-13)', () => {
  const tp = (trip: string, seq: number, timepoint?: 0 | 1) => ({ trip_id: trip, stop_sequence: seq, timepoint });

  it("a timepoint set only on another service's trip doesn't flag the pane's column", () => {
    const byTrip = new Map([
      ['WK1', [tp('WK1', 1), tp('WK1', 2), tp('WK1', 3)]],
      ['SAT1', [tp('SAT1', 1), tp('SAT1', 2, 1), tp('SAT1', 3)]],
    ]);
    const on = timepointSeqs([1, 2, 3], ['WK1'], (id) => byTrip.get(id));
    expect([...on].sort()).toEqual([1, 3]); // default endpoints only
  });

  it('marking a middle stop keeps the first/last defaults', () => {
    const byTrip = new Map([['T', [tp('T', 1), tp('T', 2, 1), tp('T', 3)]]]);
    expect([...timepointSeqs([1, 2, 3], ['T'], (id) => byTrip.get(id))].sort()).toEqual([1, 2, 3]);
  });

  it('turning an endpoint off sticks (explicit 0 overrides the default)', () => {
    const byTrip = new Map([['T', [tp('T', 1, 0), tp('T', 2), tp('T', 3)]]]);
    expect([...timepointSeqs([1, 2, 3], ['T'], (id) => byTrip.get(id))]).toEqual([3]);
  });

  it('a loop that visits a stop twice is keyed by sequence, not stop_id', () => {
    const byTrip = new Map([['T', [tp('T', 1, 1), tp('T', 2, 0), tp('T', 3, 0), tp('T', 4, 1)]]]);
    expect([...timepointSeqs([1, 2, 3, 4], ['T'], (id) => byTrip.get(id))].sort()).toEqual([1, 4]);
  });
});

/* ─────────── C2-03: calendar_dates-only services ─────────── */
describe('dates-only services in the timetable (C2-03)', () => {
  const datesOnly: CalendarDate[] = [{ service_id: 'X', date: '20261005', exception_type: 1 }];

  it('a dates-only service resolves as the active service and adds no calendar', () => {
    const ids = [...allServiceIds({ calendars: [], calendarDates: datesOnly })];
    expect(resolveActiveServiceId(null, ids)).toBe('X');
    expect(resolveActiveServiceId('X', ids)).toBe('X');
    expect(needsDefaultCalendar({ calendars: [], calendarDates: datesOnly })).toBe(false);
    expect(needsDefaultCalendar({ calendars: [], calendarDates: [] })).toBe(true);
  });

  it('every timetable picker lists services from serviceOptions, not calendars only', () => {
    expect(read('TimetableToolbar.tsx')).toMatch(/services\.map\(\(o\) => \(\{ id: o\.serviceId/);
    expect(read('TimetableToolbar.tsx')).not.toMatch(/calendars\.map/);
    expect(read('ServiceSummary.tsx')).toMatch(/serviceOptions\(/);
    expect(read('ServiceSummary.tsx')).not.toMatch(/calendars\.(map|some)\(/);
    expect(read('MareyChart.tsx')).toMatch(/serviceOptions\(/);
    expect(read('MareyChart.tsx')).not.toMatch(/calendars\.(map|some)\(/);
    expect(read('TimetableGrid.tsx')).toMatch(/serviceOptions\(\{ calendars, calendarDates \}\)/);
  });
});

/* ─────────── C2-04 / C2-05 / C2-06: Edit-frequency drawer ─────────── */
describe('Edit-frequency drawer (C2-04, C2-05, C2-06)', () => {
  const w = (start_time: string, end_time: string, headway_secs = 600) => ({ start_time, end_time, headway_secs, exact_times: 0 as const });

  it('overlapping windows block Apply; adjacent ones do not', () => {
    expect(checkFrequencyDrawer([w('06:00', '10:00'), w('09:00', '12:00')]).canApply).toBe(false);
    expect(checkFrequencyDrawer([w('06:00', '09:00'), w('09:00', '12:00')]).canApply).toBe(true);
  });

  it('unparseable times block Apply instead of being stored', () => {
    const c = checkFrequencyDrawer([w('abc', '22:00')]);
    expect(c.canApply).toBe(false);
    expect(c.errors[0].badTime).toBe(true);
    // Compact input parses like the grid does ("630" → 06:30:00), never stored raw.
    expect(checkFrequencyDrawer([w('630', '22:00')]).normalized[0].start_time).toBe('06:30:00');
  });

  it('Apply emits only normalized HH:MM:SS times', () => {
    const c = checkFrequencyDrawer([w('6:00', '6:30 +1d'), w('07:00:00', '9:15')]);
    expect(c.canApply).toBe(false); // second overlaps the first (6:00 → 30:30)
    const ok = checkFrequencyDrawer([w('6:00', '9:15'), w('9:15', '01:30 +1d')]);
    expect(ok.canApply).toBe(true);
    for (const n of ok.normalized) {
      expect(n.start_time).toMatch(/^\d{2,}:\d{2}:\d{2}$/);
      expect(n.end_time).toMatch(/^\d{2,}:\d{2}:\d{2}$/);
    }
    expect(ok.normalized[1].end_time).toBe('25:30:00');
  });

  it('removing every window is allowed (template becomes a plain trip)', () => {
    expect(checkFrequencyDrawer([]).canApply).toBe(true);
  });

  it('labels stored times without mangling seconds or overnight values', () => {
    expect(frequencyTimeLabel('06:00:00')).toBe('06:00');
    expect(frequencyTimeLabel('6:00:00')).toBe('06:00');
    expect(frequencyTimeLabel('06:00:30')).toBe('06:00:30');
    expect(frequencyTimeLabel('25:30:00')).toBe('01:30 +1d');
  });

  it("renders the trip's own windows, with Apply disabled on overlap", () => {
    const html = renderToStaticMarkup(createElement(FrequencyDrawer, {
      ctx: 'R', tripId: 'B',
      initialWindows: [w('06:00:00', '10:00:00'), w('09:00:00', '12:00:00')],
      onApply: () => {}, onCancel: () => {},
    }));
    expect(html).toContain('value="06:00"');
    expect(html).toContain('value="12:00"');
    // Match the disabled ATTRIBUTE (React SSR emits disabled=""), not the
    // Button's Tailwind `disabled:` classes, which every state carries.
    expect(html).toMatch(/<button[^>]*\sdisabled=""[^>]*>Apply windows<\/button>/);
  });

  it('enables Apply when the windows do not overlap', () => {
    const html = renderToStaticMarkup(createElement(FrequencyDrawer, {
      ctx: 'R', tripId: 'B',
      initialWindows: [w('06:00:00', '09:00:00'), w('09:00:00', '12:00:00')],
      onApply: () => {}, onCancel: () => {},
    }));
    const apply = html.match(/<button[^>]*>Apply windows<\/button>/)?.[0];
    expect(apply).toBeTruthy();
    expect(apply).not.toMatch(/\sdisabled=""/);
  });

  it('the grid keys the drawer on the trip, so switching trips re-seeds it', () => {
    expect(read('TimetableGrid.tsx')).toMatch(/<FrequencyDrawer\s+key=\{freqEditTripId\}/);
  });
});

/* ─────────── C2-25: no store writes during render ─────────── */
describe('route auto-select happens in an effect (C2-25)', () => {
  it('TimetableGrid and MareyChart do not call selectRoute in the render guard', () => {
    for (const f of ['TimetableGrid.tsx', 'MareyChart.tsx']) {
      const src = read(f);
      expect(src).not.toMatch(/if \(!route\) \{\s*if \(routes\.length > 0\) selectRoute/);
      expect(src).toMatch(/useEffect\(\(\) => \{\s*if \(!route && routes\.length > 0\) selectRoute\(routes\[0\]\.route_id\);/);
    }
  });
});

/* ─────────── C2-10 / C2-19: bulk ops through the store ─────────── */
const s = () => useStore.getState();
function trip(id: string, service = 'WK'): Trip {
  return { trip_id: id, route_id: 'R', service_id: service, direction_id: 0 } as Trip;
}

describe('bulk timetable ops (C2-10, C2-19)', () => {
  beforeEach(() => {
    s().setTrips([trip('R-1'), trip('R-2')]);
    s().setStopTimes([st('R-1', 1, '06:00:00'), st('R-1', 2, '06:10:00'), st('R-2', 1, '07:00:00'), st('R-2', 2, '07:10:00')]);
    s().setFrequencies([{ trip_id: 'R-1', start_time: '06:00:00', end_time: '09:00:00', headway_secs: 900, exact_times: 0 }]);
    resetHistory();
  });

  it('copy-from-service keeps a frequency template\'s windows and undoes in one step', () => {
    const made = s().trips.length;
    // Same wrapping as the grid's withUndo (one historyTransaction).
    const ids = historyTransaction('copy trips from service', () =>
      copyTripsToService(s().trips.filter((t) => t.service_id === 'WK'), 'SAT', 'R', new Set(s().trips.map((t) => t.trip_id))));
    expect(ids).toHaveLength(2);
    expect(s().trips.filter((t) => t.service_id === 'SAT')).toHaveLength(2);
    const freqTrip = ids.find((id) => s().frequencies.some((f) => f.trip_id === id));
    expect(freqTrip).toBeDefined();
    expect(s().frequencies.find((f) => f.trip_id === freqTrip)?.start_time).toBe('06:00:00');
    expect(historyDepths().undo).toBe(1);
    undo();
    expect(s().trips).toHaveLength(made);
    expect(s().frequencies).toHaveLength(1);
  });

  it('repeat copies a frequency template with shifted windows', () => {
    const ids = repeatTrip('R-1', 30, 2, 'R', new Set(s().trips.map((t) => t.trip_id)));
    expect(ids).toHaveLength(2);
    const starts = ids.map((id) => s().frequencies.find((f) => f.trip_id === id)?.start_time);
    expect(starts).toEqual(['06:30:00', '07:00:00']);
  });

  it('continuous override is one linear pass touching each trip once', () => {
    const { next, patched } = withContinuousOverride(s().stopTimes, new Set(['R-1', 'R-2']), 'S2', 1);
    expect(patched).toBe(2);
    expect(next.filter((x) => x.continuous_pickup === 1).map((x) => x.trip_id)).toEqual(['R-1', 'R-2']);
    expect(next.filter((x) => x.stop_id === 'S1').every((x) => x.continuous_pickup === undefined)).toBe(true);
  });
});
