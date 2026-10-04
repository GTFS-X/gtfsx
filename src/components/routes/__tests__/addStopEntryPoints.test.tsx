// @vitest-environment jsdom
// C1-01 / C1-02: all three ways to add a stop to a route must go through
// appendRouteStop, so the new stop gets a sequence past every one the pattern
// AND its trips' stop_times already use (its own timetable column), tagged
// with the selected shape:
//   1. Route > Stops > "Add existing"            (RouteStopsTab)
//   2. "+ Create new stop" > manual Create       (CreateStopPanel)
//   3. Map Add Stop click with a route selected  (MapView place_stop)
// C1-02: the Stops tab keeps the placement shape while CreateStopPanel is open,
// and CreateStopPanel clears it when it closes.
// The store action is pinned in storeCascades; these pin the call sites.
import '../../../test-utils/dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { resetStore, store } from '../../../test-utils/store';
import type { Route, RouteStop, Shape, Stop, StopTime, Trip } from '../../../types/gtfs';

// MapView: replace the react-map-gl canvas with a stub that exposes its
// onClick handler, so the test can fire a map click. Nothing else is mocked.
const mapProps = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
vi.mock('react-map-gl/mapbox', () => ({
  default: (props: Record<string, unknown>) => { mapProps.current = props; return null; },
  NavigationControl: () => null,
}));
vi.mock('../../../services/suggestStopName', () => ({ suggestStopName: async () => null }));

import { RouteStopsTab } from '../RouteStopsTab';
import { CreateStopPanel } from '../../stops/CreateStopPanel';
import { MapView } from '../../map/MapView';

const stop = (id: string, lat: number): Stop =>
  ({ stop_id: id, stop_name: `Stop ${id}`, stop_lat: lat, stop_lon: -111, location_type: 0 }) as Stop;
const rs = (stop_id: string, seq: number): RouteStop =>
  ({ route_id: 'R', stop_id, direction_id: 0, stop_sequence: seq, shape_id: 'SH', _uid: `u-${stop_id}` }) as RouteStop;
const st = (stop_id: string, seq: number, t: string): StopTime =>
  ({ trip_id: 'T1', stop_id, stop_sequence: seq, arrival_time: t, departure_time: t }) as StopTime;
const shape: Shape = {
  shape_id: 'SH',
  points: [
    { shape_pt_lat: 45, shape_pt_lon: -111, shape_pt_sequence: 0, shape_dist_traveled: 0 },
    { shape_pt_lat: 45.03, shape_pt_lon: -111, shape_pt_sequence: 1, shape_dist_traveled: 3300 },
  ],
} as Shape;

/** An imported, gapped pattern: route_stops use 1 and 2, but the trip also has
 *  a stop_times row at 3 (a stop the pattern lacks). max(route_stops)+1 = 3
 *  would collide with that column; the next free sequence is 4. */
function seedGappedImport(extra: Record<string, unknown> = {}) {
  resetStore({
    routes: [{ route_id: 'R', route_short_name: '10', route_long_name: 'Ten', route_type: 3 } as Route],
    stops: [stop('S1', 45), stop('S2', 45.01), stop('S3', 45.02), stop('NEW', 45.025)],
    shapes: [shape],
    routeStops: [rs('S1', 1), rs('S2', 2)],
    trips: [{ trip_id: 'T1', route_id: 'R', service_id: 'WK', direction_id: 0, shape_id: 'SH' } as Trip],
    stopTimes: [st('S1', 1, '08:00:00'), st('S2', 2, '08:05:00'), st('S3', 3, '08:10:00')],
    editingRouteId: 'R',
    selectedRouteId: 'R',
    stopsPanelShapeId: 'SH',
    ...extra,
  });
}

function expectOwnColumn(stopId: string) {
  const added = store().routeStops.filter((r) => r.stop_id === stopId);
  expect(added).toHaveLength(1);
  expect(added[0].stop_sequence).toBe(4);
  expect(added[0].shape_id).toBe('SH');
  // appendRouteStop seeds a blank stop_time in the new column for the trip.
  expect(store().stopTimes.filter((x) => x.stop_id === stopId)).toEqual([
    expect.objectContaining({ trip_id: 'T1', stop_sequence: 4, arrival_time: '' }),
  ]);
}

describe('add-stop entry points use appendRouteStop (C1-01)', () => {
  beforeEach(() => seedGappedImport());

  it('Route > Stops > Add existing', async () => {
    const user = userEvent.setup();
    render(<RouteStopsTab />);
    const picker = screen.getAllByRole('combobox').find((el) =>
      Array.from((el as HTMLSelectElement).options).some((o) => o.text === 'Add existing stop...'))!;
    await user.selectOptions(picker, 'NEW');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expectOwnColumn('NEW');
  });

  it('+ Create new stop > manual Create', async () => {
    const user = userEvent.setup();
    resetStore({ ...store(), creatingStop: true });
    render(<CreateStopPanel />);
    const [lat, lon] = [screen.getByPlaceholderText('45.6770'), screen.getByPlaceholderText('-111.0429')];
    await user.type(lat, '45.026');
    await user.type(lon, '-111');
    await user.click(screen.getByRole('button', { name: 'Create & add to route' }));
    const created = store().stops.find((s) => s.stop_lat === 45.026)!;
    expect(created).toBeTruthy();
    expectOwnColumn(created.stop_id);
  });

  it('Map Add Stop click with a route selected', async () => {
    resetStore({ ...store(), mapMode: 'place_stop', stopPlacementMode: 'freehand', stopPlacementShapeId: 'SH' });
    render(<MapView />);
    const onClick = mapProps.current!.onClick as (e: unknown) => void;
    act(() => onClick({ lngLat: { lng: -111, lat: 45.027 }, features: [], point: { x: 0, y: 0 } }));
    const created = store().stops.find((s) => Math.abs(s.stop_lat - 45.027) < 1e-6)!;
    expect(created).toBeTruthy();
    expectOwnColumn(created.stop_id);
  });
});

describe('stop placement shape hand-off (C1-02)', () => {
  beforeEach(() => seedGappedImport());

  it('the Stops tab keeps the placement shape when "+ Create new stop" swaps it out', async () => {
    const user = userEvent.setup();
    const view = render(<RouteStopsTab />);
    expect(store().stopPlacementShapeId).toBe('SH');
    await user.click(screen.getByRole('button', { name: /Create new stop/ }));
    expect(store().creatingStop).toBe(true);
    view.unmount(); // RightRail swaps the tab for CreateStopPanel
    expect(store().stopPlacementShapeId).toBe('SH');
  });

  it('the Stops tab clears the placement shape when it closes for any other reason', () => {
    const view = render(<RouteStopsTab />);
    expect(store().stopPlacementShapeId).toBe('SH');
    view.unmount();
    expect(store().stopPlacementShapeId).toBeNull();
  });

  it('closing CreateStopPanel clears the placement shape it inherited', () => {
    // Global Stops panel context (no route): the panel resolves no shape of its
    // own, so only its unmount-clear can drop the one the Stops tab left.
    resetStore({ ...store(), editingRouteId: null, selectedRouteId: null, creatingStop: true, stopPlacementShapeId: 'SH' });
    const view = render(<CreateStopPanel />);
    view.unmount();
    expect(store().stopPlacementShapeId).toBeNull();
  });
});
