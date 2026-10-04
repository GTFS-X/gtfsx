import { useCallback } from 'react';
import { useStore } from '../../store';
import { useVisibleFeed } from '../../hooks/useVisibleFeed';
import { analyzeWalkshedProfiles } from '../../services/walkshedProfile';
import { beginAnalysis } from './analysisEpoch';

/**
 * Shared entry point for the walkshed demographic profile.
 *
 * ONE run covers the whole feed: it fetches the census-block layer a single
 * time for the feed's bounding box and tabulates every stop and every route
 * against the in-memory blocks. The stop sub-panel and the route sub-panel both
 * read the same result out of the store — neither of them fetches anything.
 *
 * The run is explicit (a button), never fired from a render/useMemo, matching
 * the Coverage panel's `data | isFetching | error` pattern.
 *
 * Scoped to the routes toggled visible on the map, like every other analysis
 * panel.
 */
export function useWalkshedProfile() {
  const { stops, routes, routeStops, visibleRouteCount, totalRouteCount } = useVisibleFeed();

  const profiles = useStore((s) => s.walkshedProfiles);
  const isFetching = useStore((s) => s.isProfilingWalksheds);
  const error = useStore((s) => s.walkshedProfileError);
  const setProfiles = useStore((s) => s.setWalkshedProfiles);
  const setIsFetching = useStore((s) => s.setIsProfilingWalksheds);
  const setError = useStore((s) => s.setWalkshedProfileError);

  const run = useCallback(async () => {
    if (stops.length === 0) return;
    const isCurrent = beginAnalysis('walkshed');
    setIsFetching(true);
    setError(null);
    try {
      const result = await analyzeWalkshedProfiles({ stops, routes, routeStops });
      // Dropped when the user switched feeds (or re-ran) while this was in flight.
      if (!isCurrent()) return;
      setProfiles(result);
    } catch (err) {
      if (!isCurrent()) return;
      setProfiles(null);
      setError(
        err instanceof Error
          ? err.message
          : 'Could not load the census-block layer for this feed.',
      );
    } finally {
      if (isCurrent()) setIsFetching(false);
    }
  }, [stops, routes, routeStops, setProfiles, setIsFetching, setError]);

  return {
    profiles,
    isFetching,
    error,
    run,
    stops,
    routes,
    routeStops,
    visibleRouteCount,
    totalRouteCount,
  };
}
