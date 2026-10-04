import { useStore } from '../../store';
import { selectAddStopRoute } from './addStopRoute';

export function MapToolbar() {
  const mapMode = useStore((s) => s.mapMode);

  const handleDrawRoute = () => {
    const state = useStore.getState();
    // Toggle off — clicking Draw Route while already in draw_route mode exits
    // without drawing anything. The typical exit is still draw + double-click;
    // this is the escape hatch when you opened the mode by mistake.
    if (state.mapMode === 'draw_route') {
      window.__cancelDrawRoute?.();
      return;
    }
    // Default to a new route; the draw banner's dropdown can retarget to an
    // existing route. The route is created only when the shape is finished, so
    // cancelling leaves nothing behind.
    state.setDrawingNewRoute(true);
    state.setDrawingRouteId(null);
    window.__drawingDirection = 0;
    state.setMapMode('draw_route');
  };

  const handlePlaceStop = () => {
    const state = useStore.getState();
    // Toggle off — clicking Add Stop while already in place_stop mode exits
    // back to select, so the user has a one-click "I'm done placing" gesture.
    if (state.mapMode === 'place_stop') {
      state.setMapMode('select');
      return;
    }
    // If we're coming from Draw Route, discard the in-progress line and reset
    // the draw control. Otherwise mapbox-gl-draw stays in draw_line_string and
    // keeps capturing clicks, leaving the user effectively still in draw mode.
    if (state.mapMode === 'draw_route') {
      window.__cancelDrawRoute?.();
    }

    // Default the place-stop dialog's "Assign to" target (most recently drawn
    // shape's route, else the selection). Never creates a route.
    selectAddStopRoute();

    state.setSidebarSection('stops');
    state.setMapMode('place_stop');
    // Add Stop has its own on-screen mini-dialog under the banner that
    // handles route assignment, snap toggle, and naming — the side panel
    // would just cover the map. Keep the section "stops" (so when the user
    // does expand the rail later it lands on Stops), but minimize the rail
    // by default at every viewport.
    state.setRightRailOpen(false);
  };

  const handleSelect = () => {
    const state = useStore.getState();
    // Same cleanup as Add Stop — clicking Select while drawing should fully
    // exit draw_route (clear partial line + drawingRouteId), not just toggle
    // the store mode while mapbox-gl-draw keeps eating clicks.
    if (state.mapMode === 'draw_route') {
      window.__cancelDrawRoute?.();
      return;
    }
    state.setMapMode('select');
  };

  const tools = [
    { mode: 'select' as const, icon: '☞', title: 'Select', onClick: handleSelect },
    { mode: 'draw_route' as const, icon: '✎', title: 'Draw Route', onClick: handleDrawRoute },
    { mode: 'place_stop' as const, icon: '●', title: 'Add Stop', onClick: handlePlaceStop },
  ];

  return (
    <div className="absolute top-3 right-3 flex flex-col gap-1 bg-white rounded-xl shadow-md p-1.5 z-10">
      {tools.map(({ mode, icon, title, onClick }) => (
        <button
          key={mode}
          title={title}
          onClick={onClick}
          className={`w-9 h-9 rounded-lg flex items-center justify-center text-base transition-colors
            ${mapMode === mode
              ? 'bg-coral-light text-coral'
              : 'text-brown hover:bg-cream'
            }`}
        >
          {icon}
        </button>
      ))}
    </div>
  );
}
