import { useEffect, useRef } from 'react';
import { useControl } from 'react-map-gl/mapbox';
import MapboxDraw from '@mapbox/mapbox-gl-draw';

// @ts-ignore - mapbox-gl-draw CSS
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';

interface DrawControlProps {
  onCreate?: (e: any) => void;
  onUpdate?: (e: any) => void;
  onDelete?: (e: any) => void;
  drawRef?: import('react').MutableRefObject<MapboxDraw | null>;
}

// Custom direct_select mode that prevents dragging the entire feature
const DirectSelectNoDrag = {
  ...(MapboxDraw as any).modes.direct_select,
  dragFeature() {
    // no-op: prevent dragging the entire route/shape
  },
};

export function DrawControl({ onCreate, onUpdate, onDelete, drawRef }: DrawControlProps) {
  // Use refs to always have the latest callbacks without re-registering listeners
  const onCreateRef = useRef(onCreate);
  const onUpdateRef = useRef(onUpdate);
  const onDeleteRef = useRef(onDelete);

  useEffect(() => { onCreateRef.current = onCreate; }, [onCreate]);
  useEffect(() => { onUpdateRef.current = onUpdate; }, [onUpdate]);
  useEffect(() => { onDeleteRef.current = onDelete; }, [onDelete]);

  const draw = useControl<MapboxDraw>(
    () => {
      const d = new MapboxDraw({
        displayControlsDefault: false,
        controls: {},
        defaultMode: 'simple_select',
        modes: {
          ...(MapboxDraw as any).modes,
          direct_select: DirectSelectNoDrag,
        },
        styles: [
          // Line being drawn/edited
          {
            id: 'gl-draw-line',
            type: 'line',
            filter: ['all', ['==', '$type', 'LineString'], ['!=', 'mode', 'static']],
            paint: {
              'line-color': '#E8734A',
              'line-width': 4,
              'line-dasharray': [2, 1],
            },
          },
          // Active (selected) vertices — larger with highlight ring
          {
            id: 'gl-draw-point-active',
            type: 'circle',
            filter: ['all', ['==', '$type', 'Point'], ['==', 'meta', 'vertex'], ['==', 'active', 'true']],
            paint: {
              'circle-radius': 9,
              'circle-color': '#E8734A',
              'circle-stroke-color': '#FFFFFF',
              'circle-stroke-width': 3,
            },
          },
          // Inactive vertices — smaller white circles with colored border
          {
            id: 'gl-draw-point',
            type: 'circle',
            filter: ['all', ['==', '$type', 'Point'], ['==', 'meta', 'vertex'], ['!=', 'active', 'true']],
            paint: {
              'circle-radius': 5,
              'circle-color': '#FFFFFF',
              'circle-stroke-color': '#E8734A',
              'circle-stroke-width': 2,
            },
          },
          // Midpoints — clickable add-vertex indicators
          {
            id: 'gl-draw-midpoint',
            type: 'circle',
            filter: ['all', ['==', '$type', 'Point'], ['==', 'meta', 'midpoint']],
            paint: {
              'circle-radius': 5,
              'circle-color': '#E8734A',
              'circle-opacity': 0.7,
              'circle-stroke-color': '#FFFFFF',
              'circle-stroke-width': 1.5,
            },
          },
          {
            id: 'gl-draw-polygon-fill',
            type: 'fill',
            filter: ['all', ['==', '$type', 'Polygon']],
            paint: {
              'fill-color': '#7B68EE',
              'fill-opacity': 0.15,
            },
          },
          {
            id: 'gl-draw-polygon-stroke',
            type: 'line',
            filter: ['all', ['==', '$type', 'Polygon']],
            paint: {
              'line-color': '#7B68EE',
              'line-width': 2,
              'line-dasharray': [3, 2],
            },
          },
        ],
      });
      return d;
    },
    ({ map }) => {
      // map.off(type) silently no-ops without a listener reference, so we hold
      // onto the wrappers and hand them back in the cleanup. Otherwise React
      // StrictMode's mount/unmount/mount cycle leaves an old listener behind
      // and every draw.create fires twice.
      const onCreate = (e: unknown) => onCreateRef.current?.(e);
      const onUpdate = (e: unknown) => onUpdateRef.current?.(e);
      const onDelete = (e: unknown) => onDeleteRef.current?.(e);
      (map as any).__gbDrawListeners = { onCreate, onUpdate, onDelete };
      map.on('draw.create', onCreate);
      map.on('draw.update', onUpdate);
      map.on('draw.delete', onDelete);
    },
    ({ map }: { map: any }) => {
      const listeners = map.__gbDrawListeners;
      if (listeners) {
        map.off('draw.create', listeners.onCreate);
        map.off('draw.update', listeners.onUpdate);
        map.off('draw.delete', listeners.onDelete);
        delete map.__gbDrawListeners;
      }
    },
  );

  useEffect(() => {
    if (drawRef) drawRef.current = draw;
  }, [draw, drawRef]);

  return null;
}
