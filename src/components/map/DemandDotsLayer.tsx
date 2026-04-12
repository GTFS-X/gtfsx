import { Source, Layer } from 'react-map-gl/mapbox';
import type { LayerProps } from 'react-map-gl/mapbox';
import mapboxgl from 'mapbox-gl';
import { Protocol } from 'pmtiles';

const TILES_URL = 'pmtiles://https://tiles.gtfsbuilder.net/mt-2026.pmtiles';

// Register the pmtiles:// protocol with Mapbox GL once, at module load.
// Re-adding is a no-op after the first call but we guard anyway.
const mbx = mapboxgl as unknown as {
  addProtocol: (name: string, handler: unknown) => void;
  __pmtilesRegistered?: boolean;
};
if (!mbx.__pmtilesRegistered) {
  mbx.addProtocol('pmtiles', new Protocol().tile);
  mbx.__pmtilesRegistered = true;
}

interface Props {
  visible: boolean;
}

const layerStyle: LayerProps = {
  id: 'demand-dots',
  type: 'circle',
  source: 'demand-dots',
  'source-layer': 'demand',
  paint: {
    'circle-radius': [
      'interpolate', ['linear'], ['zoom'],
      6, 0.3,
      10, 0.8,
      12, 1.25,
      15, 2,
    ],
    'circle-color': [
      'match', ['get', 'class'],
      'high', '#22c55e',
      'jobs', '#f97316',
      'other', '#9ca3af',
      '#9ca3af',
    ],
    'circle-opacity': [
      'interpolate', ['linear'], ['zoom'],
      6, 0.3,
      10, 0.5,
      12, 0.6,
      15, 0.8,
    ],
    'circle-stroke-width': 0,
  },
};

export function DemandDotsLayer({ visible }: Props) {
  if (!visible) return null;
  return (
    <Source id="demand-dots" type="vector" url={TILES_URL}>
      <Layer {...layerStyle} beforeId="stop-circles-outer" />
    </Source>
  );
}
