// The shape editor's mapbox-gl-draw mode: direct_select, plus
//
//  - select-priority hit testing: a press near an existing vertex selects it
//    (nearest in screen pixels, within SELECT_PRIORITY_RADIUS_PX) instead of
//    inserting a vertex at an overlapping midpoint; Alt/Option forces an
//    insert (on a midpoint, or anywhere on the line). Pressing the same spot
//    again cycles through overlapping vertices.
//  - range selection: click a start vertex, Shift-click an end vertex, and
//    every vertex between them in shape order is selected and the segment is
//    highlighted. Delete removes the whole run (one undo step via draw.update).
//    Cmd/Ctrl-click toggles single vertices (draw's old Shift behaviour).
//  - "Redraw segment" waypoint capture: while shapeEditController.redraw is
//    set, clicks add waypoints for the replacement path instead of editing,
//    and a preview line is drawn. MapView owns routing + the splice.
//  - no whole-feature drag (the old DirectSelectNoDrag).
//
// The mode reports its selection to React by firing `gtfsx.shapeedit` on the
// map (see ShapeEditEvent).

import MapboxDraw from '@mapbox/mapbox-gl-draw';
import {
  CYCLE_SAME_SPOT_PX, chooseCandidate, isContiguous, rangeIndices, removeVertices, vertexCandidates,
  type LngLat, type Pixel,
} from './shapeRangeEdit';

export const SHAPE_EDIT_EVENT = 'gtfsx.shapeedit';
/** Draw mode name the shape editor runs in (registered in DrawControl). */
export const SHAPE_EDIT_MODE = 'shape_edit';

export interface ShapeEditEvent {
  /** Selected vertex indices, ascending. */
  selected: number[];
  /** Vertex count of the shape being edited. */
  total: number;
  /** Range anchor (the last plain-clicked vertex), or null. */
  anchor: number | null;
  /** Waypoints placed so far while redrawing (null when not redrawing). */
  redrawWaypoints: LngLat[] | null;
  /** Set when an action was refused (e.g. delete would leave < 2 vertices). */
  refused?: string;
}

interface RedrawState {
  startIdx: number;
  endIdx: number;
  waypoints: LngLat[];
}

/**
 * Shared between the draw mode and MapView. Module scope (not React state)
 * because the draw mode's handlers run outside React.
 */
export const shapeEditController: {
  redraw: RedrawState | null;
  /** Bumped to ask the active mode to re-render (set by MapView). */
  requestRender: (() => void) | null;
} = { redraw: null, requestRender: null };

/* eslint-disable @typescript-eslint/no-explicit-any */
type ModeThis = any;
type ModeState = any;
type DrawEvt = any;

const base = MapboxDraw.modes.direct_select as any;

const isVertexEvt = (e: DrawEvt) => e.featureTarget?.properties?.meta === 'vertex';
const isMidpointEvt = (e: DrawEvt) => e.featureTarget?.properties?.meta === 'midpoint';
const isActiveFeatureEvt = (e: DrawEvt) =>
  e.featureTarget?.properties?.meta === 'feature' && e.featureTarget?.properties?.active === 'true';
const altDown = (e: DrawEvt) => !!e.originalEvent?.altKey;
const shiftDown = (e: DrawEvt) => !!e.originalEvent?.shiftKey;
const toggleDown = (e: DrawEvt) => !!(e.originalEvent?.metaKey || e.originalEvent?.ctrlKey);

function coordsOf(state: ModeState): LngLat[] {
  return (state.feature.getCoordinates?.() ?? state.feature.coordinates) as LngLat[];
}

function selectedIndices(state: ModeState): number[] {
  return (state.selectedCoordPaths as string[]).map((p) => parseInt(p, 10)).sort((a, b) => a - b);
}

function emit(self: ModeThis, state: ModeState, refused?: string): void {
  const detail: ShapeEditEvent = {
    selected: selectedIndices(state),
    total: coordsOf(state).length,
    anchor: state.anchorIdx ?? null,
    redrawWaypoints: shapeEditController.redraw ? [...shapeEditController.redraw.waypoints] : null,
    refused,
  };
  self.map.fire(SHAPE_EDIT_EVENT, detail);
}

function setSelection(self: ModeThis, state: ModeState, indices: number[]): void {
  state.selectedCoordPaths = indices.map(String);
  self.setSelectedCoordinates(self.pathsToCoordinates(state.featureId, state.selectedCoordPaths));
  state.feature.changed();
}

function pixelsOf(self: ModeThis, coords: LngLat[]): Pixel[] {
  return coords.map((c) => {
    const p = self.map.project(c);
    return { x: p.x, y: p.y };
  });
}

/** Insert a vertex on the segment nearest to the press (Alt-click on the line). */
function insertOnNearestSegment(self: ModeThis, state: ModeState, e: DrawEvt): number | null {
  const coords = coordsOf(state);
  const px = pixelsOf(self, coords);
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < px.length - 1; i++) {
    const a = px[i];
    const b = px[i + 1];
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len2 = vx * vx + vy * vy;
    let t = len2 > 0 ? ((e.point.x - a.x) * vx + (e.point.y - a.y) * vy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const dx = a.x + t * vx - e.point.x;
    const dy = a.y + t * vy - e.point.y;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best === -1) return null;
  const at = best + 1;
  state.feature.addCoordinate(String(at), e.lngLat.lng, e.lngLat.lat);
  return at;
}

/**
 * Apply a vertex pick with the event's modifiers: Shift extends a range from
 * the anchor, Cmd/Ctrl toggles one vertex, plain selects just this one. On the
 * press (not the cycling click), a press on part of an existing multi-selection
 * keeps it so the whole run can be dragged.
 */
function applyPick(self: ModeThis, state: ModeState, idx: number, e: DrawEvt, isPress: boolean): void {
  const current = selectedIndices(state);
  if (shiftDown(e) && state.anchorIdx !== null && state.anchorIdx !== undefined) {
    setSelection(self, state, rangeIndices(state.anchorIdx, idx));
  } else if (toggleDown(e)) {
    const set = new Set(current);
    if (isPress) { if (set.has(idx)) set.delete(idx); else set.add(idx); }
    else { set.delete(state.pressPick); set.add(idx); }
    setSelection(self, state, [...set].sort((a, b) => a - b));
    state.anchorIdx = idx;
  } else if (isPress && current.includes(idx) && current.length > 1) {
    // keep the multi-selection for a group drag
  } else {
    setSelection(self, state, [idx]);
    state.anchorIdx = idx;
  }
}

export const ShapeEditMode = {
  ...base,

  onSetup(this: ModeThis, opts: unknown) {
    const state = base.onSetup.call(this, opts);
    state.anchorIdx = null;
    state.lastClick = null;
    state.pressPick = null;
    shapeEditController.requestRender = () => {
      state.feature.changed();
      this._ctx?.store?.render?.();
    };
    queueMicrotask(() => emit(this, state));
    return state;
  },

  onStop(this: ModeThis, state: ModeState) {
    shapeEditController.redraw = null;
    shapeEditController.requestRender = null;
    base.onStop.call(this, state);
  },

  // No whole-feature drag: dragging the line itself is a no-op.
  dragFeature() {},

  onTouchStart(this: ModeThis, state: ModeState, e: DrawEvt) {
    return (ShapeEditMode as any).onMouseDown.call(this, state, e);
  },

  onMouseDown(this: ModeThis, state: ModeState, e: DrawEvt) {
    if (shapeEditController.redraw) return; // clicks become waypoints (onClick)

    const onLineOrPoint = isVertexEvt(e) || isMidpointEvt(e) || isActiveFeatureEvt(e) || !e.featureTarget;
    if (!onLineOrPoint) return;

    // Alt/Option: always insert, never select.
    if (altDown(e)) {
      if (isMidpointEvt(e)) {
        state.anchorIdx = null;
        base.onMidpoint.call(this, state, e);
        emit(this, state);
        return;
      }
      if (isActiveFeatureEvt(e) || isVertexEvt(e)) {
        const at = insertOnNearestSegment(this, state, e);
        if (at !== null) {
          this.fireUpdate();
          setSelection(this, state, [at]);
          state.anchorIdx = at;
          this.startDragging(state, e);
          emit(this, state);
        }
      }
      return;
    }

    const coords = coordsOf(state);
    const cands = vertexCandidates(pixelsOf(this, coords), e.point);
    // Pressing where the last click landed keeps that click's pick (which may
    // have been cycled), so a cycled-to vertex can then be dragged.
    const last = state.lastClick;
    const sameSpot = last && Math.hypot(last.at.x - e.point.x, last.at.y - e.point.y) <= CYCLE_SAME_SPOT_PX;
    const idx = sameSpot && cands.includes(last.chosen) ? last.chosen : (cands[0] ?? null);
    state.pressCands = cands;
    state.pressAt = { x: e.point.x, y: e.point.y };
    state.pressPick = idx;

    if (idx === null) {
      // Not near any vertex: a midpoint still inserts (draw's behaviour); a
      // press on the bare line or empty map falls through to draw.
      if (isMidpointEvt(e)) {
        state.anchorIdx = null;
        base.onMidpoint.call(this, state, e);
        emit(this, state);
      } else if (isActiveFeatureEvt(e)) {
        base.onFeature.call(this, state, e);
      }
      return;
    }

    applyPick(this, state, idx, e, true);
    this.startDragging(state, e);
    emit(this, state);
  },

  onClick(this: ModeThis, state: ModeState, e: DrawEvt) {
    const rd = shapeEditController.redraw;
    if (rd) {
      rd.waypoints.push([e.lngLat.lng, e.lngLat.lat]);
      state.feature.changed();
      emit(this, state);
      return;
    }
    // A click whose press picked a vertex (via the pixel radius) must not fall
    // into draw's "click on empty map → leave direct_select" path. Clicking the
    // same spot again steps to the next overlapping vertex.
    if (state.pressPick !== null && state.pressPick !== undefined && state.pressAt) {
      const next = chooseCandidate(state.pressCands ?? [], state.pressAt, state.lastClick);
      const pick = next ?? state.pressPick;
      if (pick !== state.pressPick) {
        applyPick(this, state, pick, e, false);
        emit(this, state);
      }
      state.lastClick = { at: state.pressAt, chosen: pick };
      state.pressPick = null;
      this.stopDragging(state);
      return;
    }
    state.lastClick = null;
    if (!e.featureTarget) {
      // Empty map: clear the selection but stay in the editor (draw's default
      // drops to simple_select, which strands the edit with no vertices).
      state.anchorIdx = null;
      setSelection(this, state, []);
      this.clearSelectedCoordinates();
      emit(this, state);
      return;
    }
    if (isActiveFeatureEvt(e)) {
      state.anchorIdx = null;
      base.clickActiveFeature.call(this, state, e);
      emit(this, state);
      return;
    }
    this.stopDragging(state);
  },

  onTap(this: ModeThis, state: ModeState, e: DrawEvt) {
    return (ShapeEditMode as any).onClick.call(this, state, e);
  },

  onDrag(this: ModeThis, state: ModeState, e: DrawEvt) {
    if (shapeEditController.redraw) return;
    return base.onDrag.call(this, state, e);
  },

  onTrash(this: ModeThis, state: ModeState) {
    if (shapeEditController.redraw) return;
    const sel = selectedIndices(state);
    if (sel.length === 0) return;
    const kept = removeVertices(coordsOf(state), sel);
    if (!kept) {
      emit(this, state, 'A shape needs at least two points — that would delete too many.');
      return;
    }
    // Remove highest index first so earlier indices stay valid.
    for (const i of [...sel].sort((a, b) => b - a)) state.feature.removeCoordinate(String(i));
    this.fireUpdate();
    state.selectedCoordPaths = [];
    state.anchorIdx = null;
    this.clearSelectedCoordinates();
    this.fireActionable(state);
    emit(this, state);
  },

  toDisplayFeatures(this: ModeThis, state: ModeState, geojson: any, push: (f: unknown) => void) {
    base.toDisplayFeatures.call(this, state, geojson, push);
    if (geojson.properties.id !== state.featureId) return;
    const coords = coordsOf(state);
    const sel = selectedIndices(state);
    // Highlight the selected run of the shape.
    if (sel.length >= 2 && isContiguous(sel)) {
      push({
        type: 'Feature',
        properties: { meta: 'range', parent: state.featureId, active: 'true' },
        geometry: { type: 'LineString', coordinates: coords.slice(sel[0], sel[sel.length - 1] + 1) },
      });
    }
    const rd = shapeEditController.redraw;
    if (rd && coords[rd.startIdx] && coords[rd.endIdx]) {
      push({
        type: 'Feature',
        properties: { meta: 'redraw_preview', parent: state.featureId, active: 'true' },
        geometry: { type: 'LineString', coordinates: [coords[rd.startIdx], ...rd.waypoints, coords[rd.endIdx]] },
      });
      rd.waypoints.forEach((w, i) => push({
        type: 'Feature',
        properties: { meta: 'redraw_waypoint', parent: state.featureId, active: 'true', n: String(i + 1) },
        geometry: { type: 'Point', coordinates: w },
      }));
    }
  },
};
/* eslint-enable @typescript-eslint/no-explicit-any */
