import { useMemo } from 'react';
import { Source, Layer } from 'react-map-gl/mapbox';
import { featureCollection } from '@turf/helpers';
import { useStore } from '../../store';

const DEFAULT_FLEX_COLOR = '#7C3AED';

function resolveFlexColor(routeColor?: string): string {
  if (!routeColor) return DEFAULT_FLEX_COLOR;
  const hex = routeColor.startsWith('#') ? routeColor : `#${routeColor}`;
  return /^#[0-9A-F]{6}$/i.test(hex) ? hex : DEFAULT_FLEX_COLOR;
}

export function FlexLayer() {
  const flexZones = useStore((s) => s.flexZones);
  const routes = useStore((s) => s.routes);
  const editingFlexZoneId = useStore((s) => s.editingFlexZoneId);
  const hiddenRouteIds = useStore((s) => s.hiddenRouteIds);

  const combinedGeojson = useMemo(() => {
    // Exclude the zone currently being edited in draw (draw renders it instead)
    // and any zone tied to a route that's been hidden via the routes pane.
    const hiddenSet = new Set(hiddenRouteIds);
    const zones = flexZones.filter(
      (z) => z.id !== editingFlexZoneId && !(z.routeId && hiddenSet.has(z.routeId)),
    );
    if (zones.length === 0) return featureCollection([]) as GeoJSON.FeatureCollection;
    const routesById = new Map(routes.map((r) => [r.route_id, r]));
    const allFeatures = zones.flatMap((z) => {
      const route = z.routeId ? routesById.get(z.routeId) : undefined;
      const color = resolveFlexColor(route?.route_color);
      return z.geojson.features.map((f) => ({
        ...f,
        properties: {
          ...f.properties,
          zoneId: z.id,
          zoneName: z.name,
          color,
        },
      }));
    });
    return featureCollection(allFeatures) as GeoJSON.FeatureCollection;
  }, [flexZones, editingFlexZoneId, routes, hiddenRouteIds]);

  if (flexZones.length === 0) return null;

  return (
    <Source id="flex-zones" type="geojson" data={combinedGeojson}>
      <Layer
        id="flex-zone-fill"
        type="fill"
        paint={{
          'fill-color': ['coalesce', ['get', 'color'], DEFAULT_FLEX_COLOR],
          'fill-opacity': 0.12,
        }}
      />
      <Layer
        id="flex-zone-outline"
        type="line"
        paint={{
          'line-color': ['coalesce', ['get', 'color'], DEFAULT_FLEX_COLOR],
          'line-width': 2,
          'line-dasharray': [4, 3],
          'line-opacity': 0.7,
        }}
      />
    </Source>
  );
}
