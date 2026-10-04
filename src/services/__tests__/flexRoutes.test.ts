// C3-04: only a route that exists purely for one flex zone is "flex-only"; a
// mixed fixed + flex route is a real route. S2-23: rail buffer lookup.
import { describe, expect, it } from 'vitest';
import { flexOnlyRouteIds, isFlexOnlyRoute } from '../flexRoutes';
import { bufferMilesForStop, railStopIds } from '../walkshedProfile';
import type { Route, RouteStop } from '../../types/gtfs';

describe('isFlexOnlyRoute', () => {
  const zones = [{ routeId: 'FLEX' }, { routeId: 'MIXED' }, { routeId: 'SHARED' }, { routeId: 'SHARED' }];
  const trips = [{ route_id: 'MIXED' }, { route_id: 'FIXED' }];
  const state = { trips, flexZones: zones };

  it('is true only for a trip-less route of exactly one zone', () => {
    expect(isFlexOnlyRoute(state, 'FLEX')).toBe(true);
    expect(isFlexOnlyRoute(state, 'MIXED')).toBe(false);
    expect(isFlexOnlyRoute(state, 'SHARED')).toBe(false);
    expect(isFlexOnlyRoute(state, 'FIXED')).toBe(false);
    expect(isFlexOnlyRoute(state, undefined)).toBe(false);
    expect(flexOnlyRouteIds(state)).toEqual(new Set(['FLEX']));
  });
});

describe('railStopIds / bufferMilesForStop', () => {
  const routes = [
    { route_id: 'T', route_type: 0 }, { route_id: 'B', route_type: 3 },
  ] as Route[];
  const rs = [
    { route_id: 'T', stop_id: 'tram', direction_id: 0, stop_sequence: 1, _snapped: true },
    { route_id: 'B', stop_id: 'bus', direction_id: 0, stop_sequence: 1, _snapped: true },
  ] as RouteStop[];

  it('a tram stop gets ½ mi, a bus stop ¼ mi', () => {
    expect(railStopIds(rs, routes)).toEqual(new Set(['tram']));
    expect(bufferMilesForStop('tram', rs, routes)).toBe(0.5);
    expect(bufferMilesForStop('bus', rs, routes)).toBe(0.25);
  });
});
