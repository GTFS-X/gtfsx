// @vitest-environment jsdom
// C5-09: an analysis result that arrives after the user switched feeds or
// pressed Clear must be dropped, not painted into the store. The epoch helper
// is pinned in analysisGuards; these drive the three guarded call sites
// (CoveragePanel, AccessIsochronePanel, useWalkshedProfile) with their async
// inputs held open, then resolve them late.
//
// Not covered: TitleVIPanel has no stale-result guard at all (known, left by
// B8); a Title VI run that resolves after a feed switch still renders.
import '../../../test-utils/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { resetStore, store } from '../../../test-utils/store';
import type { Route, RouteStop, Stop } from '../../../types/gtfs';

type Deferred = { resolve: (v: unknown) => void; reject: (e: unknown) => void };
const held = vi.hoisted(() => ({
  census: [] as Deferred[],
  access: [] as Deferred[],
  walkshed: [] as Deferred[],
  blocks: [] as Deferred[],
}));
const hold = (list: Deferred[]) => new Promise((resolve, reject) => { list.push({ resolve, reject }); });

vi.mock('../serviceAreaCensus', () => ({ fetchServiceAreaBlockGroups: () => hold(held.census) }));
vi.mock('../../../services/accessIsochrone/orchestrator', () => ({ runAccessIsochrone: () => hold(held.access) }));
vi.mock('../../../services/walkshedProfile', () => ({ analyzeWalkshedProfiles: () => hold(held.walkshed) }));
vi.mock('../../../services/blockCoverage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/blockCoverage')>()),
  loadBlocksInBbox: () => hold(held.blocks),
}));

import { CoveragePanel } from '../CoveragePanel';
import { AccessIsochronePanel } from '../../analysis/AccessIsochronePanel';
import { useWalkshedProfile } from '../useWalkshedProfile';

const stop: Stop = { stop_id: 'A', stop_name: 'A', stop_lat: 45, stop_lon: -111, location_type: 0 } as Stop;
const route: Route = { route_id: 'R', route_short_name: 'R', route_long_name: 'R', route_type: 3 } as Route;

beforeEach(() => {
  held.census.length = 0;
  held.access.length = 0;
  held.walkshed.length = 0;
  held.blocks.length = 0;
  // Nothing here may reach the network.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline in tests'); }));
  resetStore({
    projectId: 'feed-1',
    stops: [stop],
    routes: [route],
    routeStops: [{ route_id: 'R', stop_id: 'A', direction_id: 0, stop_sequence: 0 } as RouteStop],
    currentUser: { id: 'u1', email: 'u@example.com', plan: 'agency' } as never,
    authChecked: true,
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

const switchFeed = () => act(() => { store().setProjectId('feed-2'); });

describe('CoveragePanel (C5-09)', () => {
  it('drops a coverage result that resolves after a feed switch', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><CoveragePanel /></MemoryRouter>);
    await user.click(screen.getByRole('button', { name: 'Analyze Coverage' }));
    expect(held.census).toHaveLength(1);
    switchFeed();
    await act(async () => { held.census[0].resolve([]); });
    expect(store().coverageData).toBeNull();
    expect(store().coverageError).toBeNull();
  });

  it('drops it when the switch lands during the later block-level fetch', async () => {
    // A US block group (Montana, FIPS 30) sends the run on to the exact-block
    // fetch, so the switch happens after the first await's guard has passed.
    const bg = {
      geoid: '300310001001', population: 1000, households: 400, workers: 500, lat: 45, lon: -111,
      minorityPop: 100, totalRacePop: 1000, lowIncomePop: 200, povertyUniverse: 1000,
      zeroVehicleHouseholds: 20, occupiedHouseholds: 400, seniorPop: 150, youthPop: 200,
    };
    const user = userEvent.setup();
    render(<MemoryRouter><CoveragePanel /></MemoryRouter>);
    await user.click(screen.getByRole('button', { name: 'Analyze Coverage' }));
    await act(async () => { held.census[0].resolve([bg]); });
    await vi.waitFor(() => expect(held.blocks).toHaveLength(1));
    switchFeed();
    await act(async () => { held.blocks[0].resolve([]); });
    expect(store().coverageData).toBeNull();
  });

  it('a current run still lands', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><CoveragePanel /></MemoryRouter>);
    await user.click(screen.getByRole('button', { name: 'Analyze Coverage' }));
    await act(async () => { held.census[0].resolve([]); });
    expect(store().coverageData).not.toBeNull();
  });
});

describe('AccessIsochronePanel (C5-09)', () => {
  const okResult = {
    status: 'ok', origin: { lon: -111, lat: 45 }, rings: [], boardableStopIds: ['A'],
    reachedStopCount: 1, isochroneRequests: 0,
  };

  beforeEach(() => { act(() => store().setAccessOrigin({ lon: -111, lat: 45 })); });

  it('Clear mid-run: the late result does not repaint contours', async () => {
    const user = userEvent.setup();
    render(<AccessIsochronePanel />);
    await user.click(screen.getByRole('button', { name: 'Run analysis' }));
    await vi.waitFor(() => expect(held.census.length + held.access.length).toBeGreaterThan(0));
    if (held.census.length) await act(async () => { held.census[0].resolve([]); });
    await vi.waitFor(() => expect(held.access).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await act(async () => { held.access[0].resolve(okResult); });
    expect(store().accessResult).toBeNull();
  });

  it('a feed switch mid-run drops the result too', async () => {
    const user = userEvent.setup();
    render(<AccessIsochronePanel />);
    await user.click(screen.getByRole('button', { name: 'Run analysis' }));
    if (held.census.length) await act(async () => { held.census[0].resolve([]); });
    await vi.waitFor(() => expect(held.access).toHaveLength(1));
    switchFeed();
    await act(async () => { held.access[0].resolve(okResult); });
    expect(store().accessResult).toBeNull();
  });

  it('a current run still lands', async () => {
    const user = userEvent.setup();
    render(<AccessIsochronePanel />);
    await user.click(screen.getByRole('button', { name: 'Run analysis' }));
    if (held.census.length) await act(async () => { held.census[0].resolve([]); });
    await vi.waitFor(() => expect(held.access).toHaveLength(1));
    await act(async () => { held.access[0].resolve(okResult); });
    expect(store().accessResult).toEqual(okResult);
  });
});

describe('useWalkshedProfile (C5-09)', () => {
  it('drops a profile that resolves after a feed switch, and keeps a current one', async () => {
    const { result } = renderHook(() => useWalkshedProfile());
    act(() => { void result.current.run(); });
    expect(held.walkshed).toHaveLength(1);
    switchFeed();
    await act(async () => { held.walkshed[0].resolve({ stops: {}, routes: {} }); });
    expect(store().walkshedProfiles).toBeNull();

    act(() => { void result.current.run(); });
    await act(async () => { held.walkshed[1].resolve({ stops: {}, routes: {} }); });
    expect(store().walkshedProfiles).toEqual({ stops: {}, routes: {} });
  });
});
