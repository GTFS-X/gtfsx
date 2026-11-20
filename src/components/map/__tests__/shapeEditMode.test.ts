// @vitest-environment jsdom
// The shape editor's draw mode, driven with a fake mode context: a press near
// a vertex selects it even when draw's own hit test returned a midpoint (the
// dense-cluster bug), Shift-click selects a range, Alt inserts, Delete removes
// the range but never leaves fewer than two points, and Redraw captures
// waypoints instead of editing.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShapeEditMode, shapeEditController, SHAPE_EDIT_EVENT, type ShapeEditEvent } from '../shapeEditMode';

type LngLat = [number, number];

/* eslint-disable @typescript-eslint/no-explicit-any */
function makeMode(coords: LngLat[]) {
  const feature = {
    coordinates: coords.map((c) => [...c] as LngLat),
    getCoordinates() { return this.coordinates; },
    changed: vi.fn(),
    addCoordinate(path: string, lng: number, lat: number) { this.coordinates.splice(parseInt(path, 10), 0, [lng, lat]); },
    removeCoordinate(path: string) { this.coordinates.splice(parseInt(path, 10), 1); },
    isValid() { return this.coordinates.length > 1; },
  };
  const events: ShapeEditEvent[] = [];
  const updates: number[] = [];
  const self: any = {
    ...ShapeEditMode,
    // 1 degree = 1000 px, so pixel math is easy to reason about.
    map: {
      project: (c: LngLat) => ({ x: c[0] * 1000, y: c[1] * 1000 }),
      fire: (type: string, e: ShapeEditEvent) => { if (type === SHAPE_EDIT_EVENT) events.push(e); },
      dragPan: { isEnabled: () => true, disable: () => {}, enable: () => {} },
    },
    getFeature: () => feature,
    setSelected: () => {},
    setSelectedCoordinates: () => {},
    clearSelectedCoordinates: () => {},
    setActionableState: () => {},
    fireUpdate: () => updates.push(feature.coordinates.length),
    fireActionable: () => {},
    changeMode: vi.fn(),
    _ctx: { store: { render: () => {} } },
  };
  const state = self.onSetup({ featureId: 'f1' });
  return { self, state, feature, events, updates };
}

const press = (x: number, y: number, target?: { meta: string; coord_path?: string; lng?: number; lat?: number }, mods: Record<string, boolean> = {}) => ({
  point: { x, y },
  lngLat: { lng: x / 1000, lat: y / 1000 },
  originalEvent: { button: 0, ...mods },
  featureTarget: target ? { properties: { active: 'true', ...target } } : undefined,
});

// Vertices at x = 0, 3, 6, 9 … px (3 px apart: a dense cluster at this zoom).
const line: LngLat[] = Array.from({ length: 10 }, (_, i) => [i * 0.003, 0]);
/* eslint-enable @typescript-eslint/no-explicit-any */

beforeEach(() => { shapeEditController.redraw = null; });

describe('shape edit mode', () => {
  it('a press on a midpoint next to a vertex SELECTS the vertex, it does not insert', () => {
    const { self, state, feature } = makeMode(line);
    // Midpoint between vertex 2 (6 px) and 3 (9 px) sits at 7.5 px.
    self.onMouseDown(state, press(7.5, 0, { meta: 'midpoint', coord_path: '3', lng: 0.0075, lat: 0 }));
    expect(feature.coordinates).toHaveLength(10);
    expect(state.selectedCoordPaths).toHaveLength(1);
    expect(['2', '3']).toContain(state.selectedCoordPaths[0]);
  });

  it('Alt on a midpoint inserts a vertex', () => {
    const { self, state, feature } = makeMode(line);
    self.onMouseDown(state, press(7.5, 0, { meta: 'midpoint', coord_path: '3', lng: 0.0075, lat: 0 }, { altKey: true }));
    expect(feature.coordinates).toHaveLength(11);
  });

  it('a midpoint far from any vertex still inserts (normal editing)', () => {
    const wide: LngLat[] = [[0, 0], [0.1, 0]]; // 100 px apart
    const { self, state, feature } = makeMode(wide);
    self.onMouseDown(state, press(50, 0, { meta: 'midpoint', coord_path: '1', lng: 0.05, lat: 0 }));
    expect(feature.coordinates).toHaveLength(3);
  });

  it('click + Shift-click selects the whole run in shape order and reports it', () => {
    const { self, state, events } = makeMode(line);
    self.onMouseDown(state, press(6, 0, { meta: 'vertex', coord_path: '2' }));
    self.onClick(state, press(6, 0, { meta: 'vertex', coord_path: '2' }));
    self.onMouseDown(state, press(21, 0, { meta: 'vertex', coord_path: '7' }, { shiftKey: true }));
    expect(state.selectedCoordPaths).toEqual(['2', '3', '4', '5', '6', '7']);
    const last = events.at(-1)!;
    expect(last.selected).toEqual([2, 3, 4, 5, 6, 7]);
    expect(last.total).toBe(10);
  });

  it('Delete removes the selected range in one update; refuses to leave < 2 points', () => {
    const { self, state, feature, updates, events } = makeMode(line);
    self.onMouseDown(state, press(3, 0, { meta: 'vertex' }));
    self.onClick(state, press(3, 0, { meta: 'vertex' }));
    self.onMouseDown(state, press(24, 0, { meta: 'vertex' }, { shiftKey: true }));
    self.onTrash(state);
    expect(feature.coordinates).toEqual([line[0], line[9]]);
    expect(updates).toEqual([2]);

    self.onMouseDown(state, press(0, 0, { meta: 'vertex' }));
    self.onTrash(state);
    expect(feature.coordinates).toHaveLength(2);
    expect(events.at(-1)!.refused).toMatch(/at least two/);
  });

  it('clicking the same spot again cycles to the next overlapping vertex', () => {
    // Two legs of a shape overlapping: vertex 1 and vertex 4 at the same pixel.
    const overlap: LngLat[] = [[0, 0], [0.05, 0], [0.05, 0.05], [0.1, 0.05], [0.0501, 0], [0.1, 0]];
    const { self, state } = makeMode(overlap);
    const at = press(50, 0, { meta: 'vertex' });
    self.onMouseDown(state, at); self.onClick(state, at);
    const first = state.selectedCoordPaths[0];
    self.onMouseDown(state, at); self.onClick(state, at);
    const second = state.selectedCoordPaths[0];
    expect(new Set([first, second])).toEqual(new Set(['1', '4']));
  });

  it('clicking empty map clears the selection but stays in the editor', () => {
    const { self, state } = makeMode(line);
    self.onMouseDown(state, press(3, 0, { meta: 'vertex' }));
    self.onClick(state, press(3, 0, { meta: 'vertex' }));
    self.onMouseDown(state, press(500, 500));
    self.onClick(state, press(500, 500));
    expect(state.selectedCoordPaths).toEqual([]);
    expect(self.changeMode).not.toHaveBeenCalled();
  });

  it('while redrawing, clicks add waypoints and nothing is edited', () => {
    const { self, state, feature, events } = makeMode(line);
    shapeEditController.redraw = { startIdx: 2, endIdx: 7, waypoints: [] };
    self.onMouseDown(state, press(7.5, 0, { meta: 'midpoint', coord_path: '3', lng: 0.0075, lat: 0 }));
    self.onClick(state, press(100, 40));
    self.onClick(state, press(120, 40));
    self.onTrash(state);
    expect(feature.coordinates).toHaveLength(10);
    expect(shapeEditController.redraw.waypoints).toEqual([[0.1, 0.04], [0.12, 0.04]]);
    expect(events.at(-1)!.redrawWaypoints).toHaveLength(2);
    const pushed: Array<{ properties?: { meta?: string } }> = [];
    self.toDisplayFeatures(state, { properties: { id: 'f1' }, geometry: { type: 'LineString', coordinates: line } }, (f: unknown) => pushed.push(f as { properties?: { meta?: string } }));
    expect(pushed.some((f) => f.properties?.meta === 'redraw_preview')).toBe(true);
  });
});
