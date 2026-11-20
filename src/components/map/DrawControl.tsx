import { useEffect, useRef } from 'react';
import { useControl } from 'react-map-gl/mapbox';
import MapboxDraw, { type DrawEvent } from '@mapbox/mapbox-gl-draw';

import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import { ShapeEditMode, SHAPE_EDIT_MODE } from './shapeEditMode';

interface DrawControlProps {
  onCreate?: (e: DrawEvent) => void;
  onUpdate?: (e: DrawEvent) => void;
  onDelete?: (e: DrawEvent) => void;
  drawRef?: import('react').MutableRefObject<MapboxDraw | null>;
}

// Custom direct_select mode that prevents dragging the entire feature (used
// for flex-zone polygons). The mode object is opaque — we spread it and
// override one method, which is the pattern Draw expects.
const DirectSelectNoDrag = {
  ...MapboxDraw.modes.direct_select,
  dragFeature() {
    // no-op: prevent dragging the entire zone
  },
};

// Sentinel property attached to the map for listener cleanup across
// StrictMode remounts. Defined structurally so it works on any map ref
// shape react-map-gl might hand back.
interface DrawListenerHolder {
  __gbDrawListeners?: {
    onCreate: (e: unknown) => void;
    onUpdate: (e: unknown) => void;
    onDelete: (e: unknown) => void;
  };
}

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
          ...MapboxDraw.modes,
          direct_select: DirectSelectNoDrag,
          // Shapes (LineStrings) edit in their own mode: range selection,
          // select-priority hit testing, Redraw segment. See shapeEditMode.ts.
          [SHAPE_EDIT_MODE]: ShapeEditMode as unknown as typeof MapboxDraw.modes.direct_select,
        },
        styles: [
          // Line being drawn/edited
          {
            id: 'gl-draw-line',
            type: 'line',
            filter: ['all', ['==', '$type', 'LineString'], ['!=', 'mode', 'static'], ['!in', 'meta', 'range', 'redraw_preview']],
            paint: {
              'line-color': '#E8734A',
              'line-width': 4,
              'line-dasharray': [2, 1],
            },
          },
          // Selected range of a shape (Shift-click range selection)
          {
            id: 'gl-draw-range',
            type: 'line',
            filter: ['all', ['==', '$type', 'LineString'], ['==', 'meta', 'range']],
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
              'line-color': '#1F8A8A',
              'line-width': 9,
              'line-opacity': 0.55,
            },
          },
          // Redraw-segment preview: start vertex → waypoints → end vertex
          {
            id: 'gl-draw-redraw-preview',
            type: 'line',
            filter: ['all', ['==', '$type', 'LineString'], ['==', 'meta', 'redraw_preview']],
            paint: {
              'line-color': '#7B68EE',
              'line-width': 3,
              'line-dasharray': [1, 1],
            },
          },
          {
            id: 'gl-draw-redraw-waypoint',
            type: 'circle',
            filter: ['all', ['==', '$type', 'Point'], ['==', 'meta', 'redraw_waypoint']],
            paint: {
              'circle-radius': 6,
              'circle-color': '#7B68EE',
              'circle-stroke-color': '#FFFFFF',
              'circle-stroke-width': 2,
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
      const onCreate = (e: unknown) => onCreateRef.current?.(e as DrawEvent);
      const onUpdate = (e: unknown) => onUpdateRef.current?.(e as DrawEvent);
      const onDelete = (e: unknown) => onDeleteRef.current?.(e as DrawEvent);
      (map as unknown as DrawListenerHolder).__gbDrawListeners = { onCreate, onUpdate, onDelete };
      map.on('draw.create', onCreate);
      map.on('draw.update', onUpdate);
      map.on('draw.delete', onDelete);
    },
    ({ map }) => {
      const holder = map as unknown as DrawListenerHolder;
      const listeners = holder.__gbDrawListeners;
      if (listeners) {
        map.off('draw.create', listeners.onCreate);
        map.off('draw.update', listeners.onUpdate);
        map.off('draw.delete', listeners.onDelete);
        delete holder.__gbDrawListeners;
      }
    },
  );

  useEffect(() => {
    if (drawRef) drawRef.current = draw;
  }, [draw, drawRef]);

  return null;
}
