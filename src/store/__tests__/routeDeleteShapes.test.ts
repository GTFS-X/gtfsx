// Regression (Mark, 2026-06-27): create a new route, draw its shape, delete the
// route — the shape was left orphaned on the map (a gray line, no longer in the
// route list). Cause: removeRoute collected the route's shapes only from its
// trips, so a freshly drawn shape linked via the editor-only `shape._route_id`
// draft association (no trip yet) was never deleted. removeRoute now also clears
// shapes by `_route_id` and route-stops, while keeping shapes used elsewhere.
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../index';

beforeEach(() => {
  const s = useStore.getState();
  s.setRoutes([]);
  s.setRouteStops([]);
  s.setTrips([]);
  s.setStopTimes([]);
  s.setShapes([]);
});

describe('removeRoute cleans up the route’s shapes', () => {
  it('removes a freshly-drawn draft shape linked only via shape._route_id (no trips)', () => {
    const s = useStore.getState();
    s.setRoutes([
      { route_id: 'NEW', route_short_name: 'N', route_type: 3 },
      { route_id: 'KEEP', route_short_name: 'K', route_type: 3 },
    ] as never);
    s.setShapes([
      { shape_id: 'SH_NEW', _route_id: 'NEW', points: [] },
      { shape_id: 'SH_KEEP', _route_id: 'KEEP', points: [] },
    ] as never);

    useStore.getState().removeRoute('NEW');

    const shapeIds = useStore.getState().shapes.map((sh) => sh.shape_id);
    expect(shapeIds).not.toContain('SH_NEW'); // the orphan is gone
    expect(shapeIds).toContain('SH_KEEP'); // another route's shape survives
    expect(useStore.getState().routes.map((r) => r.route_id)).toEqual(['KEEP']);
  });

  it('keeps a shape still used by another route’s trips', () => {
    const s = useStore.getState();
    s.setRoutes([{ route_id: 'A', route_type: 3 }, { route_id: 'B', route_type: 3 }] as never);
    s.setShapes([{ shape_id: 'SHARED', points: [] }] as never);
    s.setTrips([
      { trip_id: 'tA', route_id: 'A', service_id: 'WK', shape_id: 'SHARED', direction_id: 0 },
      { trip_id: 'tB', route_id: 'B', service_id: 'WK', shape_id: 'SHARED', direction_id: 0 },
    ] as never);

    useStore.getState().removeRoute('A');
    expect(useStore.getState().shapes.map((sh) => sh.shape_id)).toContain('SHARED');
  });
});
