import { describe, it, expect } from 'vitest';
import { placeStopOptions, resolveStopPlacement, type StopPlacementInput } from '../stopPlacement';
import type { Route, RouteStop, Shape } from '../../types/gtfs';

// Regression for the forum report "Place stops on map sometimes adds stops to
// wrong shape" (2026-10-02): an out-and-back route whose two drawn shapes run
// along the same street. The user picks the second shape ("Northbound") in the
// Stops tab, clicks "+ Create new stop", then "Place on Map". Opening the New
// stop panel unmounts the Stops tab, which cleared stopPlacementShapeId, so each
// click snapped to whichever overlapping shape happened to be nearer — some
// stops landed on "Southbound".

const line = (lon: number, lat0: number, lat1: number) => [0, 1, 2, 3].map((i) => ({
  shape_pt_lat: lat0 + ((lat1 - lat0) * i) / 3,
  shape_pt_lon: lon,
  shape_pt_sequence: i,
  shape_dist_traveled: 0,
}));

// Southbound drawn first, Northbound second, ~8 m apart on the same road.
const sb: Shape = { shape_id: 'sb', _name: 'Southbound', _route_id: 'r11', points: line(-78.7, 42.93, 42.88) };
const nb: Shape = { shape_id: 'nb', _name: 'Northbound', _route_id: 'r11', points: line(-78.6999, 42.88, 42.93) };
// Southbound already has its stops (direction 0); Northbound has none yet.
const sbStops: RouteStop[] = [0, 1, 2, 3].map((i) => ({
  route_id: 'r11', stop_id: `s${i}`, direction_id: 0, stop_sequence: i, shape_id: 'sb', _snapped: true,
}));

const base: StopPlacementInput = {
  clickLon: -78.70002, // a hair closer to Southbound than Northbound
  clickLat: 42.9,
  selectedRouteId: 'r11',
  stopPlacementMode: 'snap_to_route',
  stopPlacementDirection: 1,
  stopPlacementShapeId: null, // Stops tab unmounted while the New stop panel is open
  stopsPanelShapeId: 'nb', // "Edit Stops" on Northbound
  trips: [],
  routeStops: sbStops,
  shapes: [sb, nb],
};

describe('resolveStopPlacement', () => {
  it('attaches to the shape picked in the Stops panel even after the tab unmounts', () => {
    const t = resolveStopPlacement(base);
    expect(t.shapeId).toBe('nb');
    expect(t.directionId).toBe(1);
    expect(t.lon).toBeCloseTo(-78.6999, 6); // snapped onto Northbound, not Southbound
  });

  it('follows the direction chosen in "Assign to" when no shape is pinned', () => {
    expect(resolveStopPlacement({ ...base, stopsPanelShapeId: null }).shapeId).toBe('nb');
    const sbTarget = resolveStopPlacement({
      ...base, stopsPanelShapeId: null, stopPlacementDirection: 0, clickLon: -78.69992,
    });
    expect(sbTarget.shapeId).toBe('sb');
    expect(sbTarget.directionId).toBe(0);
  });

  it('honours the shape mirrored from an open Stops tab', () => {
    const t = resolveStopPlacement({ ...base, stopPlacementShapeId: 'sb', stopsPanelShapeId: null, stopPlacementDirection: 0, clickLon: -78.69992 });
    expect(t.shapeId).toBe('sb');
  });

  it('ignores a stale target shape from another route', () => {
    const t = resolveStopPlacement({ ...base, stopPlacementShapeId: 'other-route-shape' });
    expect(t.shapeId).toBe('nb');
  });

  it('tags freehand stops with the active shape so they show in its stop list', () => {
    const t = resolveStopPlacement({ ...base, stopPlacementMode: 'freehand' });
    expect(t.shapeId).toBe('nb');
    expect(t.lon).toBe(-78.70002); // not snapped
  });

  it('does not snap or tag a shape without a route', () => {
    // No route selected → no snapping, no shape.
    const t = resolveStopPlacement({ ...base, selectedRouteId: null });
    expect(t.shapeId).toBeUndefined();
    expect(t.lon).toBe(-78.70002);
  });
});

describe('placeStopOptions ("Assign to" dropdown)', () => {
  const route = { route_id: 'r11', route_short_name: '11', route_type: 3, route_color: '8E24AA' } as Route;

  it('lists each drawn shape by name, carrying its shape and pattern direction', () => {
    const opts = placeStopOptions([route], [], sbStops, [sb, nb]);
    expect(opts.map((o) => [o.label, o.shapeId, o.directionId])).toEqual([
      ['11 — Southbound', 'sb', 0],
      ['11 — Northbound', 'nb', 1],
    ]);
  });

  it('matches the Stops tab when the second-drawn shape got its stops first', () => {
    // Stops placed on nb in direction 0 before sb has any: the Stops tab calls
    // nb direction 0, so the dropdown must too (the old draw-order rule said 1).
    const nbStops: RouteStop[] = [{ route_id: 'r11', stop_id: 'x', direction_id: 0, stop_sequence: 0, shape_id: 'nb', _snapped: true }];
    const opts = placeStopOptions([route], [], nbStops, [sb, nb]);
    expect(opts.find((o) => o.shapeId === 'nb')?.directionId).toBe(0);
    expect(opts.find((o) => o.shapeId === 'sb')?.directionId).toBe(1);
  });

  it('skips routes with no shapes', () => {
    expect(placeStopOptions([{ ...route, route_id: 'empty' }], [], [], [sb, nb])).toEqual([]);
  });
});
