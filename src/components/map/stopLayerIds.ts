// Source and layer ids rendered by StopLayer, shared with every map module
// that references them (click/drag handlers in MapView, DemandDotsLayer's
// beforeId). A literal id typed in two places drifted once already: the
// cluster click looked up 'stop-cluster' while the source is 'stops-cluster',
// so cluster clicks silently did nothing.

/** Source id in detailed (unclustered) mode. */
export const STOPS_SOURCE_ID = 'stops';
/** Source id in clustered mode (very large feeds). */
export const STOPS_CLUSTER_SOURCE_ID = 'stops-cluster';

export const STOP_SELECTION_RING_LAYER_ID = 'stop-selection-ring';
export const STOP_CIRCLES_OUTER_LAYER_ID = 'stop-circles-outer';
export const STOP_CIRCLES_LAYER_ID = 'stop-circles';
export const STOP_LABELS_LAYER_ID = 'stop-labels';

export const STOP_CLUSTERS_LAYER_ID = 'stop-clusters';
export const STOP_CLUSTER_COUNT_LAYER_ID = 'stop-cluster-count';
export const STOP_CLUSTER_POINTS_LAYER_ID = 'stop-cluster-points';

/** Layer ids StopLayer mounts in each mode, bottom to top. */
export function stopLayerIds(clustered: boolean): string[] {
  return clustered
    ? [STOP_CLUSTERS_LAYER_ID, STOP_CLUSTER_COUNT_LAYER_ID, STOP_CLUSTER_POINTS_LAYER_ID]
    : [STOP_SELECTION_RING_LAYER_ID, STOP_CIRCLES_OUTER_LAYER_ID, STOP_CIRCLES_LAYER_ID, STOP_LABELS_LAYER_ID];
}

/** Layers whose features are individual, draggable stops (either mode). */
export const STOP_POINT_LAYER_IDS = [
  STOP_CIRCLES_LAYER_ID,
  STOP_CIRCLES_OUTER_LAYER_ID,
  STOP_CLUSTER_POINTS_LAYER_ID,
];

/** True when a rendered feature's layer is an individual stop in either mode. */
export function isStopPointLayer(layerId: string | undefined): boolean {
  return layerId === STOP_CIRCLES_LAYER_ID || layerId === STOP_CLUSTER_POINTS_LAYER_ID;
}

/**
 * The layer the demand dots are inserted beneath. It must be one StopLayer has
 * actually mounted: mapbox-gl's addLayer refuses (and logs) when beforeId names
 * a missing layer, so a detailed-mode id on a clustered feed meant the dots
 * never rendered at all.
 */
export function demandDotsBeforeId(clustered: boolean): string {
  return clustered ? STOP_CLUSTERS_LAYER_ID : STOP_CIRCLES_OUTER_LAYER_ID;
}

/** Only the ids the map currently has; queryRenderedFeatures returns [] (and
 *  fires an error) if any requested layer is missing. */
export function existingLayerIds(
  map: { getLayer: (id: string) => unknown },
  ids: readonly string[],
): string[] {
  return ids.filter((id) => !!map.getLayer(id));
}
