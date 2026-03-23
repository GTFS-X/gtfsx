import { useMemo } from 'react';
import { Source, Layer } from 'react-map-gl/mapbox';
import { useStore } from '../../store';
import type { LayerProps } from 'react-map-gl/mapbox';

export function StopLayer() {
  const stops = useStore((s) => s.stops);
  const routes = useStore((s) => s.routes);
  const routeStops = useStore((s) => s.routeStops);
  const selectedStopId = useStore((s) => s.selectedStopId);
  const selectedRouteId = useStore((s) => s.selectedRouteId);

  const geojson = useMemo(() => {
    // Build a lookup: stop_id → primary route color
    // Primary = selected route if the stop belongs to it, otherwise first route
    const stopRouteColor = new Map<string, string>();
    const stopRouteCount = new Map<string, number>();

    for (const rs of routeStops) {
      const count = (stopRouteCount.get(rs.stop_id) || 0) + 1;
      stopRouteCount.set(rs.stop_id, count);

      // If this is the selected route, always use its color
      if (rs.route_id === selectedRouteId) {
        const route = routes.find((r) => r.route_id === rs.route_id);
        if (route) stopRouteColor.set(rs.stop_id, `#${route.route_color}`);
      }
      // Otherwise set only if not already set (first route wins)
      if (!stopRouteColor.has(rs.stop_id)) {
        const route = routes.find((r) => r.route_id === rs.route_id);
        if (route) stopRouteColor.set(rs.stop_id, `#${route.route_color}`);
      }
    }

    return {
      type: 'FeatureCollection' as const,
      features: stops.map((stop) => {
        const color = stopRouteColor.get(stop.stop_id) || '#8B7E74'; // warm-gray fallback for unassigned
        const isSelected = stop.stop_id === selectedStopId;
        const numRoutes = stopRouteCount.get(stop.stop_id) || 0;

        return {
          type: 'Feature' as const,
          properties: {
            stop_id: stop.stop_id,
            stop_name: stop.stop_name,
            isSelected,
            color,
            numRoutes,
            isTransfer: numRoutes > 1,
          },
          geometry: {
            type: 'Point' as const,
            coordinates: [stop.stop_lon, stop.stop_lat],
          },
        };
      }),
    };
  }, [stops, routes, routeStops, selectedStopId, selectedRouteId]);

  // Outer ring — route-colored border
  const outerCircle: LayerProps = {
    id: 'stop-circles-outer',
    type: 'circle',
    paint: {
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        10, ['case', ['get', 'isSelected'], 6, 3],
        14, ['case', ['get', 'isSelected'], 10, ['case', ['get', 'isTransfer'], 7, 6]],
      ],
      'circle-color': ['get', 'color'],
      'circle-opacity': [
        'case',
        ['get', 'isSelected'], 1,
        0.9,
      ],
    },
  };

  // Inner fill — white circle (or route-colored when selected)
  const innerCircle: LayerProps = {
    id: 'stop-circles',
    type: 'circle',
    paint: {
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        10, ['case', ['get', 'isSelected'], 3, 1.5],
        14, ['case', ['get', 'isSelected'], 5, ['case', ['get', 'isTransfer'], 4, 3.5]],
      ],
      'circle-color': [
        'case',
        ['get', 'isSelected'], ['get', 'color'],
        '#FFFFFF',
      ],
    },
  };

  // Selected stop — extra white outer ring for emphasis
  const selectionRing: LayerProps = {
    id: 'stop-selection-ring',
    type: 'circle',
    filter: ['==', ['get', 'isSelected'], true],
    paint: {
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        10, 8,
        14, 13,
      ],
      'circle-color': 'transparent',
      'circle-stroke-color': '#FFFFFF',
      'circle-stroke-width': 3,
    },
  };

  // Transfer indicator — small diamond/dot for multi-route stops
  // (the larger size from outerCircle already handles this visually)

  // Labels
  const labelStyle: LayerProps = {
    id: 'stop-labels',
    type: 'symbol',
    minzoom: 13,
    layout: {
      'text-field': ['get', 'stop_name'],
      'text-size': [
        'case',
        ['get', 'isSelected'], 12,
        11,
      ],
      'text-offset': [0, 1.5],
      'text-anchor': 'top',
      'text-max-width': 10,
      'text-font': [
        'case',
        ['get', 'isSelected'],
        ['literal', ['DIN Pro Bold', 'Arial Unicode MS Bold']],
        ['literal', ['DIN Pro Medium', 'Arial Unicode MS Regular']],
      ],
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': [
        'case',
        ['get', 'isSelected'], ['get', 'color'],
        '#3D2E22',
      ],
      'text-halo-color': '#FFFFFF',
      'text-halo-width': 2,
    },
  };

  return (
    <Source id="stops" type="geojson" data={geojson}>
      <Layer {...selectionRing} />
      <Layer {...outerCircle} />
      <Layer {...innerCircle} />
      <Layer {...labelStyle} />
    </Source>
  );
}
