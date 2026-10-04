import type { Stop } from '../../types/gtfs';

export interface EndpointOption {
  value: string;
  label: string;
}

/** GTFS pathways connect platforms, entrances, generic nodes and boarding areas;
 *  a station (location_type 1) can't be a pathway endpoint. */
export function isPathwayEndpoint(stop: Stop): boolean {
  return (stop.location_type ?? 0) !== 1;
}

/** Eligible pathway endpoints, sorted by name. */
export function pathwayEndpoints(stops: readonly Stop[]): Stop[] {
  return stops
    .filter(isPathwayEndpoint)
    .sort((a, b) => (a.stop_name || '').localeCompare(b.stop_name || ''));
}

/**
 * Options for one endpoint select. A row that already points at a station (an
 * imported feed) keeps that value listed, flagged, so the select still shows
 * what the data says instead of silently displaying another stop.
 */
export function endpointOptions(
  eligible: readonly Stop[],
  allStops: readonly Stop[],
  current: string,
): EndpointOption[] {
  const opts = eligible.map((s) => ({ value: s.stop_id, label: s.stop_name || s.stop_id }));
  if (current && !eligible.some((s) => s.stop_id === current)) {
    const cur = allStops.find((s) => s.stop_id === current);
    const name = cur?.stop_name || current;
    opts.unshift({
      value: current,
      label: cur && !isPathwayEndpoint(cur) ? `${name} (station — not allowed)` : name,
    });
  }
  return opts;
}
