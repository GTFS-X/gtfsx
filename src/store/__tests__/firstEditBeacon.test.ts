// `feed_edited` — the "did they edit anything, or just look?" signal.
//
// history.recordChange is the single choke point every undoable feed mutation
// passes through, so it's where the beacon hangs. These tests pin the two
// properties that make it trustworthy: a real edit reports the entity it
// touched, and a bulk feed LOAD (import / demo / project open, all of which run
// inside loadingFeed) is never mistaken for one.
//
// The once-per-session dedupe lives inside trackBeacon and is covered by
// src/services/__tests__/trackBeaconFunnel.test.ts; here the beacon is mocked,
// so every qualifying mutation shows up.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../index';
import { loadingFeed, resetHistory } from '../history';
import { trackFirstFeedEdit } from '../../services/trackBeacon';
import type { Stop } from '../../types/gtfs';
import type { Route } from '../../types/gtfs';

vi.mock('../../services/trackBeacon', () => ({
  trackFirstFeedEdit: vi.fn(),
}));

const edits = vi.mocked(trackFirstFeedEdit);

function stop(id: string): Stop {
  return {
    stop_id: id, stop_name: id, stop_lat: 45, stop_lon: -111,
    location_type: 0, wheelchair_boarding: 0,
  };
}

function route(id: string): Route {
  return { route_id: id, route_short_name: id, route_long_name: id, route_type: 3 } as Route;
}

beforeEach(() => {
  loadingFeed(() => {
    useStore.getState().setStops([]);
    useStore.getState().setRoutes([]);
    useStore.getState().setTrips([]);
  });
  resetHistory();
  edits.mockClear();
});

describe('feed_edited beacon', () => {
  it('fires on a real mutation, labelled with the entity that changed', () => {
    useStore.getState().addStop(stop('a'));
    expect(edits).toHaveBeenCalledTimes(1);
    expect(edits).toHaveBeenCalledWith('stops');
  });

  it('reports the primary entity when one edit cascades across keys', () => {
    // A route add is a route edit even though the store touches more than
    // `routes` — primaryKey() picks the same key the undo label uses.
    useStore.getState().addRoute(route('r1'));
    expect(edits).toHaveBeenCalledWith('routes');
  });

  it('does NOT fire for a bulk feed load (import / demo / open project)', () => {
    // Every "load a different feed" path funnels through loadingFeed(), which
    // suppresses history capture. If this ever regressed, an ad click that
    // merely loaded /demo would look like an engaged editing session.
    loadingFeed(() => {
      useStore.getState().setStops([stop('x'), stop('y')]);
      useStore.getState().setRoutes([route('r9')]);
    });
    expect(edits).not.toHaveBeenCalled();
  });

  it('fires on the first genuine edit AFTER a feed load', () => {
    loadingFeed(() => useStore.getState().setStops([stop('x')]));
    expect(edits).not.toHaveBeenCalled();
    useStore.getState().addStop(stop('y'));
    expect(edits).toHaveBeenCalledTimes(1);
    expect(edits).toHaveBeenCalledWith('stops');
  });

  it('does NOT fire for non-feed state (project metadata, UI, selection)', () => {
    useStore.getState().setProjectName('Renamed Feed');
    useStore.getState().markDirty();
    expect(edits).not.toHaveBeenCalled();
  });

  it('sends no value, id, or name — only the top-level store key', () => {
    useStore.getState().addStop(stop('sensitive-stop-name'));
    for (const [arg] of edits.mock.calls) {
      expect(arg).toBe('stops');
    }
  });
});
