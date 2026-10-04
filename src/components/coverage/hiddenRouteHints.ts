/**
 * The walkshed profile runs over visible routes only, so a hidden route (or a
 * stop served only by hidden routes) is absent from the result. These helpers
 * let the profile tabs say so instead of "no stops" / "re-run it" (C5-19).
 */
export const HIDDEN_ROUTE_HINT =
  'This route is hidden on the map. Show it to include it in the profile, then re-run.';
export const HIDDEN_STOP_HINT =
  'Every route serving this stop is hidden on the map. Show one to include it in the profile, then re-run.';

export function isRouteHidden(routeId: string, hiddenRouteIds: readonly string[]): boolean {
  return hiddenRouteIds.includes(routeId);
}

/** True when the stop has at least one route and all of them are hidden. */
export function allRoutesServingStopHidden(
  stopId: string,
  routeStops: readonly { stop_id: string; route_id: string }[],
  hiddenRouteIds: readonly string[],
): boolean {
  if (hiddenRouteIds.length === 0) return false;
  const hidden = new Set(hiddenRouteIds);
  let any = false;
  for (const rs of routeStops) {
    if (rs.stop_id !== stopId) continue;
    any = true;
    if (!hidden.has(rs.route_id)) return false;
  }
  return any;
}
