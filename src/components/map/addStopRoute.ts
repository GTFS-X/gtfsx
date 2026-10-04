import { useStore } from '../../store';

/**
 * Pick the route the Add Stop tool assigns new stops to, before entering
 * place_stop mode. Never creates a route: the place-stop dialog offers
 * "(No route — freehand)", and a route minted here (the old behavior on feeds
 * with no shapes) was left behind blank and nameless even when the user
 * cancelled without placing anything.
 *
 * - Nothing selected and the feed has shapes: the most recently drawn shape's
 *   route (via its trip, else its draft `_route_id`) and direction.
 * - A valid route is selected: keep it.
 * - Exactly one route: select it.
 * - Otherwise: leave the selection empty.
 */
export function selectAddStopRoute(): void {
  const state = useStore.getState();
  if (!state.selectedRouteId && state.shapes.length > 0) {
    const latestShape = state.shapes[state.shapes.length - 1];
    const trip = state.trips.find((t) => t.shape_id === latestShape.shape_id);
    // A freshly drawn shape has no trip yet — fall back to its draft route
    // association so Add Stop still defaults to the route just drawn.
    const routeId = trip?.route_id ?? latestShape._route_id;
    if (routeId) {
      state.selectRoute(routeId);
      state.setStopPlacementDirection(trip?.direction_id ?? 0);
    }
    return;
  }
  if (state.selectedRouteId && state.routes.some((r) => r.route_id === state.selectedRouteId)) return;
  if (state.routes.length === 1) {
    state.selectRoute(state.routes[0].route_id);
    return;
  }
  // A stale selection (route deleted) is cleared rather than kept dangling.
  if (state.selectedRouteId) state.selectRoute(null);
}
