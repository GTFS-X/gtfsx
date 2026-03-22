import type { StateCreator } from 'zustand';
import type { Route, RouteStop } from '../types/gtfs';

export interface RouteSlice {
  routes: Route[];
  routeStops: RouteStop[];
  addRoute: (route: Route) => void;
  updateRoute: (route_id: string, updates: Partial<Route>) => void;
  removeRoute: (route_id: string) => void;
  setRoutes: (routes: Route[]) => void;
  addRouteStop: (rs: RouteStop) => void;
  removeRouteStop: (route_id: string, stop_id: string, direction_id: 0 | 1) => void;
  reorderRouteStops: (route_id: string, direction_id: 0 | 1, stopIds: string[]) => void;
  setRouteStops: (routeStops: RouteStop[]) => void;
}

export const createRouteSlice: StateCreator<RouteSlice, [['zustand/immer', never]], [], RouteSlice> = (set) => ({
  routes: [],
  routeStops: [],
  addRoute: (route) => set((state) => { state.routes.push(route); }),
  updateRoute: (route_id, updates) => set((state) => {
    const idx = state.routes.findIndex((r) => r.route_id === route_id);
    if (idx !== -1) Object.assign(state.routes[idx], updates);
  }),
  removeRoute: (route_id) => set((state) => {
    state.routes = state.routes.filter((r) => r.route_id !== route_id);
    state.routeStops = state.routeStops.filter((rs) => rs.route_id !== route_id);
  }),
  setRoutes: (routes) => set((state) => { state.routes = routes; }),
  addRouteStop: (rs) => set((state) => { state.routeStops.push(rs); }),
  removeRouteStop: (route_id, stop_id, direction_id) => set((state) => {
    state.routeStops = state.routeStops.filter(
      (rs) => !(rs.route_id === route_id && rs.stop_id === stop_id && rs.direction_id === direction_id)
    );
  }),
  reorderRouteStops: (route_id, direction_id, stopIds) => set((state) => {
    const others = state.routeStops.filter(
      (rs) => rs.route_id !== route_id || rs.direction_id !== direction_id
    );
    const reordered = stopIds.map((sid, i) => {
      const existing = state.routeStops.find(
        (rs) => rs.route_id === route_id && rs.stop_id === sid && rs.direction_id === direction_id
      );
      return { ...(existing || { route_id, stop_id: sid, direction_id, _snapped: true }), stop_sequence: i };
    });
    state.routeStops = [...others, ...reordered];
  }),
  setRouteStops: (routeStops) => set((state) => { state.routeStops = routeStops; }),
});
