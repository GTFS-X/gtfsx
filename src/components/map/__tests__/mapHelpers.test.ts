// C1-18 (Add Stop never creates a route), C1-26 (shape label via _route_id),
// C1-27 (RouteLayer lookup indexes match the linear finds).
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../../store';
import { selectAddStopRoute } from '../addStopRoute';
import { shapeEditLabel } from '../shapeEditLabel';
import { firstTripByShape, routesById } from '../routeLayerIndex';
import type { Route, Shape, Trip } from '../../../types/gtfs';

const s = () => useStore.getState();
const route = (id: string, name = id): Route =>
  ({ route_id: id, route_short_name: name, route_long_name: '', route_type: 3, route_color: '000000' }) as Route;
const trip = (id: string, extra: Partial<Trip> = {}): Trip =>
  ({ trip_id: id, route_id: 'R', service_id: 'WK', direction_id: 0, ...extra }) as Trip;
const shape = (id: string, extra: Partial<Shape> = {}): Shape => ({ shape_id: id, points: [], ...extra });

describe('C1-18: Add Stop route selection', () => {
  beforeEach(() => {
    s().setRoutes([]); s().setShapes([]); s().setTrips([]);
    s().selectRoute(null);
  });

  it('no shapes, no routes: creates nothing and selects nothing', () => {
    selectAddStopRoute();
    expect(s().routes).toHaveLength(0);
    expect(s().selectedRouteId).toBeNull();
  });

  it('no shapes, two routes, nothing selected: creates nothing', () => {
    s().setRoutes([route('A'), route('B')]);
    selectAddStopRoute();
    expect(s().routes).toHaveLength(2);
    expect(s().selectedRouteId).toBeNull();
  });

  it('exactly one route is selected; a valid selection is kept', () => {
    s().setRoutes([route('A')]);
    selectAddStopRoute();
    expect(s().selectedRouteId).toBe('A');
    s().setRoutes([route('A'), route('B')]);
    s().selectRoute('B');
    selectAddStopRoute();
    expect(s().selectedRouteId).toBe('B');
  });

  it('a stale selection is cleared rather than replaced by a new route', () => {
    s().setRoutes([route('A'), route('B')]);
    s().selectRoute('GONE');
    selectAddStopRoute();
    expect(s().routes).toHaveLength(2);
    expect(s().selectedRouteId).toBeNull();
  });

  it('defaults to the latest drawn shape’s draft route', () => {
    s().setRoutes([route('A'), route('B')]);
    s().setShapes([shape('S1', { _route_id: 'A' }), shape('S2', { _route_id: 'B' })]);
    selectAddStopRoute();
    expect(s().selectedRouteId).toBe('B');
  });
});

describe('C1-26: shapeEditLabel', () => {
  it('resolves a trip-less drawn shape’s route via _route_id', () => {
    const label = shapeEditLabel('S', [shape('S', { _name: 'shape', _route_id: 'R' })], [], [route('R', 'R')]);
    expect(label).toBe('R · shape');
  });

  it('prefers the trip’s route when one exists', () => {
    const label = shapeEditLabel(
      'S', [shape('S', { _name: 'shape', _route_id: 'X' })], [trip('T', { shape_id: 'S' })],
      [route('R', 'R'), route('X', 'X')],
    );
    expect(label).toBe('R · shape');
  });
});

describe('C1-27: RouteLayer indexes', () => {
  it('match trips.find / routes.find', () => {
    const trips = [
      trip('T1', { shape_id: 'A', route_id: 'R1' }),
      trip('T2', { shape_id: 'A', route_id: 'R2' }),
      trip('T3', { shape_id: 'B', route_id: 'R2' }),
      trip('T4'),
    ];
    const idx = firstTripByShape(trips);
    for (const id of ['A', 'B', 'C']) {
      expect(idx.get(id)).toBe(trips.find((t) => t.shape_id === id));
    }
    const routes = [route('R1'), route('R2'), { ...route('R1'), route_short_name: 'dup' }];
    const byId = routesById(routes);
    expect(byId.get('R1')).toBe(routes.find((r) => r.route_id === 'R1'));
    expect(byId.get('R2')).toBe(routes[1]);
  });
});
