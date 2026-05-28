/**
 * Lifecycle tests for the Routes > Shapes editing flow.
 *
 * The current model (post-2026-05-28 revision): edit_shape mode survives
 * tab + section changes. Save / Cancel buttons are anchored on the map
 * (next to the Editing Shape banner) so the user can navigate freely
 * without losing their work. trim_shape — a single-click action with no
 * in-progress state — still resets immediately when navigation fires.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../store';

function resetStore() {
  const s = useStore.getState();
  s.setRoutes([]);
  s.setTrips([]);
  s.setShapes([]);
  s.setMapMode('select');
  s.setEditingShapeId(null);
  s.setSidebarSection(null);
  s.setRouteDetailTab('details');
  s.selectRoute(null);
}

beforeEach(resetStore);
afterEach(resetStore);

function seedRoute(routeId = 'rA'): void {
  useStore.getState().addRoute({
    route_id: routeId,
    agency_id: '',
    route_short_name: 'A',
    route_long_name: 'Test Route',
    route_type: 3,
    route_color: '274BAC',
    route_text_color: 'FFFFFF',
  });
}

function seedShape(shapeId: string, routeId: string, directionId: 0 | 1 = 0): void {
  const s = useStore.getState();
  s.addShape({
    shape_id: shapeId,
    points: [
      { shape_pt_lat: 0, shape_pt_lon: 0, shape_pt_sequence: 0, shape_dist_traveled: 0 },
      { shape_pt_lat: 0.001, shape_pt_lon: 0.001, shape_pt_sequence: 1, shape_dist_traveled: 50 },
      { shape_pt_lat: 0.002, shape_pt_lon: 0.002, shape_pt_sequence: 2, shape_dist_traveled: 100 },
    ],
  });
  s.addTrip({
    trip_id: `${shapeId}-t1`,
    route_id: routeId,
    service_id: 'svc1',
    direction_id: directionId,
    shape_id: shapeId,
    trip_headsign: 'Downtown',
  });
}

describe('Enter and leave edit_shape mode', () => {
  it('canonical enter / save transitions', () => {
    seedRoute();
    seedShape('s1', 'rA');
    const s = useStore.getState();
    s.setEditingShapeId('s1');
    s.setMapMode('edit_shape');
    expect(useStore.getState().mapMode).toBe('edit_shape');
    expect(useStore.getState().editingShapeId).toBe('s1');

    s.setEditingShapeId(null);
    s.setMapMode('select');
    expect(useStore.getState().mapMode).toBe('select');
    expect(useStore.getState().editingShapeId).toBeNull();
  });
});

describe('Edit mode survives navigation (Save / Cancel live on the map)', () => {
  it('switching routeDetailTab off Shapes keeps edit_shape mode alive', () => {
    seedRoute();
    seedShape('s1', 'rA');
    const s = useStore.getState();
    s.setRouteDetailTab('shapes');
    s.setEditingShapeId('s1');
    s.setMapMode('edit_shape');

    s.setRouteDetailTab('details');

    const after = useStore.getState();
    expect(after.routeDetailTab).toBe('details');
    expect(after.mapMode).toBe('edit_shape');
    expect(after.editingShapeId).toBe('s1');
  });

  it('switching sidebarSection off "routes" keeps edit_shape mode alive', () => {
    seedRoute();
    seedShape('s1', 'rA');
    const s = useStore.getState();
    s.setSidebarSection('routes');
    s.setEditingShapeId('s1');
    s.setMapMode('edit_shape');

    s.setSidebarSection('stops');

    const after = useStore.getState();
    expect(after.sidebarSection).toBe('stops');
    expect(after.mapMode).toBe('edit_shape');
    expect(after.editingShapeId).toBe('s1');
  });

  it('closing the rail (section=null) keeps edit_shape mode alive', () => {
    seedRoute();
    seedShape('s1', 'rA');
    const s = useStore.getState();
    s.setSidebarSection('routes');
    s.setEditingShapeId('s1');
    s.setMapMode('edit_shape');

    s.setSidebarSection(null);

    const after = useStore.getState();
    expect(after.sidebarSection).toBeNull();
    expect(after.rightRailOpen).toBe(false);
    expect(after.mapMode).toBe('edit_shape');
    expect(after.editingShapeId).toBe('s1');
  });
});

describe('Trim mode still resets immediately on navigation', () => {
  it('routeDetailTab change off "shapes" clears trim_shape', () => {
    seedRoute();
    seedShape('s1', 'rA');
    const s = useStore.getState();
    s.setRouteDetailTab('shapes');
    s.setEditingShapeId('s1');
    s.setMapMode('trim_shape');

    s.setRouteDetailTab('details');

    const after = useStore.getState();
    expect(after.routeDetailTab).toBe('details');
    expect(after.mapMode).toBe('select');
    expect(after.editingShapeId).toBeNull();
  });

  it('sidebarSection change off "routes" clears trim_shape', () => {
    seedRoute();
    seedShape('s1', 'rA');
    const s = useStore.getState();
    s.setSidebarSection('routes');
    s.setEditingShapeId('s1');
    s.setMapMode('trim_shape');

    s.setSidebarSection('agency');

    const after = useStore.getState();
    expect(after.sidebarSection).toBe('agency');
    expect(after.mapMode).toBe('select');
    expect(after.editingShapeId).toBeNull();
  });
});

describe('Duplicate flow at the store level', () => {
  it('after addShape + addTrip the new shape appears alongside the original', () => {
    seedRoute();
    seedShape('s1', 'rA');
    const s = useStore.getState();
    const before = s.shapes.length;
    s.addShape({
      shape_id: 's1-copy',
      points: s.shapes[0].points.map((p, i) => ({ ...p, shape_pt_sequence: i })),
    });
    s.addTrip({
      ...s.trips[0],
      trip_id: 's1-copy-t1',
      shape_id: 's1-copy',
      trip_headsign: 'Downtown (copy)',
    });
    const after = useStore.getState();
    expect(after.shapes.length).toBe(before + 1);
    expect(after.shapes.map((sh) => sh.shape_id)).toContain('s1-copy');
    expect(after.trips.filter((t) => t.shape_id === 's1-copy').length).toBe(1);
  });
});

describe('Switching between shapes mid-edit', () => {
  it('changing editingShapeId without leaving edit_shape stays in edit mode', () => {
    seedRoute();
    seedShape('s1', 'rA');
    seedShape('s2', 'rA', 1);
    const s = useStore.getState();
    s.setEditingShapeId('s1');
    s.setMapMode('edit_shape');

    s.setEditingShapeId('s2');

    const after = useStore.getState();
    expect(after.mapMode).toBe('edit_shape');
    expect(after.editingShapeId).toBe('s2');
  });
});

describe('RoutePopup → pendingShapeEditId handoff', () => {
  it('setting pendingShapeEditId hands off the edit target to RouteShapesTab', () => {
    seedRoute();
    seedShape('s1', 'rA');
    const s = useStore.getState();
    s.setPendingShapeEditId('s1');
    expect(useStore.getState().pendingShapeEditId).toBe('s1');
    s.setPendingShapeEditId(null);
    expect(useStore.getState().pendingShapeEditId).toBeNull();
  });
});
