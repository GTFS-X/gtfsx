// @vitest-environment jsdom
// Issue #76: the Imperial / Metric toggle drives the distance readouts, and the
// choice persists in this browser. Pinned on the Route › Stops tab's
// stop-spacing column (the first display converted) and the Shapes tab length.
import '../../../test-utils/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { resetStore, store } from '../../../test-utils/store';
import type { Route, RouteStop, Shape, Stop, Trip } from '../../../types/gtfs';
import { UNIT_SYSTEM_STORAGE_KEY, loadUnitSystem } from '../../../utils/units';
import { UnitsToggle } from '../UnitsToggle';
import { RouteStopsTab } from '../../routes/RouteStopsTab';
import { RouteShapesTab } from '../../routes/RouteShapesTab';

// 0.001° of latitude ≈ 111.2 m ≈ 365 ft.
const stop = (id: string, lat: number): Stop =>
  ({ stop_id: id, stop_name: `Stop ${id}`, stop_lat: lat, stop_lon: -111, location_type: 0 }) as Stop;
const rs = (stop_id: string, seq: number): RouteStop =>
  ({ route_id: 'R', stop_id, direction_id: 0, stop_sequence: seq, shape_id: 'SH', _uid: `u-${stop_id}` }) as RouteStop;
// ~0.1° of latitude ≈ 11.1 km ≈ 6.9 mi.
const shape: Shape = {
  shape_id: 'SH',
  points: [
    { shape_pt_lat: 45, shape_pt_lon: -111, shape_pt_sequence: 0 },
    { shape_pt_lat: 45.1, shape_pt_lon: -111, shape_pt_sequence: 1 },
  ],
} as Shape;

function seed() {
  resetStore({
    routes: [{ route_id: 'R', route_short_name: '10', route_long_name: 'Ten', route_type: 3 } as Route],
    stops: [stop('S1', 45), stop('S2', 45.001), stop('S3', 45.001)],
    shapes: [shape],
    routeStops: [rs('S1', 1), rs('S2', 2), rs('S3', 3)],
    trips: [{ trip_id: 'T1', route_id: 'R', service_id: 'WK', direction_id: 0, shape_id: 'SH' } as Trip],
    editingRouteId: 'R',
    selectedRouteId: 'R',
    stopsPanelShapeId: 'SH',
    unitSystem: 'imperial',
  });
}

describe('units preference (#76)', () => {
  beforeEach(() => {
    // Node's own (flag-less, non-functional) localStorage shadows jsdom's, so
    // stub a working one, as the other localStorage tests do.
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => { data.set(k, String(v)); },
      removeItem: (k: string) => { data.delete(k); },
      clear: () => data.clear(),
    });
    seed();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('defaults to imperial when nothing is stored', () => {
    expect(loadUnitSystem()).toBe('imperial');
  });

  it('stop spacing reads in feet, then meters after switching to Metric', async () => {
    const user = userEvent.setup();
    render(<><UnitsToggle /><RouteStopsTab /></>);
    expect(screen.getByText('365 ft')).toBeInTheDocument();
    // Co-located stops show 0, not a stray literal or nothing.
    expect(screen.getByText('0 ft')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Metric' }));
    expect(store().unitSystem).toBe('metric');
    expect(window.localStorage.getItem(UNIT_SYSTEM_STORAGE_KEY)).toBe('metric');
    expect(loadUnitSystem()).toBe('metric');
    expect(screen.getByText('111 m')).toBeInTheDocument();
    expect(screen.getByText('0 m')).toBeInTheDocument();
    expect(screen.queryByText('365 ft')).not.toBeInTheDocument();
  });

  it('shape length follows the preference', async () => {
    const user = userEvent.setup();
    render(<><UnitsToggle /><RouteShapesTab /></>);
    expect(screen.getByText(/6\.9 mi · \d+ mins/)).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Metric' }));
    expect(screen.getByText(/11\.1 km · \d+ mins/)).toBeInTheDocument();
  });
});
