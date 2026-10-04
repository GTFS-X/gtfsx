// @vitest-environment jsdom
// C3-04: a flex zone's route can also run fixed trips (or be shared by several
// zones). Such a "mixed" route is a real route:
//   - renaming the zone in FlexEditor must not rename it (only a flex-ONLY
//     route follows its zone's name), and
//   - RouteList must keep listing it (only flex-only routes are hidden there).
// isFlexOnlyRoute / managedRouteList are pinned in flexZoneRoute and
// routePanelHelpers tests; these pin the two component call sites.
import '../../../test-utils/dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { resetStore, store } from '../../../test-utils/store';
import { historyDepths } from '../../../store/history';
import type { Route, Trip } from '../../../types/gtfs';
import type { FlexZone } from '../../../store/flexSlice';
import { FlexEditor } from '../FlexEditor';
import { RouteList } from '../../routes/RouteList';

const route = (id: string, short: string, long: string, route_type = 3): Route =>
  ({ route_id: id, route_short_name: short, route_long_name: long, route_type }) as Route;
const zone = (id: string, name: string, routeId: string): FlexZone =>
  ({ id, name, routeId, bufferMiles: 0, geojson: { type: 'FeatureCollection', features: [] } }) as FlexZone;

beforeEach(() => {
  resetStore({
    routes: [
      route('MIX', '7', 'Crosstown'),          // fixed trips + a flex zone
      route('FLEX', '', 'North dial-a-ride', 715), // exists only for its zone
      route('PLAIN', '12', 'Main St'),
    ],
    trips: [{ trip_id: 't1', route_id: 'MIX', service_id: 'WK', direction_id: 0 } as Trip],
    flexZones: [zone('z-mix', 'Crosstown deviation', 'MIX'), zone('z-flex', 'North dial-a-ride', 'FLEX')],
  });
});

async function renameZone(user: ReturnType<typeof userEvent.setup>, from: string, to: string) {
  const row = screen.getByText(from).closest('div.group') as HTMLElement;
  await user.click(row.querySelector('button[title="Rename service area"]')!);
  const input = screen.getByDisplayValue(from);
  await user.clear(input);
  await user.type(input, `${to}{Enter}`);
}

describe('FlexEditor zone rename (C3-04)', () => {
  it("renaming a mixed route's zone leaves the route's names alone", async () => {
    const user = userEvent.setup();
    render(<FlexEditor />);
    await renameZone(user, 'Crosstown deviation', 'Airport loop');

    expect(store().flexZones.find((z) => z.id === 'z-mix')!.name).toBe('Airport loop');
    const mix = store().routes.find((r) => r.route_id === 'MIX')!;
    expect([mix.route_short_name, mix.route_long_name]).toEqual(['7', 'Crosstown']);
  });

  it('renaming a flex-only zone renames its route too, in one undo step', async () => {
    const user = userEvent.setup();
    render(<FlexEditor />);
    await renameZone(user, 'North dial-a-ride', 'North flex');

    expect(store().routes.find((r) => r.route_id === 'FLEX')!.route_long_name).toBe('North flex');
    expect(historyDepths().undo).toBe(1);
  });
});

describe('RouteList (C3-04)', () => {
  it('lists the mixed route and hides only the flex-only one', () => {
    render(<RouteList />);
    expect(screen.getByText(/Routes \(2\)/)).toBeInTheDocument();
    // Rows show the short name: "7" (MIX, with its 1 trip) and "12" (PLAIN).
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
  });
});
