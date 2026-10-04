// Map layer-id contracts and MapView's mocked-map handlers (bug review B6):
// C1-03 cluster click source id, C1-10 drag hit-test on clustered feeds,
// C1-11 demand-dots beforeId, C1-05 Esc guard, C1-08 shape-edit snapshot.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  STOPS_CLUSTER_SOURCE_ID,
  STOP_CLUSTER_POINTS_LAYER_ID,
  demandDotsBeforeId,
  stopLayerIds,
} from '../stopLayerIds';
import {
  expandStopCluster,
  isTextEntryTarget,
  nextShapeEditSnapshot,
  pointerHitsStop,
} from '../mapInteractions';
import type { ShapePoint } from '../../../types/gtfs';

const here = dirname(fileURLToPath(import.meta.url));
const src = (f: string) => readFileSync(join(here, '..', f), 'utf8');

describe('C1-03: cluster click expands the clustered source', () => {
  it('looks up the source StopLayer actually declares and eases to the expansion zoom', () => {
    const easeTo = vi.fn();
    const source = {
      getClusterExpansionZoom: (_id: number, cb: (err: unknown, zoom: number) => void) => cb(null, 13),
    };
    const map = { getSource: (id: string) => (id === 'stops-cluster' ? source : undefined), easeTo };
    expect(expandStopCluster(map, 42, [-111, 45])).toBe(true);
    expect(easeTo).toHaveBeenCalledWith({ center: [-111, 45], zoom: 13, duration: 500 });
  });

  it('StopLayer and MapView share the source id constant (no stray literal)', () => {
    expect(STOPS_CLUSTER_SOURCE_ID).toBe('stops-cluster');
    expect(src('StopLayer.tsx')).toContain('id={STOPS_CLUSTER_SOURCE_ID}');
    expect(src('MapView.tsx')).not.toMatch(/getSource\('stop-cluster'\)/);
  });
});

describe('C1-11: demand dots go beneath a layer that exists in each mode', () => {
  it.each([false, true])('clustered=%s', (clustered) => {
    expect(stopLayerIds(clustered)).toContain(demandDotsBeforeId(clustered));
  });

  it('MapView passes the cluster mode to DemandDotsLayer', () => {
    expect(src('MapView.tsx')).toMatch(/<DemandDotsLayer[^>]*clustered=\{clusterStops\}/);
    expect(src('DemandDotsLayer.tsx')).toContain('beforeId={demandDotsBeforeId(clustered)}');
  });
});

describe('C1-10: drag hit-test on a clustered feed', () => {
  it('queries only layers the map has, and finds the stop on stop-cluster-points', () => {
    const queryRenderedFeatures = vi.fn(() => [{ properties: { stop_id: 'S1' } }]);
    const map = {
      getLayer: (id: string) => (id === STOP_CLUSTER_POINTS_LAYER_ID ? {} : undefined),
      queryRenderedFeatures,
    };
    expect(pointerHitsStop(map, [10, 10], 'S1')).toBe(true);
    expect(queryRenderedFeatures).toHaveBeenCalledWith([10, 10], { layers: ['stop-cluster-points'] });
    expect(pointerHitsStop(map, [10, 10], 'OTHER')).toBe(false);
  });

  it('does not query at all when no stop layer is mounted', () => {
    const queryRenderedFeatures = vi.fn(() => []);
    expect(pointerHitsStop({ getLayer: () => undefined, queryRenderedFeatures }, [0, 0], 'S1')).toBe(false);
    expect(queryRenderedFeatures).not.toHaveBeenCalled();
  });
});

describe('C1-08: shape-edit Cancel snapshot', () => {
  const pts = (lat: number): ShapePoint[] => [
    { shape_pt_lat: lat, shape_pt_lon: -111, shape_pt_sequence: 0, shape_dist_traveled: 0 },
  ];

  it('a re-run for the same shape (Simplify: id null → same id) keeps the pre-edit points', () => {
    const first = nextShapeEditSnapshot(null, 'A', pts(45));
    const again = nextShapeEditSnapshot(first, 'A', pts(46)); // already-edited points
    expect(again).toBe(first);
    expect(again.points[0].shape_pt_lat).toBe(45);
  });

  it('a different shape takes its own snapshot, deep-copied', () => {
    const live = pts(47);
    const snap = nextShapeEditSnapshot(nextShapeEditSnapshot(null, 'A', pts(45)), 'B', live);
    expect(snap.shapeId).toBe('B');
    live[0].shape_pt_lat = 0;
    expect(snap.points[0].shape_pt_lat).toBe(47);
  });

  it('MapView only restores a snapshot that belongs to the shape being edited', () => {
    expect(src('MapView.tsx')).toContain('snapshot.shapeId === currentEditingId');
  });
});

describe('C1-05: Esc in Add Stop', () => {
  it('treats text fields as text entry (Esc there must not delete the placed stop)', () => {
    expect(isTextEntryTarget({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true);
    expect(isTextEntryTarget({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true);
    expect(isTextEntryTarget({ tagName: 'DIV' } as unknown as EventTarget)).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
  });

  it('MapView forgets the last placed stop whenever place_stop mode ends', () => {
    expect(src('MapView.tsx')).toMatch(
      /if \(mapMode !== 'place_stop'\) lastPlacedStopRef\.current = null;/,
    );
  });
});

describe('C1-01: map and Create-stop append sites use appendRouteStop', () => {
  it.each(['MapView.tsx', '../stops/CreateStopPanel.tsx'])('%s', (f) => {
    const text = src(f);
    expect(text).toContain('appendRouteStop(');
    expect(text).not.toMatch(/\baddRouteStop\(/);
    expect(text).not.toContain('nextRouteStopSequence');
  });
});
