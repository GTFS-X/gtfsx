// The calendar_dates-only cluster (S1-02 / NEW-4, S1-11, S2-06, S2-09, S2-18,
// C5-01, S2-07, S2-08): every "which services exist / when do they run" question
// goes through services/serviceIds.ts, so a feed defined only by
// calendar_dates.txt is a real feed, not a broken one.
import { beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import Papa from 'papaparse';
import { useStore } from '../../store';
import {
  allServiceIds, serviceOptions, activeServiceDates, representativeServiceDate, servicesActiveOn,
} from '../serviceIds';
import { representativeDay } from '../stopAnalysis';
import { runValidation } from '../validation';
import { exportGtfsZip } from '../gtfsExport';
import {
  calculateRouteSpans, calculateBlockCost, calculateSystemStats, serviceDayStats,
} from '../costEstimation';
import { calculateTitleVI } from '../titleVI';
import type { BlockGroupData } from '../demographics';
import type { Calendar, CalendarDate, Route, Stop, StopTime, Trip } from '../../types/gtfs';

const NONE = { monday: 0, tuesday: 0, wednesday: 0, thursday: 0, friday: 0, saturday: 0, sunday: 0 } as const;
function cal(id: string, days: Partial<Record<keyof typeof NONE, 0 | 1>>, start = '20260101', end = '20261231'): Calendar {
  return { service_id: id, ...NONE, ...days, start_date: start, end_date: end };
}
function add(id: string, date: string): CalendarDate { return { service_id: id, date, exception_type: 1 }; }
function drop(id: string, date: string): CalendarDate { return { service_id: id, date, exception_type: 2 }; }

/** Every date in [start, end] whose JS weekday is in `weekdays`. */
function datesOn(start: string, end: string, weekdays: number[]): string[] {
  const out: string[] = [];
  const d = new Date(Date.UTC(+start.slice(0, 4), +start.slice(4, 6) - 1, +start.slice(6)));
  const e = new Date(Date.UTC(+end.slice(0, 4), +end.slice(4, 6) - 1, +end.slice(6)));
  for (; d <= e; d.setUTCDate(d.getUTCDate() + 1)) {
    if (!weekdays.includes(d.getUTCDay())) continue;
    out.push(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`);
  }
  return out;
}

function trip(id: string, serviceId: string, routeId = 'R', extra: Partial<Trip> = {}): Trip {
  return { trip_id: id, route_id: routeId, service_id: serviceId, direction_id: 0, ...extra };
}
function st(tripId: string, stopId: string, seq: number, t: string): StopTime {
  return { trip_id: tripId, stop_id: stopId, stop_sequence: seq, arrival_time: t, departure_time: t };
}
const ROUTE: Route = {
  route_id: 'R', agency_id: 'A', route_short_name: 'R', route_long_name: 'R', route_type: 3,
  route_color: '000000', route_text_color: 'FFFFFF',
};

describe('serviceIds helpers', () => {
  it('allServiceIds unions both calendar files; serviceOptions lists dates-only ids after calendar rows', () => {
    const state = { calendars: [cal('WK', { monday: 1 })], calendarDates: [add('HOL', '20261225'), add('WK', '20260103')] };
    expect(allServiceIds(state)).toEqual(new Set(['WK', 'HOL']));
    const opts = serviceOptions(state);
    expect(opts.map((o) => [o.serviceId, o.datesOnly])).toEqual([['WK', false], ['HOL', true]]);
  });

  it('activeServiceDates = weekdays in range ∪ added (even out of range) − removed', () => {
    const cals = [cal('WK', { monday: 1 }, '20260105', '20260119')]; // Mondays 5, 12, 19
    const cds = [drop('WK', '20260112'), add('WK', '20260301')];
    expect(activeServiceDates('WK', cals, cds)).toEqual(['20260105', '20260119', '20260301']);
    expect(activeServiceDates('WK', cals, cds, { start: '20260101', end: '20260131' })).toEqual(['20260105', '20260119']);
  });

  it('servicesActiveOn picks services per date', () => {
    const state = { calendars: [cal('WK', { monday: 1 })], calendarDates: [add('X', '20260105')] };
    expect(servicesActiveOn('20260105', state)).toEqual(new Set(['WK', 'X']));
    expect(servicesActiveOn('20260106', state)).toEqual(new Set());
  });
});

describe('representativeDay is date-based (S2-18)', () => {
  const base = { stops: [], routes: [], routeStops: [], stopTimes: [] };

  it('does not union disjoint seasonal calendars', () => {
    const f = {
      ...base,
      calendars: [
        cal('SUM', { monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1 }, '20260601', '20260831'),
        cal('WIN', { monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1 }, '20260901', '20270531'),
      ],
      calendarDates: [],
      trips: [trip('s1', 'SUM'), trip('w1', 'WIN'), trip('w2', 'WIN')],
    };
    const rep = representativeDay(f, { today: '20261005' });
    expect(rep.serviceIds).toEqual(new Set(['WIN']));
    expect(rep.date).toBe('20261005');
    expect(rep.label).toBe('Mon, Oct 5, 2026');
    expect(rep.weekday).toBe('monday');
  });

  it('counts a calendar_dates-only service active on the chosen date', () => {
    const f = {
      ...base,
      calendars: [cal('WK', { monday: 1 })],
      calendarDates: [add('CD', '20261005')],
      trips: [trip('a', 'WK'), trip('b', 'CD')],
    };
    expect(representativeDay(f, { today: '20261001' }).serviceIds).toEqual(new Set(['WK', 'CD']));
  });

  it('an all-zero calendar gives the "All services" fallback, never an empty set', () => {
    const f = { ...base, calendars: [cal('Z', {})], calendarDates: [], trips: [trip('a', 'Z')] };
    const rep = representativeDay(f, { today: '20261001' });
    expect(rep.label).toBe('All services');
    expect(rep.weekday).toBeNull();
    expect(rep.serviceIds).toEqual(new Set(['Z']));
  });

  it('an expired feed falls back to its own first service days', () => {
    const rep = representativeServiceDate(
      { calendars: [cal('OLD', { tuesday: 1 }, '20200101', '20200131')], calendarDates: [], trips: [trip('a', 'OLD')] },
      { today: '20261001' },
    );
    expect(rep.date).toBe('20200107');
  });
});

describe('validation on a calendar_dates-only feed (S1-02 / NEW-4)', () => {
  beforeEach(() => {
    const s = useStore.getState();
    s.setAgencies([{ agency_id: 'A', agency_name: 'A', agency_url: 'https://x.test', agency_timezone: 'America/Denver' } as never]);
    s.setRoutes([ROUTE]);
    s.setStops([{ stop_id: 'P1', stop_name: 'P1', stop_lat: 45, stop_lon: -111 } as Stop, { stop_id: 'P2', stop_name: 'P2', stop_lat: 45.01, stop_lon: -111 } as Stop]);
    s.setTrips([trip('T1', 'S')]);
    s.setStopTimes([st('T1', 'P1', 1, '08:00:00'), st('T1', 'P2', 2, '08:10:00')]);
    s.setFlexZones([]);
  });

  it('a dates-only service is neither an error nor an orphan', () => {
    const s = useStore.getState();
    s.setCalendars([]);
    s.setCalendarDates([add('S', '20991225')]);
    const msgs = runValidation(useStore.getState());
    expect(msgs.filter((m) => m.severity === 'error').map((m) => m.message)).toEqual([]);
    expect(msgs.some((m) => m.fix?.id === 'remove-orphan-trips')).toBe(false);
  });

  it('a feed with neither calendar file still errors, and the trip is still an orphan', () => {
    const s = useStore.getState();
    s.setCalendars([]);
    s.setCalendarDates([]);
    const msgs = runValidation(useStore.getState());
    expect(msgs.some((m) => m.severity === 'error' && /At least one service pattern/.test(m.message))).toBe(true);
    expect(msgs.some((m) => m.fix?.id === 'remove-orphan-trips')).toBe(true);
  });
});

describe('flex export on a dates-only service (S1-11)', () => {
  it('a zone on a dates-only service exports on that service, not calendars[0]', async () => {
    const s = useStore.getState();
    s.setCalendars([cal('WK', { monday: 1 })]);
    s.setCalendarDates([add('HOL', '20261225')]);
    s.setRoutes([]);
    s.setTrips([]);
    s.setStopTimes([]);
    s.setFlexZones([{
      id: 'dar', name: 'DAR', bufferMiles: 0, serviceId: 'HOL',
      pickupWindowStart: '06:00:00', pickupWindowEnd: '18:00:00',
      geojson: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-111, 45], [-111, 45.05], [-110.95, 45.05], [-111, 45]]] } }] },
    } as never]);
    const zip = await JSZip.loadAsync(await (await exportGtfsZip()).arrayBuffer());
    const trips = Papa.parse<Record<string, string>>(await zip.file('trips.txt')!.async('string'), { header: true, skipEmptyLines: true }).data;
    expect(trips.find((t) => t.trip_id === 'dar-trip')?.service_id).toBe('HOL');
    // And validation agrees it is exportable.
    expect(runValidation(useStore.getState()).some((m) => m.code === 'flex-no-service-pattern')).toBe(false);
    s.setFlexZones([]);
  });
});

describe('cost engine service days (S2-06, S2-20 ride-along)', () => {
  // Every weekday of 2026 except ~11 holidays → 250 dates spanning the year.
  const WK_DATES = datesOn('20260101', '20261231', [1, 2, 3, 4, 5]).filter((_, i) => i % 24 !== 5);
  const SAT_DATES = datesOn('20260101', '20261231', [6]);
  const state = {
    calendars: [cal('ZERO', {}), cal('MF', { monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1 })],
    calendarDates: [
      ...WK_DATES.map((d) => add('WK', d)),
      ...SAT_DATES.map((d) => add('SAT', d)),
      ...SAT_DATES.map((d) => add('ZERO', d)),
    ],
  };

  it('dates-only weekday service ≈ 250 days/yr and < 5 days/wk', () => {
    const s = serviceDayStats('WK', state);
    expect(s.serviceDaysPerYear).toBeGreaterThanOrEqual(250);
    expect(s.serviceDaysPerYear).toBeLessThanOrEqual(260);
    expect(s.daysPerWeek).toBeGreaterThan(4.5);
    expect(s.daysPerWeek).toBeLessThan(5.1);
  });

  it('dates-only Saturday service ≈ 52 days/yr, 1 day/wk', () => {
    const s = serviceDayStats('SAT', state);
    expect(Math.abs(s.serviceDaysPerYear - 52)).toBeLessThanOrEqual(2);
    expect(s.daysPerWeek).toBeCloseTo(1, 1);
  });

  it('an all-zero calendar with added Saturdays ≈ 52 days/yr, 1 day/wk', () => {
    const s = serviceDayStats('ZERO', state);
    expect(s.serviceDaysPerYear).toBe(52);
    expect(s.daysPerWeek).toBeCloseTo(1, 1);
  });

  it('a plain Mon–Fri full-year calendar is unchanged (261 / 5)', () => {
    expect(serviceDayStats('MF', state)).toEqual({ daysPerWeek: 5, serviceDaysPerYear: 261 });
  });

  it('an added date outside the calendar range counts', () => {
    const s = serviceDayStats('M', {
      calendars: [cal('M', { monday: 1 }, '20260105', '20260126')],
      calendarDates: [add('M', '20260202')],
    });
    // 5 Mondays over a 29-day span, annualized.
    expect(s.serviceDaysPerYear).toBe(Math.round(5 / (29 / 365.25)));
  });

  it('route spans use the dates-only weekly rate, not 7 days', () => {
    const spans = calculateRouteSpans('R', {
      routes: [ROUTE], trips: [trip('t', 'SAT')], ...state,
      stopTimes: [st('t', 'a', 1, '08:00:00'), st('t', 'b', 2, '09:00:00')],
    });
    expect(spans.weeklyRevHours).toBeCloseTo(1, 1);
    expect(spans.tripsPerWeek).toBeCloseTo(1, 1);
  });
});

describe('route spans expand frequencies.txt (S2-07)', () => {
  it('a 06:00–22:00 / 10-min template with a 30-min run → 96 × 0.5 h/day, peak 3, system ≤ total', () => {
    const s = {
      routes: [ROUTE],
      trips: [trip('F', 'MF')],
      stopTimes: [st('F', 'a', 1, '06:00:00'), st('F', 'b', 2, '06:30:00')],
      calendars: [cal('MF', { monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1 })],
      calendarDates: [],
      frequencies: [{ trip_id: 'F', start_time: '06:00:00', end_time: '22:00:00', headway_secs: 600 }],
    };
    const spans = calculateRouteSpans('R', s);
    expect(spans._serviceBreakdown[0].revHours).toBeCloseTo(48, 5);
    expect(spans.tripsPerWeek).toBe(96 * 5);
    expect(spans.peakVehicles).toBe(3);
    const sys = calculateSystemStats(s, 100, 1);
    expect(sys.systemPeakVehicles).toBeLessThanOrEqual(sys.totalPeakVehicles);
  });
});

describe('block cost keeps the deadhead factor for unblocked trips (S2-08)', () => {
  const stops = [
    { stop_id: 'a', stop_name: 'a', stop_lat: 45, stop_lon: -111 } as Stop,
    { stop_id: 'b', stop_name: 'b', stop_lat: 45.01, stop_lon: -111 } as Stop,
  ];
  const calendars = [cal('WK', { monday: 1 }), cal('SAT', { saturday: 1 })];
  const times = (id: string) => [st(id, 'a', 1, '08:00:00'), st(id, 'b', 2, '09:00:00')];
  const opts = { costPerHour: 100, costLayover: true, costDeadhead: true, deadheadFactor: 1.2 };

  it('blocking WK does not strip the factor from unblocked SAT', () => {
    const r = calculateBlockCost({
      trips: [trip('w', 'WK', 'R', { block_id: 'B1' }), trip('s', 'SAT')],
      stopTimes: [...times('w'), ...times('s')], stops, calendars, calendarDates: [],
    }, opts);
    const byId = Object.fromEntries(r.perService.map((p) => [p.serviceId, p.dailyCost]));
    expect(byId.SAT).toBeCloseTo(120, 5);
    expect(byId.WK).toBeCloseTo(100, 5);
  });

  it('no blocks at all is unchanged (120 / 120)', () => {
    const r = calculateBlockCost({
      trips: [trip('w', 'WK'), trip('s', 'SAT')],
      stopTimes: [...times('w'), ...times('s')], stops, calendars, calendarDates: [],
    }, opts);
    for (const p of r.perService) expect(p.dailyCost).toBeCloseTo(120, 5);
  });
});

describe('Title VI (S2-09, C5-01)', () => {
  const stop = { stop_id: 'S', stop_name: 'S', stop_lat: 45, stop_lon: -111 } as Stop;
  const bg = (geoid: string, lon: number, minority: number, total: number): BlockGroupData => ({
    geoid, lat: 45, lon, population: total, totalRacePop: total, minorityPop: minority,
    povertyUniverse: total, lowIncomePop: Math.round(minority / 2),
  } as unknown as BlockGroupData);

  it('identical weekday and Saturday services count as one day, not two', () => {
    const bgs = [bg('1', -111, 80, 100), bg('2', -111.0005, 10, 100)];
    const one = calculateTitleVI([stop], bgs, {
      trips: [trip('w1', 'WK'), trip('w2', 'WK')],
      calendars: [cal('WK', { monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1 })],
      calendarDates: [],
      stopTimes: [st('w1', 'S', 1, '08:00:00'), st('w2', 'S', 1, '08:30:00')],
    }, new Set(['WK']));
    const two = calculateTitleVI([stop], bgs, {
      trips: [trip('w1', 'WK'), trip('w2', 'WK'), trip('s1', 'SAT'), trip('s2', 'SAT')],
      calendars: [cal('WK', { monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1 }), cal('SAT', { saturday: 1 })],
      calendarDates: [],
      stopTimes: [st('w1', 'S', 1, '08:00:00'), st('w2', 'S', 1, '08:30:00'), st('s1', 'S', 1, '08:00:00'), st('s2', 'S', 1, '08:30:00')],
    }, new Set(['WK']));
    expect(two.blockGroupLevels.map((l) => l.dailyTrips)).toEqual(one.blockGroupLevels.map((l) => l.dailyTrips));
  });

  it('defaults to the representative service date when trips + calendars are given', () => {
    const r = calculateTitleVI([stop], [bg('1', -111, 80, 100)], {
      trips: [trip('w1', 'WK'), trip('s1', 'SAT')],
      calendars: [cal('WK', { monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1 }, '20200101', '20991231'), cal('SAT', { saturday: 1 }, '20200101', '20991231')],
      calendarDates: [],
      stopTimes: [st('w1', 'S', 1, '08:00:00'), st('s1', 'S', 1, '08:00:00')],
    });
    expect(r.basis?.serviceIds).toHaveLength(1);
    expect(r.basis?.label).toMatch(/^\w{3}, \w{3} \d+, \d{4}$/);
  });

  it('ratio is null (not 0) when the comparison group gets no service', () => {
    const r = calculateTitleVI([stop], [bg('1', -111, 90, 100), bg('2', -100, 5, 100)], {
      stopTimes: [st('t', 'S', 1, '08:00:00')],
    });
    expect(r.nonMinority.count).toBe(1);
    expect(r.ratio).toBeNull();
  });

  it('a block group with no race data is in neither group', () => {
    const noRace = { ...bg('3', -111, 0, 0), population: 50 } as BlockGroupData;
    const r = calculateTitleVI([stop], [noRace, bg('1', -111, 80, 100)], { stopTimes: [st('t', 'S', 1, '08:00:00')] });
    expect(r.minority.count + r.nonMinority.count).toBe(1);
    expect(r.ratio).toBeNull();
  });
});
