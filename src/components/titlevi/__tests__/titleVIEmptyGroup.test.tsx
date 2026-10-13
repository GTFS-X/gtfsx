// @vitest-environment jsdom
// An empty comparison group (here: every block group is at or above the
// regional minority share, so Non-Minority has none) has no average service
// level. Its ratio already reads n/a; its tile showed "0 avg. daily trips",
// which reads as "no service". It must show n/a too.
import '../../../test-utils/dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { resetStore } from '../../../test-utils/store';
import type { Stop, StopTime, Trip } from '../../../types/gtfs';

vi.mock('../../coverage/serviceAreaCensus', () => ({
  fetchServiceAreaBlockGroups: vi.fn(async () => [{
    geoid: '300310001001', population: 1000, households: 400, workers: 500, lat: 45, lon: -111,
    minorityPop: 300, totalRacePop: 1000, lowIncomePop: 200, povertyUniverse: 1000,
    zeroVehicleHouseholds: 20, occupiedHouseholds: 400, seniorPop: 150, youthPop: 200,
  }]),
}));

import { TitleVIPanel } from '../TitleVIPanel';

const stop: Stop = { stop_id: 'A', stop_name: 'A', stop_lat: 45, stop_lon: -111, location_type: 0 } as Stop;
const trip: Trip = { trip_id: 't1', route_id: 'R', service_id: 'WK', direction_id: 0 } as Trip;
const st: StopTime = { trip_id: 't1', stop_id: 'A', stop_sequence: 1, arrival_time: '08:00:00', departure_time: '08:00:00' } as StopTime;

beforeEach(() => {
  resetStore({
    routes: [{ route_id: 'R', route_short_name: 'R', route_long_name: 'R', route_type: 3 }] as never,
    stops: [stop],
    trips: [trip],
    stopTimes: [st],
  });
});

const tile = (label: string) => within(screen.getByText(label, { exact: true }).parentElement!);

describe('Title VI empty group tile', () => {
  it('shows n/a, not 0, for an empty group\'s average daily trips; a populated group keeps its number', async () => {
    render(<TitleVIPanel />);
    await userEvent.click(screen.getByRole('button', { name: /Run Title VI Analysis/ }));
    await screen.findByText('Race / ethnicity');

    // The value printed directly above the "avg. daily trips" caption.
    const tripsValue = (label: string) =>
      tile(label).getByText('avg. daily trips').previousElementSibling!.textContent;
    expect(tripsValue('Non-Minority')).toBe('n/a');
    expect(tripsValue('Minority')).not.toBe('n/a');
    expect(Number(tripsValue('Minority'))).toBeGreaterThan(0);
  });
});
