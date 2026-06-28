import { useMemo } from 'react';
import { Source, Layer, Marker } from 'react-map-gl/mapbox';
import type { Feature } from 'geojson';
import { useStore } from '../../store';
import { accessRingColor } from '../../services/accessIsochrone/colors';

/**
 * Map overlay for the Access Isochrones panel: filled time-budget contours
 * (largest drawn first so smaller rings sit on top) plus a draggable origin pin.
 * Only renders while the Access Isochrones section is active.
 */
export function AccessIsochroneLayer() {
  const sidebarSection = useStore((s) => s.sidebarSection);
  const origin = useStore((s) => s.accessOrigin);
  const result = useStore((s) => s.accessResult);
  const setOrigin = useStore((s) => s.setAccessOrigin);

  const active = sidebarSection === 'access-isochrones';

  const geojson = useMemo(() => {
    if (!active || !result || result.status !== 'ok') return null;
    // Largest budget first → drawn underneath; smaller (closer) rings on top.
    const ordered = result.rings
      .map((ring, i) => ({ ring, color: accessRingColor(i) }))
      .filter((r) => r.ring.polygon)
      .sort((a, b) => b.ring.budgetMin - a.ring.budgetMin);
    const features: Feature[] = ordered.map(({ ring, color }) => ({
      ...(ring.polygon as Feature),
      properties: { color, budget: ring.budgetMin },
    }));
    return { type: 'FeatureCollection' as const, features };
  }, [active, result]);

  if (!active) return null;

  return (
    <>
      {geojson && geojson.features.length > 0 && (
        <Source id="access-isochrone" type="geojson" data={geojson}>
          <Layer
            id="access-isochrone-fill"
            type="fill"
            paint={{ 'fill-color': ['get', 'color'], 'fill-opacity': 0.22 }}
          />
          <Layer
            id="access-isochrone-outline"
            type="line"
            paint={{ 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-opacity': 0.7 }}
          />
        </Source>
      )}
      {origin && (
        <Marker
          longitude={origin.lon}
          latitude={origin.lat}
          draggable
          onDragEnd={(e) => setOrigin({ lon: e.lngLat.lng, lat: e.lngLat.lat })}
          anchor="bottom"
        >
          <div
            title="Trip origin — drag to move"
            className="flex flex-col items-center -mb-1 cursor-grab active:cursor-grabbing"
          >
            <div className="w-4 h-4 rounded-full bg-coral border-2 border-white shadow-md" />
            <div className="w-0.5 h-2 bg-coral" />
          </div>
        </Marker>
      )}
    </>
  );
}
