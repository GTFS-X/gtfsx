// @vitest-environment jsdom
// C5-09 gap: the analysis stale-result guard keyed on the project id only. An
// anonymous replace-import loads a different feed under the SAME project id,
// so a run started on the old feed still landed on the new one, and Title VI
// kept showing the old feed's result or error. The guard now also keys on the
// store's feed-load counter, bumped by every loadingFeed() path.
//
// Each case starts a run on feed A, replace-imports feed B through the real
// import path (loadImportIntoStore) without changing the project id, then
// lets the old run finish late. The Census / routing / walkshed services are
// held open; nothing else is mocked.
import '../../../test-utils/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { resetStore, store } from '../../../test-utils/store';
import { loadImportIntoStore } from '../../../services/gtfsImport';
import type { Route, RouteStop, Stop } from '../../../types/gtfs';

type Deferred = { resolve: (v: unknown) => void; reject: (e: unknown) => void };
const held = vi.hoisted(() => ({
  census: [] as Deferred[],
  access: [] as Deferred[],
  walkshed: [] as Deferred[],
}));
const hold = (list: Deferred[]) => new Promise((resolve, reject) => { list.push({ resolve, reject }); });

vi.mock('../serviceAreaCensus', () => ({ fetchServiceAreaBlockGroups: () => hold(held.census) }));
vi.mock('../../../services/accessIsochrone/orchestrator', () => ({ runAccessIsochrone: () => hold(held.access) }));
vi.mock('../../../services/walkshedProfile', () => ({ analyzeWalkshedProfiles: () => hold(held.walkshed) }));

import { CoveragePanel } from '../CoveragePanel';
import { AccessIsochronePanel } from '../../analysis/AccessIsochronePanel';
import { useWalkshedProfile } from '../useWalkshedProfile';
import { TitleVIPanel } from '../../titlevi/TitleVIPanel';

const stop = (id: string, lat: number): Stop =>
  ({ stop_id: id, stop_name: id, stop_lat: lat, stop_lon: -111, location_type: 0 }) as Stop;
const route: Route = { route_id: 'R', route_short_name: 'R', route_long_name: 'R', route_type: 3 } as Route;
const rs = (stop_id: string): RouteStop => ({ route_id: 'R', stop_id, direction_id: 0, stop_sequence: 0 } as RouteStop);

/** Replace-import a different feed (B) the way the Import dialog does for an
 *  anonymous draft: same project id, new contents. */
function replaceImportFeedB() {
  const empty = [] as never[];
  act(() => {
    loadImportIntoStore({
      agencies: empty, calendars: empty, calendarDates: empty, shapes: empty, trips: empty,
      stopTimes: empty, feedInfo: null, fareAttributes: empty, fareRules: empty, transfers: empty,
      frequencies: empty, levels: empty, pathways: empty, fareAreas: empty, stopAreas: empty,
      fareNetworks: empty, routeNetworks: empty, timeframes: empty, riderCategories: empty,
      fareMedia: empty, fareProducts: empty, fareLegRules: empty, fareTransferRules: empty,
      flexZones: empty, translations: empty,
      routes: [route], stops: [stop('B1', 46)], routeStops: [rs('B1')],
    } as never);
  });
  expect(store().projectId).toBe('feed-1');
  expect(store().stops.map((s) => s.stop_id)).toEqual(['B1']);
}

beforeEach(() => {
  held.census.length = 0;
  held.access.length = 0;
  held.walkshed.length = 0;
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline in tests'); }));
  resetStore({
    projectId: 'feed-1',
    stops: [stop('A1', 45)],
    routes: [route],
    routeStops: [rs('A1')],
    currentUser: { id: 'u1', email: 'u@example.com', plan: 'agency' } as never,
    authChecked: true,
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('analysis results do not survive a same-project replace-import (C5-09)', () => {
  it('Coverage: a late result or error from the old feed is dropped, and the spinner ends', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><CoveragePanel /></MemoryRouter>);
    await user.click(screen.getByRole('button', { name: 'Analyze Coverage' }));
    expect(store().isFetchingCoverage).toBe(true);
    replaceImportFeedB();
    expect(store().isFetchingCoverage).toBe(false);
    await act(async () => { held.census[0].reject(new Error('Census timeout for feed A')); });
    expect(store().coverageError).toBeNull();
    expect(screen.queryByText(/Census timeout for feed A/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Analyze Coverage' }));
    replaceImportFeedB();
    await act(async () => { held.census[1].resolve([]); });
    expect(store().coverageData).toBeNull();
  });

  it('Coverage: a run on the new feed still lands', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><CoveragePanel /></MemoryRouter>);
    replaceImportFeedB();
    await user.click(screen.getByRole('button', { name: 'Analyze Coverage' }));
    await act(async () => { held.census[0].resolve([]); });
    expect(store().coverageData).not.toBeNull();
  });

  it('Access isochrone: a late result from the old feed is dropped', async () => {
    act(() => store().setAccessOrigin({ lon: -111, lat: 45 }));
    const user = userEvent.setup();
    render(<AccessIsochronePanel />);
    await user.click(screen.getByRole('button', { name: 'Run analysis' }));
    if (held.census.length) await act(async () => { held.census[0].resolve([]); });
    await vi.waitFor(() => expect(held.access).toHaveLength(1));
    replaceImportFeedB();
    await act(async () => {
      held.access[0].resolve({
        status: 'ok', origin: { lon: -111, lat: 45 }, rings: [], boardableStopIds: ['A1'],
        reachedStopCount: 1, isochroneRequests: 0,
      });
    });
    expect(store().accessResult).toBeNull();
    expect(store().accessRunning).toBe(false);
  });

  it('Walkshed profiles: a late profile from the old feed is dropped', async () => {
    const { result } = renderHook(() => useWalkshedProfile());
    act(() => { void result.current.run(); });
    expect(held.walkshed).toHaveLength(1);
    replaceImportFeedB();
    await act(async () => { held.walkshed[0].resolve({ stops: { A1: {} }, routes: {} }); });
    expect(store().walkshedProfiles).toBeNull();
    expect(store().isProfilingWalksheds).toBe(false);
  });

  it('Title VI: the shown error is cleared, and a late old-feed error is not shown', async () => {
    const user = userEvent.setup();
    render(<TitleVIPanel />);
    await user.click(screen.getByRole('button', { name: /Run Title VI Analysis/ }));
    await act(async () => { held.census[0].reject(new Error('Census failed for feed A')); });
    expect(screen.getByText('Census failed for feed A')).toBeInTheDocument();
    replaceImportFeedB();
    expect(screen.queryByText('Census failed for feed A')).not.toBeInTheDocument();

    // In flight across the replace: the late error must not appear either.
    await user.click(screen.getByRole('button', { name: /Run Title VI Analysis/ }));
    replaceImportFeedB();
    await act(async () => { held.census[1].reject(new Error('Late error from feed A')); });
    expect(screen.queryByText('Late error from feed A')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Run Title VI Analysis/ })).toBeEnabled();
  });

  it('Title VI: a late old-feed result is not shown', async () => {
    const user = userEvent.setup();
    render(<TitleVIPanel />);
    await user.click(screen.getByRole('button', { name: /Run Title VI Analysis/ }));
    replaceImportFeedB();
    await act(async () => { held.census[0].resolve([]); });
    expect(screen.queryByText('Race / ethnicity')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Run Title VI Analysis/ })).toBeEnabled();
  });
});
