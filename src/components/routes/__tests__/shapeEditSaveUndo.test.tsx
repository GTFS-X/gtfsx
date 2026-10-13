// @vitest-environment jsdom
// E1 follow-up: Route › Shapes › Simplify then Save took TWO Ctrl+Z to get the
// original shape back. Simplify commits its points (one "Simplify shape" step),
// and Save then rewrote the same points from the draw buffer, recording a
// second, no-op "reshape route" step on top. Vertex drags have the same shape:
// each drag is committed by draw.update, then Save rewrote it again.
//
// Rendered end to end: RouteShapesTab drives the edit session (Edit Shape,
// Simplify, Save, Cancel) and MapView owns the save/discard path. Only the
// map canvas and the mapbox-gl-draw control are faked: the draw stub keeps
// the feature MapView loads into it and reports it back on getAll(), as the
// real control does.
import '../../../test-utils/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { resetStore, store } from '../../../test-utils/store';
import { historyDepths, undo, COALESCE_WINDOW_MS } from '../../../store/history';
import type { Route, Shape, ShapePoint, Trip } from '../../../types/gtfs';

type Feature = GeoJSON.Feature<GeoJSON.LineString>;
const draw = vi.hoisted(() => ({
  features: [] as unknown[],
  onUpdate: null as null | ((e: { features: unknown[] }) => void),
}));

vi.mock('react-map-gl/mapbox', async () => {
  const { Children, isValidElement, createElement, Fragment } = await import('react');
  const { DrawControl } = await import('../../map/DrawControl');
  return {
    // Render only the (faked) draw control out of the map's children.
    default: (props: { children?: ReactNode }) =>
      createElement(Fragment, null, ...Children.toArray(props.children).filter(
        (c) => isValidElement(c) && c.type === DrawControl,
      )),
    NavigationControl: () => null,
  };
});
vi.mock('../../map/DrawControl', () => ({
  DrawControl: (props: {
    drawRef?: { current: unknown };
    onUpdate?: (e: { features: unknown[] }) => void;
  }) => {
    draw.onUpdate = props.onUpdate ?? null;
    if (props.drawRef) {
      props.drawRef.current = {
        add: (f: Feature) => { draw.features = [{ ...f, id: 'f1' }]; return ['f1']; },
        getAll: () => ({ type: 'FeatureCollection', features: draw.features }),
        deleteAll: () => { draw.features = []; },
        changeMode: () => {},
        trash: () => {},
      };
    }
    return null;
  },
}));

import { RouteShapesTab } from '../RouteShapesTab';
import { MapView } from '../../map/MapView';

// A zig-zag the Heavy level reduces to its two endpoints.
const ORIGINAL: ShapePoint[] = Array.from({ length: 9 }, (_, i) => ({
  shape_pt_lat: 45 + i * 0.001,
  shape_pt_lon: -111 + (i % 2) * 0.00001,
  shape_pt_sequence: i,
  shape_dist_traveled: i * 111,
}));

const points = () => store().shapes.find((s) => s.shape_id === 'SH')!.points;
const coords = (pts: ShapePoint[]) => pts.map((p) => [p.shape_pt_lon, p.shape_pt_lat]);

beforeEach(() => {
  draw.features = [];
  resetStore({
    routes: [{ route_id: 'R', route_short_name: '1', route_long_name: 'One', route_type: 3, route_color: '336699' } as Route],
    shapes: [{ shape_id: 'SH', points: ORIGINAL } as Shape],
    trips: [{ trip_id: 'T1', route_id: 'R', service_id: 'WK', direction_id: 0, shape_id: 'SH' } as Trip],
    selectedRouteId: 'R',
    editingRouteId: 'R',
  });
});
afterEach(() => { vi.useRealTimers(); });

// MapView has its own Save/Cancel bar while editing; drive the tab's buttons.
const tab = () => within(screen.getByRole('region', { name: 'shapes tab' }));

function renderEditor() {
  render(<><MapView /><section aria-label="shapes tab"><RouteShapesTab /></section></>);
}

async function simplifyHeavy(user: ReturnType<typeof userEvent.setup>) {
  await user.click(tab().getByRole('button', { name: 'Edit Shape' }));
  expect(store().mapMode).toBe('edit_shape');
  await user.click(tab().getByRole('button', { name: 'Simplify' }));
  await user.click(tab().getByRole('button', { name: /^Heavy/ }));
  // The picker re-enters edit mode after a 50 ms tick; MapView then loads the
  // simplified line into the draw buffer.
  await vi.waitFor(() => {
    expect(store().mapMode).toBe('edit_shape');
    expect(store().editingShapeId).toBe('SH');
    expect(tab().getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });
  expect(points().length).toBeLessThan(ORIGINAL.length);
  expect((draw.features[0] as Feature).geometry.coordinates).toEqual(coords(points()));
}

describe('Route › Shapes edit session undo (E1 follow-up)', () => {
  it('Simplify then Save is ONE undo step back to the original shape', async () => {
    const user = userEvent.setup();
    renderEditor();
    await simplifyHeavy(user);
    const simplified = points();

    await user.click(tab().getByRole('button', { name: 'Save' }));
    expect(store().mapMode).toBe('select');
    expect(points()).toEqual(simplified);
    expect(historyDepths().undo).toBe(1);

    act(() => { undo(); });
    expect(points()).toEqual(ORIGINAL);
  });

  it('Simplify then Cancel restores the original shape', async () => {
    const user = userEvent.setup();
    renderEditor();
    await simplifyHeavy(user);
    await user.click(tab().getByRole('button', { name: 'Cancel' }));
    expect(store().mapMode).toBe('select');
    // Discard re-measures shape_dist_traveled, so compare the geometry.
    expect(coords(points())).toEqual(coords(ORIGINAL));
  });

  it('a vertex drag then Save is ONE undo step', async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.click(tab().getByRole('button', { name: 'Edit Shape' }));
    expect(draw.features).toHaveLength(1);

    // Drag vertex 4 (the draw control reports the whole line on draw.update).
    const dragged = coords(ORIGINAL).map((c, i) => (i === 4 ? [c[0] + 0.0005, c[1]] : c));
    draw.features = [{ ...(draw.features[0] as Feature), geometry: { type: 'LineString', coordinates: dragged } }];
    act(() => draw.onUpdate!({ features: draw.features }));
    expect(points()[4].shape_pt_lon).toBeCloseTo(ORIGINAL[4].shape_pt_lon + 0.0005, 9);

    // Save well after the drag, outside the coalescing window.
    await new Promise((r) => setTimeout(r, COALESCE_WINDOW_MS + 50));
    await user.click(tab().getByRole('button', { name: 'Save' }));
    expect(historyDepths().undo).toBe(1);

    act(() => { undo(); });
    expect(points()).toEqual(ORIGINAL);
  });

  it('Save still commits a buffer that differs from the store', async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.click(tab().getByRole('button', { name: 'Edit Shape' }));
    // An edit the store never saw (no draw.update): Save must write it.
    const moved = coords(ORIGINAL).map((c, i) => (i === 0 ? [c[0], c[1] - 0.001] : c));
    draw.features = [{ ...(draw.features[0] as Feature), geometry: { type: 'LineString', coordinates: moved } }];
    await user.click(tab().getByRole('button', { name: 'Save' }));
    expect(points()[0].shape_pt_lat).toBeCloseTo(ORIGINAL[0].shape_pt_lat - 0.001, 9);
    act(() => { undo(); });
    expect(points()).toEqual(ORIGINAL);
  });
});
