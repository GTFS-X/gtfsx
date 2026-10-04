// Store-level referential cascades and batched actions (bug review batch B4).
// Each block names the finding it pins: S1-12 (trip → frequencies), S1-13
// (stop → pathways / stop_areas / parent_station / flex groups), S1-14
// (calendar delete refused while referenced), S1-15 (level → stops.level_id),
// S1-16 (Fares v2 area rename), S1-29 (fare_id → flex zone), C2-16
// (calendar_dates upsert), C1-01 (appendRouteStop), C1-16 (removeStops),
// C1-06 (removeShapeFromRoute), C2-10 (duplicateTrip cloneFrequencies),
// S1-20 (interpolate per shape), S1-21 (duplicateRoute shapes, scoped flip),
// C5-10 (isochrone service reset), C5-17 (assistant active reply).
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../index';
import { undo, resetHistory, historyDepths } from '../history';
import { calendarReferences } from '../calendarSlice';
import type {
  Calendar, Frequency, Pathway, Route, RouteStop, Shape, Stop, StopTime, Trip,
} from '../../types/gtfs';
import type { FlexZone } from '../flexSlice';

const s = () => useStore.getState();

const stop = (id: string, extra: Partial<Stop> = {}): Stop =>
  ({ stop_id: id, stop_name: id, stop_lat: 45, stop_lon: -111, location_type: 0, ...extra }) as Stop;
const route = (id: string): Route =>
  ({ route_id: id, route_short_name: id, route_long_name: id, route_type: 3 }) as Route;
const trip = (id: string, extra: Partial<Trip> = {}): Trip =>
  ({ trip_id: id, route_id: 'R', service_id: 'WK', direction_id: 0, ...extra }) as Trip;
const st = (trip_id: string, stop_id: string, seq: number, t = ''): StopTime =>
  ({ trip_id, stop_id, stop_sequence: seq, arrival_time: t, departure_time: t }) as StopTime;
const rs = (stop_id: string, seq: number, extra: Partial<RouteStop> = {}): RouteStop =>
  ({ route_id: 'R', stop_id, direction_id: 0, stop_sequence: seq, ...extra }) as RouteStop;
const freq = (trip_id: string): Frequency =>
  ({ trip_id, start_time: '06:00:00', end_time: '09:00:00', headway_secs: 600 });
const cal = (id: string): Calendar =>
  ({
    service_id: id, monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1,
    saturday: 0, sunday: 0, start_date: '20260101', end_date: '20261231',
  }) as Calendar;
const zone = (id: string, extra: Partial<FlexZone> = {}): FlexZone =>
  ({ id, name: id, bufferMiles: 0, geojson: { type: 'FeatureCollection', features: [] }, ...extra }) as FlexZone;
const shape = (id: string, extra: Partial<Shape> = {}): Shape =>
  ({
    shape_id: id,
    points: [
      { shape_pt_lat: 45, shape_pt_lon: -111, shape_pt_sequence: 0, shape_dist_traveled: 0 },
      { shape_pt_lat: 45.01, shape_pt_lon: -111, shape_pt_sequence: 1, shape_dist_traveled: 1000 },
    ],
    ...extra,
  }) as Shape;

beforeEach(() => {
  const x = s();
  x.setRoutes([]); x.setRouteStops([]); x.setTrips([]); x.setStopTimes([]);
  x.setStops([]); x.setShapes([]); x.setFrequencies([]); x.setTranslations([]);
  x.setTransfers([]); x.setPathways([]); x.setStopAreas([]); x.setFareAreas([]);
  x.setFlexZones([]); x.setLevels([]); x.setCalendars([]); x.setCalendarDates([]);
  x.setTimeframes([]); x.setFareAttributes([]); x.setFareRules([]);
  x.setFareLegRules([]); x.setRouteNetworks([]);
  resetHistory();
});

describe('S1-12: trip removal / rename carries frequencies', () => {
  beforeEach(() => {
    s().setRoutes([route('R')]);
    s().setTrips([trip('T1')]);
    s().setStopTimes([st('T1', 'A', 0, '08:00:00')]);
    s().setFrequencies([freq('T1')]);
  });

  it('renameTripId moves the frequency window', () => {
    s().renameTripId('T1', 'T1-AM');
    expect(s().frequencies.map((f) => f.trip_id)).toEqual(['T1-AM']);
  });

  it('removeTrip drops the frequency window', () => {
    s().removeTrip('T1');
    expect(s().frequencies).toHaveLength(0);
  });

  it('removeRoute drops its trips’ frequency windows and route_networks rows', () => {
    s().setRouteNetworks([{ network_id: 'N', route_id: 'R' }, { network_id: 'N', route_id: 'OTHER' }]);
    s().removeRoute('R');
    expect(s().frequencies).toHaveLength(0);
    expect(s().routeNetworks).toEqual([{ network_id: 'N', route_id: 'OTHER' }]);
  });
});

describe('S1-13: stop removal cascade', () => {
  function seedStation() {
    s().setStops([
      stop('ST', { location_type: 1 }),
      stop('P1', { parent_station: 'ST' }),
      stop('P2'),
    ]);
    s().setPathways([
      { pathway_id: 'PW', from_stop_id: 'ST', to_stop_id: 'P1', pathway_mode: 1, is_bidirectional: 1 } as Pathway,
    ]);
    s().setStopAreas([{ area_id: 'AR', stop_id: 'ST' }, { area_id: 'AR', stop_id: 'P2' }]);
    s().setFlexZones([zone('Z', { stopIds: ['P1', 'P2', 'ST'] })]);
    s().setTransfers([{ from_stop_id: 'P2', to_stop_id: 'P1', transfer_type: 2 }] as never);
  }

  it('removeStop on a station leaves no dangling ids', () => {
    seedStation();
    s().removeStop('ST');
    expect(s().stops.find((x) => x.stop_id === 'P1')!.parent_station).toBeUndefined();
    expect(s().pathways).toHaveLength(0);
    expect(s().stopAreas).toEqual([{ area_id: 'AR', stop_id: 'P2' }]);
    expect(s().flexZones[0].stopIds).toEqual(['P1', 'P2']);
  });

  it('removeStop on a platform drops transfers and its flex membership', () => {
    seedStation();
    s().removeStop('P2');
    expect(s().transfers).toHaveLength(0);
    expect(s().flexZones[0].stopIds).toEqual(['P1', 'ST']);
    expect(s().stopAreas).toEqual([{ area_id: 'AR', stop_id: 'ST' }]);
  });

  it('removeStopWithSnapshot → restoreStop is symmetric', () => {
    seedStation();
    const before = {
      stops: s().stops, pathways: s().pathways, stopAreas: s().stopAreas, flexZones: s().flexZones,
    };
    const snap = s().removeStopWithSnapshot('ST');
    expect(s().pathways).toHaveLength(0);
    expect(s().flexZones[0].stopIds).toEqual(['P1', 'P2']);
    s().restoreStop(snap);
    expect(s().stops.find((x) => x.stop_id === 'P1')!.parent_station).toBe('ST');
    expect(s().pathways).toEqual(before.pathways);
    expect([...s().stopAreas].sort((a, b) => a.stop_id.localeCompare(b.stop_id)))
      .toEqual([...before.stopAreas].sort((a, b) => a.stop_id.localeCompare(b.stop_id)));
    expect(s().flexZones[0].stopIds).toEqual(['P1', 'P2', 'ST']);
  });

  it('removeRoute’s orphaned-stop path runs the same cascade', () => {
    seedStation();
    s().setRoutes([route('R')]);
    s().setRouteStops([rs('P2', 0)]);
    s().removeRoute('R');
    expect(s().stops.some((x) => x.stop_id === 'P2')).toBe(false);
    expect(s().transfers).toHaveLength(0);
    expect(s().flexZones[0].stopIds).toEqual(['P1', 'ST']);
  });
});

describe('C1-16: removeStops is one store update', () => {
  it('removes 150 stops and their stop_times; one undo restores all', () => {
    const stops = Array.from({ length: 150 }, (_, i) => stop(`S${i}`));
    s().setStops(stops);
    s().setStopTimes(stops.map((x, i) => st('T', x.stop_id, i, '08:00:00')));
    resetHistory();

    s().removeStops(stops.map((x) => x.stop_id));
    expect(s().stops).toHaveLength(0);
    expect(s().stopTimes).toHaveLength(0);
    expect(historyDepths().undo).toBe(1);

    undo();
    expect(s().stops).toHaveLength(150);
    expect(s().stopTimes).toHaveLength(150);
  });
});

describe('S1-14: removeCalendar refuses while the service is in use', () => {
  it('refuses for trips, flex zones, timeframes and booking rules; removes when unused', () => {
    s().setCalendars([cal('WK'), cal('SPARE')]);
    s().setCalendarDates([{ service_id: 'WK', date: '20261225', exception_type: 2 }]);
    s().setTrips([trip('T1')]);
    s().setFlexZones([zone('Z', { additionalWindows: [{ serviceId: 'WK', pickupWindowStart: '', pickupWindowEnd: '' }] })]);
    s().setTimeframes([{ timeframe_group_id: 'PEAK', service_id: 'WK' }]);

    expect(s().removeCalendar('WK')).toBe(false);
    expect(s().calendars).toHaveLength(2);
    expect(s().calendarDates).toHaveLength(1);
    expect(calendarReferences(s(), 'WK')).toEqual({ trips: 1, flexZones: 1, timeframes: 1, bookingRules: 0 });

    expect(s().removeCalendar('SPARE')).toBe(true);
    expect(s().calendars.map((c) => c.service_id)).toEqual(['WK']);
  });

  it('counts a booking rule’s prior-notice service', () => {
    s().setFlexZones([zone('Z', { bookingRule: { bookingType: 2, priorNoticeServiceId: 'WK' } })]);
    expect(calendarReferences(s(), 'WK').bookingRules).toBe(1);
  });
});

describe('C2-16: addCalendarDate upserts on (service_id, date)', () => {
  it('adding the same date twice keeps one row; a new type replaces the old', () => {
    s().addCalendarDate({ service_id: 'WK', date: '20261225', exception_type: 2 });
    s().addCalendarDate({ service_id: 'WK', date: '20261225', exception_type: 2 });
    expect(s().calendarDates).toHaveLength(1);
    s().addCalendarDate({ service_id: 'WK', date: '20261225', exception_type: 1 });
    expect(s().calendarDates).toEqual([{ service_id: 'WK', date: '20261225', exception_type: 1 }]);
  });
});

describe('S1-15: levels cascade to stops.level_id', () => {
  it('rename follows; delete clears', () => {
    s().setLevels([{ level_id: 'L1', level_index: 0 }] as never);
    s().setStops([stop('P1', { level_id: 'L1' })]);
    s().updateLevel(0, { level_id: 'L2' });
    expect(s().stops[0].level_id).toBe('L2');
    s().removeLevel(0);
    expect(s().stops[0].level_id).toBeUndefined();
  });
});

describe('S1-29: fare_attributes cascade to flex zones', () => {
  it('rename follows; delete clears', () => {
    s().setFareAttributes([{ fare_id: 'F1', price: 1, currency_type: 'USD', payment_method: 0, transfers: 0 }] as never);
    s().setFlexZones([zone('Z', { fareId: 'F1' })]);
    s().renameFareId('F1', 'BASE');
    expect(s().flexZones[0].fareId).toBe('BASE');
    s().removeFareAttribute('BASE');
    expect(s().flexZones[0].fareId).toBeUndefined();
  });
});

describe('S1-16: Fares v2 area rename/delete', () => {
  it('rename cascades to leg rules; delete is refused while a leg rule uses the area', () => {
    s().addFareArea({ area_id: 'AR' });
    s().setFareLegRules([{ fare_product_id: 'P', from_area_id: 'AR', to_area_id: 'AR' }]);
    s().renameFareAreaId('AR', 'DOWNTOWN');
    expect(s().fareLegRules[0]).toMatchObject({ from_area_id: 'DOWNTOWN', to_area_id: 'DOWNTOWN' });

    const res = s().removeFareArea('DOWNTOWN');
    expect(res).toMatchObject({ removed: false, fareLegRules: [0] });
    expect(s().fareAreas).toHaveLength(1);

    s().setFareLegRules([]);
    expect(s().removeFareArea('DOWNTOWN').removed).toBe(true);
    expect(s().fareAreas).toHaveLength(0);
  });
});

describe('C1-01: appendRouteStop', () => {
  it('appends past 1-based imported seqs and seeds a blank stop_time', () => {
    s().setRoutes([route('R')]);
    s().setRouteStops([rs('S1', 1, { shape_id: 'SH' }), rs('S2', 2, { shape_id: 'SH' }), rs('S3', 3, { shape_id: 'SH' })]);
    s().setTrips([trip('T1', { shape_id: 'SH' })]);
    s().setStopTimes([st('T1', 'S1', 1, '08:00:00'), st('T1', 'S2', 2, '08:05:00'), st('T1', 'S3', 3, '08:10:00')]);

    const seq = s().appendRouteStop({ route_id: 'R', stop_id: 'NEW', direction_id: 0, shape_id: 'SH', _snapped: false });
    expect(seq).toBe(4);
    expect(s().routeStops.find((r) => r.stop_id === 'NEW')!.stop_sequence).toBe(4);
    expect(s().stopTimes.find((x) => x.stop_id === 'NEW')).toMatchObject({ trip_id: 'T1', stop_sequence: 4, arrival_time: '' });
  });

  it('after removing a middle stop the appended sequence is still unique', () => {
    s().setRoutes([route('R')]);
    s().setRouteStops([rs('S0', 0, { _uid: 'u0' }), rs('S1', 1, { _uid: 'u1' }), rs('S2', 2, { _uid: 'u2' })]);
    s().removeRouteStop('R', 'u1');
    const seq = s().appendRouteStop({ route_id: 'R', stop_id: 'NEW', direction_id: 0, _snapped: false });
    expect(seq).toBe(3);
    const seqs = s().routeStops.map((r) => r.stop_sequence);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('counts the matching trips’ stop_times, and only the target shape’s pattern', () => {
    s().setRouteStops([rs('A1', 0, { shape_id: 'A' }), rs('A2', 7, { shape_id: 'A' }), rs('B1', 0, { shape_id: 'B' })]);
    s().setTrips([trip('TB', { shape_id: 'B' })]);
    s().setStopTimes([st('TB', 'B1', 0), st('TB', 'X', 2)]);
    expect(s().appendRouteStop({ route_id: 'R', stop_id: 'NEW', direction_id: 0, shape_id: 'B', _snapped: false })).toBe(3);
  });
});

describe('C1-06: removeShapeFromRoute', () => {
  function seedShared() {
    s().setRoutes([route('A'), route('B')]);
    s().setShapes([shape('S')]);
    s().setTrips([
      trip('ta', { route_id: 'A', shape_id: 'S' }),
      trip('tb', { route_id: 'B', shape_id: 'S' }),
    ]);
    s().setStopTimes([st('ta', 'X', 0, '08:00:00'), st('tb', 'X', 0, '09:00:00')]);
    s().setFrequencies([freq('ta')]);
    s().setRouteStops([
      rs('X', 0, { route_id: 'A', shape_id: 'S' }),
      rs('X', 0, { route_id: 'B', shape_id: 'S' }),
    ]);
    resetHistory();
  }

  it('deleting from route A keeps B’s trips and the shared shape, leaves no orphans', () => {
    seedShared();
    const res = s().removeShapeFromRoute('S', 'A');
    expect(res).toEqual({ removedTripIds: ['ta'], shapeRemoved: false });
    expect(s().trips.map((t) => t.trip_id)).toEqual(['tb']);
    expect(s().stopTimes.map((x) => x.trip_id)).toEqual(['tb']);
    expect(s().frequencies).toHaveLength(0);
    expect(s().routeStops.some((r) => r.route_id === 'A')).toBe(false);
    expect(s().shapes).toHaveLength(1);
    expect(historyDepths().undo).toBe(1);

    // Now B is the last user: the shape goes too.
    expect(s().removeShapeFromRoute('S', 'B').shapeRemoved).toBe(true);
    expect(s().shapes).toHaveLength(0);
  });

  it('keeps a shape drafted for another route', () => {
    s().setShapes([shape('S', { _route_id: 'B' })]);
    s().setTrips([trip('ta', { route_id: 'A', shape_id: 'S' })]);
    expect(s().removeShapeFromRoute('S', 'A').shapeRemoved).toBe(false);
  });
});

describe('C2-10: duplicateTrip cloneFrequencies', () => {
  it('copies the frequency windows to the new trip only when asked', () => {
    s().setTrips([trip('F')]);
    s().setStopTimes([st('F', 'A', 0, '06:00:00')]);
    s().setFrequencies([freq('F')]);
    s().duplicateTrip('F', 'F2', 0);
    expect(s().frequencies.map((f) => f.trip_id)).toEqual(['F']);
    s().duplicateTrip('F', 'F3', 60, { cloneFrequencies: true });
    const f3 = s().frequencies.find((f) => f.trip_id === 'F3')!;
    expect(f3).toMatchObject({ start_time: '07:00:00', end_time: '10:00:00', headway_secs: 600 });
  });
});

describe('S1-20: interpolateStopTimes uses the trip’s own shape pattern', () => {
  it('two shapes in one direction → monotonic, about halfway', () => {
    s().setStops([
      stop('P1', { stop_lat: 45.00 }), stop('P2', { stop_lat: 45.005 }), stop('P3', { stop_lat: 45.01 }),
      stop('Q', { stop_lat: 45.009 }),
    ]);
    s().setRouteStops([
      rs('P1', 0, { shape_id: 'SA' }), rs('P2', 1, { shape_id: 'SA' }), rs('P3', 2, { shape_id: 'SA' }),
      rs('P1', 0, { shape_id: 'SB' }), rs('Q', 1, { shape_id: 'SB' }), rs('P3', 2, { shape_id: 'SB' }),
    ]);
    s().setTrips([trip('T1', { shape_id: 'SA' })]);
    s().setStopTimes([st('T1', 'P1', 0, '08:00:00'), st('T1', 'P2', 1), st('T1', 'P3', 2, '08:20:00')]);
    s().interpolateStopTimes('T1');
    expect(s().stopTimes.find((x) => x.stop_id === 'P2')!.arrival_time).toBe('08:10:00');
  });
});

describe('S1-21: duplicateRoute and a scoped setShapeDirection', () => {
  it('a trip-less route’s copy gets its own shapes; flipping it leaves the original', () => {
    s().setRoutes([route('R')]);
    s().setShapes([shape('SA', { _route_id: 'R' }), shape('SB')]);
    s().setRouteStops([
      rs('P1', 0, { shape_id: 'SA' }), rs('P2', 1, { shape_id: 'SA' }), rs('P3', 2, { shape_id: 'SA' }),
      rs('P1', 0, { shape_id: 'SB', direction_id: 1 }),
    ]);
    const copy = s().duplicateRoute('R')!;
    const copyShapeIds = new Set(s().routeStops.filter((r) => r.route_id === copy).map((r) => r.shape_id));
    expect(copyShapeIds.has('SA')).toBe(false);
    expect(copyShapeIds.has('SB')).toBe(false);
    for (const id of copyShapeIds) {
      const sh = s().shapes.find((x) => x.shape_id === id);
      expect(sh).toBeDefined();
      expect(sh!._route_id).toBe(copy);
    }
    const copySA = [...copyShapeIds].find((id) => id!.startsWith('SA'))!;
    s().setShapeDirection(copySA, 1, { invertStops: true, routeId: copy });
    const orig = s().routeStops.filter((r) => r.route_id === 'R' && r.shape_id === 'SA');
    expect(orig.map((r) => [r.stop_id, r.stop_sequence, r.direction_id])).toEqual([
      ['P1', 0, 0], ['P2', 1, 0], ['P3', 2, 0],
    ]);
  });

  it('copies frequencies for the cloned trips', () => {
    s().setRoutes([route('R')]);
    s().setTrips([trip('T1')]);
    s().setFrequencies([freq('T1')]);
    const copy = s().duplicateRoute('R')!;
    const copyTrip = s().trips.find((t) => t.route_id === copy)!;
    expect(s().frequencies.map((f) => f.trip_id).sort()).toEqual(['T1', copyTrip.trip_id].sort());
  });

  it('setShapeDirection with routeId only retags that route', () => {
    s().setTrips([trip('ta', { route_id: 'A', shape_id: 'S' }), trip('tb', { route_id: 'B', shape_id: 'S' })]);
    s().setShapeDirection('S', 1, { routeId: 'A' });
    expect(s().trips.map((t) => t.direction_id)).toEqual([1, 0]);
  });
});

describe('C5-10: clearAccessIsochrone drops the chosen service', () => {
  it('resets accessParams.serviceId and keeps the other params', () => {
    s().setAccessParams({ serviceId: 'GONE', walkMinutes: 15 as never });
    s().clearAccessIsochrone();
    expect(s().accessParams.serviceId).toBeNull();
    expect(s().accessParams.walkMinutes).toBe(15);
  });
});

describe('C5-17: only the active reply clears the streaming flag', () => {
  it('a stale stream finishing after New does not re-enable Send', () => {
    const id1 = s().startAssistantReply();
    s().newAssistantConversation();
    s().startAssistantReply();
    s().finishAssistantReply(id1, 'answered' as never);
    expect(s().assistantStreaming).toBe(true);
    s().setAssistantReplyError(id1, 'late error');
    expect(s().assistantStreaming).toBe(true);
  });

  it('the active reply’s finish clears it', () => {
    const id = s().startAssistantReply();
    s().finishAssistantReply(id, 'answered' as never);
    expect(s().assistantStreaming).toBe(false);
  });
});
