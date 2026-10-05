// @vitest-environment jsdom
// Routes panel "Hide all" / "Show all" must act on every route the panel
// shows, including the flex-only routes listed in its Flex section. Those are
// kept out of the fixed-route list (managedRouteList), but their swatches and
// the map's FlexLayer read the same hiddenRouteIds, so "Hide all" hiding only
// the fixed routes left the flex zones on the map, and replaced the hidden set
// so a flex zone that was already hidden came back.
import '../../../test-utils/dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { resetStore, store } from '../../../test-utils/store';
import type { Route, Trip } from '../../../types/gtfs';
import type { FlexZone } from '../../../store/flexSlice';
import { RouteList } from '../RouteList';

const route = (route_id: string, name: string, route_type = 3): Route =>
  ({ route_id, route_short_name: name, route_long_name: '', route_type, route_color: '336699' }) as Route;
const zone = (id: string, routeId: string, name: string): FlexZone =>
  ({ id, name, bufferMiles: 0.5, routeId, geojson: { type: 'FeatureCollection', features: [] } }) as unknown as FlexZone;

function seed(hiddenRouteIds: string[] = []) {
  resetStore({
    routes: [route('A', 'Blue'), route('B', 'Gold'), route('F1', 'Paratransit', 715), route('F2', 'Microtransit', 715)],
    trips: [
      { trip_id: 'TA', route_id: 'A', service_id: 'WK' } as Trip,
      { trip_id: 'TB', route_id: 'B', service_id: 'WK' } as Trip,
    ],
    flexZones: [zone('z1', 'F1', 'Paratransit'), zone('z2', 'F2', 'Microtransit')],
    hiddenRouteIds,
  });
}

const swatches = (title: string) => document.querySelectorAll(`button[title="${title}"]`);

describe('RouteList bulk visibility', () => {
  beforeEach(() => seed());

  it('Hide all hides fixed and flex-only routes, and Show all restores them', async () => {
    render(<RouteList />);
    // 2 fixed rows + 2 Flex-section rows, all visible.
    expect(swatches('Hide from map')).toHaveLength(4);

    await userEvent.click(screen.getByRole('button', { name: /hide all/i }));
    expect(swatches('Hide from map')).toHaveLength(0);
    expect(swatches('Show on map')).toHaveLength(4);
    expect([...store().hiddenRouteIds].sort()).toEqual(['A', 'B', 'F1', 'F2']);

    await userEvent.click(screen.getByRole('button', { name: /show all/i }));
    expect(swatches('Show on map')).toHaveLength(0);
    expect(store().hiddenRouteIds).toEqual([]);
  });

  it('Hide all keeps an already-hidden flex zone hidden', async () => {
    seed(['F1']);
    render(<RouteList />);
    await userEvent.click(screen.getByRole('button', { name: /hide all/i }));
    expect(store().hiddenRouteIds).toContain('F1');
    expect(swatches('Hide from map')).toHaveLength(0);
  });
});
