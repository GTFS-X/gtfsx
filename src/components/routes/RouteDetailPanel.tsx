import { useEffect, useRef } from 'react';
import { useStore } from '../../store';
import { RouteEditor } from './RouteEditor';
import { RouteStopsTab } from './RouteStopsTab';
import { RouteTripsTab } from './RouteTripsTab';
import { RouteShapesTab } from './RouteShapesTab';
import { RouteCostsTab } from './RouteCostsTab';
import { RouteWalkshedProfileTab } from '../coverage/WalkshedProfilePanel';
import type { RouteDetailTab } from '../../types/ui';
import { planRouteFit, type Bounds } from './routePanelHelpers';

/** Fit the map to whatever is most relevant for the current tab, once per
 *  (route, tab). Data edits made while the panel is open (dragging a shape
 *  vertex, moving a stop) don't re-fit; see planRouteFit. */
function useFocusRouteOnMap(routeId: string | null, tab: RouteDetailTab) {
  const shapes = useStore((s) => s.shapes);
  const trips = useStore((s) => s.trips);
  const stops = useStore((s) => s.stops);
  const routeStops = useStore((s) => s.routeStops);
  const lastFitKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!routeId) {
      lastFitKeyRef.current = null;
      return;
    }
    // RoutePopup's "Edit Shape" handoff sets this flag on window before any
    // state mutation. Honor it as a one-shot: skip this fit, then clear so
    // the next ordinary tab/route change still auto-fits. Avoids the store
    // race (RouteShapesTab clears pendingShapeEditId before this effect
    // reads it).
    const suppress = !!window.__suppressNextRouteFit;
    if (suppress) window.__suppressNextRouteFit = false;
    const fitBounds = (window as { __mapFitBounds?: (b: Bounds, opts?: { padding?: number; maxZoom?: number }) => void })
      .__mapFitBounds;
    if (!fitBounds) return;
    const plan = planRouteFit(lastFitKeyRef.current, routeId, tab, { shapes, trips, stops, routeStops }, suppress);
    lastFitKeyRef.current = plan.key;
    if (plan.bounds) fitBounds(plan.bounds, { padding: 80, maxZoom: 14 });
  }, [routeId, tab, shapes, trips, stops, routeStops]);
}

export function RouteDetailPanel() {
  const tab = useStore((s) => s.routeDetailTab);
  const editingRouteId = useStore((s) => s.editingRouteId);
  useFocusRouteOnMap(editingRouteId, tab);

  switch (tab) {
    case 'details':
      return <RouteEditor />;
    case 'stops':
      return <RouteStopsTab />;
    case 'trips':
      return <RouteTripsTab />;
    case 'shapes':
      return <RouteShapesTab />;
    case 'costs':
      return <RouteCostsTab />;
    case 'coverage':
      return <RouteWalkshedProfileTab />;
    default:
      return <RouteEditor />;
  }
}
