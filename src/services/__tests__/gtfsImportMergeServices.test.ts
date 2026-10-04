// mergeImportIntoStore: services matched by full definition (S1-17), no
// dangling references / partial data (S1-18), one undo step (S1-19).
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../store';
import { historyDepths, resetHistory, undo } from '../../store/history';
import { mergeImportIntoStore } from '../gtfsImport';
import type { Calendar, CalendarDate, Stop, StopTime, Trip } from '../../types/gtfs';

const MF = { monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0 } as const;
const cal = (id: string, start: string, end: string): Calendar => ({ service_id: id, ...MF, start_date: start, end_date: end });
const stop = (id: string, lat: number, extra: Partial<Stop> = {}): Stop =>
  ({ stop_id: id, stop_name: id, stop_lat: lat, stop_lon: -111, location_type: 0, wheelchair_boarding: 0, ...extra });
const st = (trip: string, stopId: string, seq: number): StopTime =>
  ({ trip_id: trip, stop_id: stopId, stop_sequence: seq, arrival_time: `08:0${seq}:00`, departure_time: `08:0${seq}:00` });

function reset() {
  const s = useStore.getState();
  s.setAgencies([{ agency_id: 'HOST', agency_name: 'Host', agency_url: 'https://h.test', agency_timezone: 'America/Denver' }]);
  s.setRoutes([{ route_id: 'H1', agency_id: 'HOST', route_short_name: 'H', route_long_name: '', route_type: 3, route_color: '000000', route_text_color: 'FFFFFF' }]);
  s.setStops([stop('S1', 10)]);
  s.setTrips([{ trip_id: 'ht', route_id: 'H1', service_id: 'WEEKDAY', direction_id: 0, block_id: 'B1' }]);
  s.setStopTimes([]);
  s.setShapes([]);
  s.setRouteStops([]);
  s.setCalendars([cal('WEEKDAY', '20260101', '20260630')]);
  s.setCalendarDates([]);
  s.setFrequencies([]);
  s.setLevels([]);
  s.setTranslations([]);
  resetHistory();
}

function source(overrides: Record<string, unknown> = {}) {
  const trips: Trip[] = [
    { trip_id: 't0', route_id: 'R', service_id: 'WD', direction_id: 0, block_id: 'B1' },
    { trip_id: 't1', route_id: 'R', service_id: 'HOL', direction_id: 0 },
    { trip_id: 't2', route_id: 'R', service_id: 'WEEKDAY', direction_id: 0 },
  ];
  const dates: CalendarDate[] = [{ service_id: 'HOL', date: '20261225', exception_type: 1 }];
  return {
    agencies: [{ agency_id: 'SRC', agency_name: 'Src', agency_url: 'https://s.test', agency_timezone: 'America/Denver' }],
    routes: [{ route_id: 'R', agency_id: 'SRC', route_short_name: 'R', route_long_name: '', route_type: 3, route_color: '000000', route_text_color: 'FFFFFF' }],
    stops: [
      stop('ST', 20, { location_type: 1 }),
      stop('P1', 20.001, { parent_station: 'ST', level_id: 'L0' }),
      stop('S1', 20.01), // id collides with a host stop at a different place
    ],
    levels: [{ level_id: 'L0', level_index: 0 }],
    trips,
    stopTimes: trips.flatMap((t) => [st(t.trip_id, 'P1', 1), st(t.trip_id, 'S1', 2)]),
    frequencies: [{ trip_id: 't0', start_time: '06:00:00', end_time: '09:00:00', headway_secs: 900 }],
    shapes: [],
    routeStops: [],
    calendars: [cal('WD', '20260701', '20261231'), cal('WEEKDAY', '20260101', '20260630')],
    calendarDates: dates,
    translations: [],
    warnings: [],
    feedInfo: null,
    ...overrides,
  } as never;
}

beforeEach(reset);

describe('mergeImportIntoStore', () => {
  it('maps services by full definition, keeps dates-only services, never clashes ids', () => {
    mergeImportIntoStore(source(), new Set(['R']));
    const s = useStore.getState();
    const merged = s.trips.filter((t) => t.route_id !== 'H1');
    const byOrig = Object.fromEntries(merged.map((t) => [t.trip_id.replace(/^i\d+_/, ''), t]));

    // WD has the same weekdays as the host WEEKDAY but other dates → imported, not remapped.
    const wd = s.calendars.find((c) => c.service_id === byOrig.t0.service_id)!;
    expect(wd.start_date).toBe('20260701');
    // An identical definition is reused.
    expect(byOrig.t2.service_id).toBe('WEEKDAY');
    // A dates-only service arrives with its dates.
    expect(s.calendarDates.some((d) => d.service_id === byOrig.t1.service_id && d.date === '20261225')).toBe(true);
  });

  it('leaves no dangling references (parent station, level, agency, block, frequencies, stops)', () => {
    mergeImportIntoStore(source(), new Set(['R']));
    const s = useStore.getState();
    const stopIds = new Set(s.stops.map((x) => x.stop_id));
    for (const x of s.stops) {
      if (x.parent_station) expect(stopIds.has(x.parent_station)).toBe(true);
      if (x.level_id) expect(s.levels.some((l) => l.level_id === x.level_id)).toBe(true);
    }
    for (const x of s.stopTimes) expect(stopIds.has(x.stop_id)).toBe(true);
    // The source S1 is a different place: it must not silently become the host S1.
    expect(s.stops.filter((x) => x.stop_lat === 20.01)).toHaveLength(1);
    expect(s.routes.every((r) => r.agency_id === 'HOST')).toBe(true);
    const mergedBlocks = s.trips.filter((t) => t.route_id !== 'H1').map((t) => t.block_id).filter(Boolean);
    expect(mergedBlocks).not.toContain('B1');
    expect(s.frequencies).toHaveLength(1);
    expect(s.trips.some((t) => t.trip_id === s.frequencies[0].trip_id)).toBe(true);
    expect(s.featureSettings.frequencies).toBe(true);
  });

  it('is one undo step, even for more than 100 trips', () => {
    const trips: Trip[] = Array.from({ length: 150 }, (_, i) => ({ trip_id: `x${i}`, route_id: 'R', service_id: 'WEEKDAY', direction_id: 0 }));
    const before = historyDepths().undo;
    const pre = { trips: useStore.getState().trips.length, stops: useStore.getState().stops.length };
    mergeImportIntoStore(source({ trips, stopTimes: trips.flatMap((t) => [st(t.trip_id, 'P1', 1)]), frequencies: [] }), new Set(['R']));
    expect(historyDepths().undo).toBe(before + 1);
    expect(useStore.getState().trips.length).toBe(pre.trips + 150);
    expect(undo()).toBe('merge feed');
    expect(useStore.getState().trips.length).toBe(pre.trips);
    expect(useStore.getState().stops.length).toBe(pre.stops);
  });
});
