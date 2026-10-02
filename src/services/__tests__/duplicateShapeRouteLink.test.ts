// Regression: duplicating a shape that has no trips (a draft, or a shape with
// stops but "Copy stops" off) produced a copy with no trip, no stops and no
// _route_id, so it belonged to no route and vanished from the Shapes list.
import { describe, it, expect } from 'vitest';
import { duplicateShapeRouteLink } from '../shapeHelpers';
import { deriveRouteShapeIds } from '../routeShapes';
import type { RouteStop, Shape, Trip } from '../../types/gtfs';

const trip = { trip_id: 't', route_id: 'r', service_id: 'svc', direction_id: 0, shape_id: 'SRC' } as Trip;
const stop = { route_id: 'r', stop_id: 's1', direction_id: 0, stop_sequence: 0, shape_id: 'SRC' } as RouteStop;

describe('duplicateShapeRouteLink', () => {
  it('tags the copy of a draft shape (no trips, no stops) with the route', () => {
    expect(duplicateShapeRouteLink('SRC', 'r', true, [], [])).toBe('r');
  });

  it('tags the copy when the source has stops but Copy stops is off', () => {
    expect(duplicateShapeRouteLink('SRC', 'r', false, [], [stop])).toBe('r');
  });

  it('leaves the copy untagged when it gets copied stops', () => {
    expect(duplicateShapeRouteLink('SRC', 'r', true, [], [stop])).toBeUndefined();
  });

  it('leaves the copy untagged when it gets a stub trip', () => {
    expect(duplicateShapeRouteLink('SRC', 'r', false, [trip], [])).toBeUndefined();
    expect(duplicateShapeRouteLink('SRC', 'r', true, [trip], [stop])).toBeUndefined();
  });

  it('returns undefined with no route', () => {
    expect(duplicateShapeRouteLink('SRC', null, true, [], [])).toBeUndefined();
  });

  it('keeps the copy in the route\'s shape list in every case', () => {
    const cases: { trips: Trip[]; stops: RouteStop[]; copyStops: boolean }[] = [
      { trips: [], stops: [], copyStops: true },
      { trips: [], stops: [stop], copyStops: false },
      { trips: [], stops: [stop], copyStops: true },
      { trips: [trip], stops: [], copyStops: false },
    ];
    for (const c of cases) {
      const src: Shape = { shape_id: 'SRC', points: [], ...(c.trips.length || c.stops.length ? {} : { _route_id: 'r' }) };
      // Mirror RouteShapesTab.handleDuplicateShape: shape (+ link), stub trip, copied stops.
      const link = duplicateShapeRouteLink('SRC', 'r', c.copyStops, c.trips, c.stops);
      const copy: Shape = { shape_id: 'COPY', points: [], ...(link ? { _route_id: link } : {}) };
      const trips = [...c.trips, ...c.trips.map((t) => ({ ...t, trip_id: 't2', shape_id: 'COPY' }))];
      const stops = [...c.stops, ...(c.copyStops ? c.stops.map((s) => ({ ...s, shape_id: 'COPY' })) : [])];
      expect(deriveRouteShapeIds('r', trips, stops, [src, copy])).toContain('COPY');
    }
  });
});
