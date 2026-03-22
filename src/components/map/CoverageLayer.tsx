import { useMemo } from 'react';
import { Source, Layer } from 'react-map-gl/mapbox';
import { useStore } from '../../store';

export function CoverageLayer() {
  const sidebarSection = useStore((s) => s.sidebarSection);
  const coverageData = useStore((s) => s.coverageData);

  const geojson = useMemo(() => {
    if (sidebarSection !== 'coverage' || !coverageData) return null;
    return coverageData.bufferGeoJSON;
  }, [sidebarSection, coverageData]);

  if (!geojson) return null;

  return (
    <Source id="coverage-buffer" type="geojson" data={geojson}>
      <Layer
        id="coverage-buffer-fill"
        type="fill"
        paint={{
          'fill-color': ['get', 'route_color'],
          'fill-opacity': 0.15,
        }}
      />
      <Layer
        id="coverage-buffer-outline"
        type="line"
        paint={{
          'line-color': ['get', 'route_color'],
          'line-width': 1.5,
          'line-opacity': 0.4,
        }}
      />
    </Source>
  );
}
