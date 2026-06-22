// Per-feed dismissible validation rules: the holiday-exception nudge carries a
// stable rule code, the store tracks a per-feed dismissed set, and the panel's
// filter logic hides dismissed messages. See store/validationSlice.ts +
// services/validation.ts + components/validation/ValidationPanel.tsx.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../index';
import { runValidation, VALIDATION_CODES, DISMISSIBLE_RULE_LABELS } from '../../services/validation';
import type { ValidationMessage } from '../../types/ui';

// A calendar that runs every day across all of next year — every US holiday in
// range matches a service day, so the #17 holiday-exception nudge fires. Next
// year keeps end_date in the future, so the "expired pattern" warning never
// muddies the picture, no matter when the test runs.
const NEXT_YEAR = new Date().getFullYear() + 1;
const everydayCalendar = {
  service_id: 'WEEKDAY',
  monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 1, sunday: 1,
  start_date: `${NEXT_YEAR}0101`,
  end_date: `${NEXT_YEAR}1231`,
};

// A Mon–Fri pattern across next year, for the redundant-exception rule.
const weekdayCalendar = {
  service_id: 'WD',
  monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0,
  start_date: `${NEXT_YEAR}0101`,
  end_date: `${NEXT_YEAR}1231`,
};

// First date on/after Jan 1 of `year` whose UTC weekday is `dow` (0=Sun…6=Sat),
// as a GTFS YYYYMMDD string. Computed independently of the code under test so it
// can serve as an anchor (a known off-day Saturday vs a running-day Monday for
// the Mon–Fri pattern above).
function firstGtfsWeekday(year: number, dow: number): string {
  const d = new Date(Date.UTC(year, 0, 1));
  while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() + 1);
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}${m}${day}`;
}

function reset() {
  const s = useStore.getState();
  s.setCalendars([]);
  s.setCalendarDates([]);
  s.setDismissedValidations([]);
}
beforeEach(reset);
afterEach(reset);

// Mirror of ValidationPanel's filter: a message is hidden when its rule code is
// in the per-feed dismissed set.
function visibleAfterDismiss(msgs: ValidationMessage[], dismissed: string[]) {
  return msgs.filter((m) => !(m.code && dismissed.includes(m.code)));
}
const holidayMsgs = (msgs: ValidationMessage[]) =>
  msgs.filter((m) => m.code === VALIDATION_CODES.holidayExceptions);

describe('holiday-exception rule code', () => {
  it('the holiday nudge carries the stable holiday-exceptions code', () => {
    useStore.getState().setCalendars([everydayCalendar as never]);
    const msgs = runValidation(useStore.getState());
    const holiday = holidayMsgs(msgs);
    expect(holiday.length).toBeGreaterThan(0);
    expect(holiday[0].severity).toBe('warning');
    expect(holiday[0].entity_type).toBe('calendar');
    // The code is registered with a human label for the "dismissed" drawer.
    expect(DISMISSIBLE_RULE_LABELS[VALIDATION_CODES.holidayExceptions]).toBeTruthy();
  });

  it('an adjacent rule (no code) stays non-dismissible', () => {
    useStore.getState().setCalendars([everydayCalendar as never]);
    const msgs = runValidation(useStore.getState());
    // "No routes defined" is a plain warning with no rule code.
    const noRoutes = msgs.find((m) => m.message === 'No routes defined');
    expect(noRoutes).toBeDefined();
    expect(noRoutes!.code).toBeUndefined();
  });
});

describe('dismissed-validations slice', () => {
  it('dismiss adds the code; restore removes it; both are idempotent', () => {
    const s = useStore.getState();
    s.dismissValidation(VALIDATION_CODES.holidayExceptions);
    s.dismissValidation(VALIDATION_CODES.holidayExceptions); // no duplicate
    expect(useStore.getState().dismissedValidations).toEqual([VALIDATION_CODES.holidayExceptions]);
    s.restoreValidation(VALIDATION_CODES.holidayExceptions);
    s.restoreValidation(VALIDATION_CODES.holidayExceptions); // no throw / no-op
    expect(useStore.getState().dismissedValidations).toEqual([]);
  });

  it('setDismissedValidations replaces the set and de-dups', () => {
    useStore.getState().setDismissedValidations(['a', 'a', 'b']);
    expect(useStore.getState().dismissedValidations).toEqual(['a', 'b']);
    // A non-array (malformed snapshot) resets to empty rather than throwing.
    useStore.getState().setDismissedValidations(undefined as never);
    expect(useStore.getState().dismissedValidations).toEqual([]);
  });
});

describe('dismiss filtering (panel logic)', () => {
  it('dismissing the holiday code hides every holiday message but nothing else', () => {
    useStore.getState().setCalendars([everydayCalendar as never]);
    const msgs = runValidation(useStore.getState());
    expect(holidayMsgs(msgs).length).toBeGreaterThan(0);

    useStore.getState().dismissValidation(VALIDATION_CODES.holidayExceptions);
    const dismissed = useStore.getState().dismissedValidations;
    const visible = visibleAfterDismiss(msgs, dismissed);

    // Holiday messages are gone from the visible list…
    expect(holidayMsgs(visible).length).toBe(0);
    // …but the underlying validation still produced them (restorable), and every
    // non-holiday message is untouched.
    expect(visible.length).toBe(msgs.length - holidayMsgs(msgs).length);
  });

  it('restore brings the holiday warning back', () => {
    useStore.getState().setCalendars([everydayCalendar as never]);
    const msgs = runValidation(useStore.getState());
    useStore.getState().dismissValidation(VALIDATION_CODES.holidayExceptions);
    useStore.getState().restoreValidation(VALIDATION_CODES.holidayExceptions);
    const visible = visibleAfterDismiss(msgs, useStore.getState().dismissedValidations);
    expect(holidayMsgs(visible).length).toBeGreaterThan(0);
  });
});

const redundantMsgs = (msgs: ValidationMessage[]) =>
  msgs.filter((m) => m.code === VALIDATION_CODES.redundantException);

describe('redundant calendar_dates exception rule', () => {
  it('flags a "no service" exception on a day the pattern is already off, with a dismissible code', () => {
    // Mon–Fri pattern + a type-2 ("no service") exception on a Saturday: the
    // calendar already doesn't run Saturdays, so the row removes nothing — the
    // exact phantom row Task 1 stops the bulk-adder from creating.
    const sat = firstGtfsWeekday(NEXT_YEAR, 6);
    useStore.getState().setCalendars([weekdayCalendar as never]);
    useStore.getState().setCalendarDates([{ service_id: 'WD', date: sat, exception_type: 2 } as never]);

    const red = redundantMsgs(runValidation(useStore.getState()));
    expect(red.length).toBeGreaterThan(0);
    expect(red[0].severity).toBe('warning');
    expect(red[0].entity_type).toBe('calendar');
    expect(red[0].entity_id).toBe('WD');
    // Registered with a human label for the dismissed drawer.
    expect(DISMISSIBLE_RULE_LABELS[VALIDATION_CODES.redundantException]).toBeTruthy();
  });

  it('does NOT flag a "no service" exception on a running weekday (it removes real service)', () => {
    const mon = firstGtfsWeekday(NEXT_YEAR, 1);
    useStore.getState().setCalendars([weekdayCalendar as never]);
    useStore.getState().setCalendarDates([{ service_id: 'WD', date: mon, exception_type: 2 } as never]);
    expect(redundantMsgs(runValidation(useStore.getState())).length).toBe(0);
  });

  it('flags an "added service" exception on a day the pattern already runs', () => {
    const mon = firstGtfsWeekday(NEXT_YEAR, 1);
    useStore.getState().setCalendars([weekdayCalendar as never]);
    useStore.getState().setCalendarDates([{ service_id: 'WD', date: mon, exception_type: 1 } as never]);
    expect(redundantMsgs(runValidation(useStore.getState())).length).toBeGreaterThan(0);
  });

  it('skips calendar_dates-only services (no calendar.txt row to be redundant against)', () => {
    const sat = firstGtfsWeekday(NEXT_YEAR, 6);
    useStore.getState().setCalendars([]); // no weekly calendar for 'ONLY'
    useStore.getState().setCalendarDates([{ service_id: 'ONLY', date: sat, exception_type: 1 } as never]);
    expect(redundantMsgs(runValidation(useStore.getState())).length).toBe(0);
  });

  it('dismissing the redundant-exception code hides those messages per feed', () => {
    const sat = firstGtfsWeekday(NEXT_YEAR, 6);
    useStore.getState().setCalendars([weekdayCalendar as never]);
    useStore.getState().setCalendarDates([{ service_id: 'WD', date: sat, exception_type: 2 } as never]);
    const msgs = runValidation(useStore.getState());
    expect(redundantMsgs(msgs).length).toBeGreaterThan(0);

    useStore.getState().dismissValidation(VALIDATION_CODES.redundantException);
    const visible = visibleAfterDismiss(msgs, useStore.getState().dismissedValidations);
    expect(redundantMsgs(visible).length).toBe(0);
  });
});
