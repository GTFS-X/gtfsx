// C3-04: deleting / renaming a flex zone paired to a mixed fixed + flex route
// must not delete / rename the fixed route. C3-17: create and delete are one
// undo step each. C3-26: fare label uses the fare's currency.
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../../store';
import { undo, resetHistory, historyDepths } from '../../../store/history';
import { createFlexZoneWithRoute, deleteFlexZoneWithRoute } from '../flexHelpers';
import { formatFarePrice } from '../flexFormat';
import type { Route, StopTime, Trip } from '../../../types/gtfs';
import type { FlexZone } from '../../../store/flexSlice';

const s = () => useStore.getState();
const route = (id: string, name = id): Route =>
  ({ route_id: id, route_short_name: name, route_long_name: `${name} long`, route_type: 3 }) as Route;
const zone = (id: string, routeId?: string): FlexZone =>
  ({ id, name: id, routeId, bufferMiles: 0, geojson: { type: 'FeatureCollection', features: [] } }) as FlexZone;

beforeEach(() => {
  const x = s();
  x.setRoutes([]); x.setTrips([]); x.setStopTimes([]); x.setStops([]);
  x.setFlexZones([]); x.setCalendars([]); x.setCalendarDates([]);
  resetHistory();
});

describe('deleteFlexZoneWithRoute', () => {
  it('keeps a mixed fixed + flex route and its trips (C3-04)', () => {
    s().setRoutes([route('R5', '5')]);
    s().setTrips([{ trip_id: 'T1', route_id: 'R5', service_id: 'WK', direction_id: 0 } as Trip]);
    s().setStopTimes([{ trip_id: 'T1', stop_id: 'S', stop_sequence: 1, arrival_time: '08:00:00', departure_time: '08:00:00' } as StopTime]);
    s().setFlexZones([zone('G', 'R5')]);

    deleteFlexZoneWithRoute('G');

    expect(s().flexZones).toHaveLength(0);
    expect(s().routes.map((r) => r.route_id)).toEqual(['R5']);
    expect(s().trips.map((t) => t.trip_id)).toEqual(['T1']);
    expect(s().stopTimes).toHaveLength(1);
  });

  it('still removes a flex-only route with its zone, as one undo step (C3-17)', () => {
    s().setRoutes([route('RF')]);
    s().setFlexZones([zone('Z', 'RF')]);
    resetHistory();

    deleteFlexZoneWithRoute('Z');
    expect(s().routes).toHaveLength(0);
    expect(s().flexZones).toHaveLength(0);
    expect(historyDepths().undo).toBe(1);

    undo();
    expect(s().routes.map((r) => r.route_id)).toEqual(['RF']);
    expect(s().flexZones.map((z) => z.id)).toEqual(['Z']);
  });

  it('keeps a route shared by two zones', () => {
    s().setRoutes([route('RS')]);
    s().setFlexZones([zone('A', 'RS'), zone('B', 'RS')]);
    deleteFlexZoneWithRoute('A');
    expect(s().routes.map((r) => r.route_id)).toEqual(['RS']);
    expect(s().flexZones.map((z) => z.id)).toEqual(['B']);
  });
});

describe('createFlexZoneWithRoute', () => {
  it('route + zone is one undo step (C3-17)', () => {
    createFlexZoneWithRoute({ ...zone('NEW'), name: 'Service Area 1' });
    expect(s().routes).toHaveLength(1);
    expect(s().flexZones).toHaveLength(1);
    expect(historyDepths().undo).toBe(1);
    undo();
    expect(s().routes).toHaveLength(0);
    expect(s().flexZones).toHaveLength(0);
  });
});

describe('formatFarePrice (C3-26)', () => {
  it('uses the fare currency instead of a literal $', () => {
    const eur = formatFarePrice('2.5', 'EUR');
    expect(eur).not.toContain('$');
    expect(eur).toContain('2.50');
    expect(formatFarePrice('2.5', 'USD')).toContain('$');
  });

  it('falls back for an unknown currency code', () => {
    expect(formatFarePrice('3', 'NOTACODE')).toBe('3.00 NOTACODE');
    expect(formatFarePrice('1', '')).toBe('1.00');
  });
});

describe('updateRoute rename and the paired zone (C3-04, both directions)', () => {
  it('renames the zone of a flex-only route', () => {
    s().setRoutes([route('RF', 'Old')]);
    s().setFlexZones([zone('Z', 'RF')]);
    s().updateRoute('RF', { route_long_name: 'Downtown Flex' });
    expect(s().flexZones[0].name).toBe('Downtown Flex');
  });

  it('leaves the zone alone when a mixed fixed + flex route is renamed', () => {
    s().setRoutes([route('R5', '5')]);
    s().setTrips([{ trip_id: 'T1', route_id: 'R5', service_id: 'WK', direction_id: 0 } as Trip]);
    s().setFlexZones([zone('G', 'R5')]);
    s().updateRoute('R5', { route_short_name: '5X' });
    expect(s().routes[0].route_short_name).toBe('5X');
    expect(s().flexZones[0].name).toBe('G');
  });

  it('leaves both zones alone when a route shared by two zones is renamed', () => {
    s().setRoutes([route('RS')]);
    s().setFlexZones([zone('A', 'RS'), zone('B', 'RS')]);
    s().updateRoute('RS', { route_long_name: 'Shared' });
    expect(s().flexZones.map((z) => z.name)).toEqual(['A', 'B']);
  });
});
