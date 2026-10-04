// E2E E3: the import summary said "No route geometry in this feed" / "This
// feed has no usable route geometry" when route A had two shapes and only
// some trips were shapeless. The callout now says how many routes lack it.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { shapeCoverage, shapeCoverageCopy } from '../shapesFromStops';
import type { Shape, Trip } from '../../types/gtfs';

const trip = (id: string, route: string, shape?: string): Trip =>
  ({ trip_id: id, route_id: route, service_id: 'wk', direction_id: 0, shape_id: shape }) as Trip;
const line: Shape = {
  shape_id: 'SH',
  points: [
    { shape_pt_lat: 45, shape_pt_lon: -111, shape_pt_sequence: 0 },
    { shape_pt_lat: 45.01, shape_pt_lon: -111, shape_pt_sequence: 1 },
  ],
} as Shape;

describe('shape coverage copy', () => {
  it('keeps "no route geometry in this feed" when no route has geometry', () => {
    const c = shapeCoverage([trip('t1', 'A'), trip('t2', 'B')], []);
    expect(c).toEqual({ routesWithTrips: 2, routesMissingGeometry: 2 });
    expect(shapeCoverageCopy(c).title).toBe('No route geometry in this feed');
  });

  it('counts routes missing geometry when some routes have shapes', () => {
    const c = shapeCoverage([trip('t1', 'A', 'SH'), trip('t2', 'B'), trip('t3', 'C', 'SH')], [line]);
    expect(c).toEqual({ routesWithTrips: 3, routesMissingGeometry: 1 });
    const copy = shapeCoverageCopy(c);
    expect(copy.title).toBe('Some routes have no route geometry');
    expect(copy.lead).toMatch(/^1 of 3 routes has trips without a shape/);
    expect(copy.lead).not.toMatch(/no usable route geometry/);
  });

  it('counts a route with some shaped and some shapeless trips once', () => {
    const c = shapeCoverage([trip('t1', 'A', 'SH'), trip('t2', 'A'), trip('t3', 'B', 'SH')], [line]);
    expect(c).toEqual({ routesWithTrips: 2, routesMissingGeometry: 1 });
  });

  it('ImportDialog renders the computed copy instead of a fixed string', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../components/import-export/ImportDialog.tsx', import.meta.url)),
      'utf8',
    );
    expect(src).not.toMatch(/>No route geometry in this feed</);
    expect(src).toMatch(/\{coverageCopy\?\.title\}/);
    expect(src).toMatch(/\{coverageCopy\?\.lead\}/);
  });
});
