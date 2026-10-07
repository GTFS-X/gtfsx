import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Feature } from 'geojson';
import {
  COUNTY_LAYER,
  CountyNotFoundError,
  __setCountyReaderForTests,
  lookupCounty,
} from '../countyLookup';

/** Axis-aligned square county, [minX, minY]–[maxX, maxY]. */
function county(geoid: string, name: string, minX: number, minY: number, maxX: number, maxY: number): Feature {
  return {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [[[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]]],
    },
    properties: { geoid, statefp: geoid.slice(0, 2), countyfp: geoid.slice(2), name },
  };
}

// Two adjacent counties sharing the line x = -111.
const GALLATIN = county('30031', 'Gallatin', -111.5, 45, -111, 46);
const PARK = county('30067', 'Park', -111, 45, -110.5, 46);

/** A fake reader that returns every feature whose bbox intersects the query rect. */
function fakeReader(features: Feature[]) {
  const calls: { url: string; rect: { minX: number; minY: number; maxX: number; maxY: number } }[] = [];
  const fn = vi.fn((url: string, rect: { minX: number; minY: number; maxX: number; maxY: number }) => {
    calls.push({ url, rect });
    return (async function* () {
      for (const f of features) {
        if (f.geometry.type !== 'Polygon') {
          yield f;
          continue;
        }
        const ring = (f.geometry as { coordinates: number[][][] }).coordinates[0];
        const xs = ring.map((c) => c[0]);
        const ys = ring.map((c) => c[1]);
        if (Math.max(...xs) < rect.minX || Math.min(...xs) > rect.maxX) continue;
        if (Math.max(...ys) < rect.minY || Math.min(...ys) > rect.maxY) continue;
        yield f;
      }
    })();
  });
  return { fn, calls };
}

describe('countyLookup.lookupCounty', () => {
  beforeEach(() => __setCountyReaderForTests(null));
  afterEach(() => __setCountyReaderForTests(null));

  it('returns state/county FIPS and name for a point inside a county', async () => {
    const r = fakeReader([GALLATIN, PARK]);
    __setCountyReaderForTests(r.fn);
    await expect(lookupCounty(45.68, -111.04)).resolves.toEqual({
      stateFips: '30',
      countyFips: '031',
      countyName: 'Gallatin',
    });
    expect(r.calls[0].url).toContain(`/_coverage/${COUNTY_LAYER}.fgb`);
    // The query box is tiny and centred on the point.
    expect(r.calls[0].rect.maxX - r.calls[0].rect.minX).toBeLessThan(0.05);
  });

  it('picks the polygon that contains the point when several bboxes match', async () => {
    __setCountyReaderForTests(fakeReader([GALLATIN, PARK]).fn);
    const res = await lookupCounty(45.5, -110.999);
    expect(res.countyFips).toBe('067');
  });

  it('caches by coordinate and reuses loaded polygons without refetching', async () => {
    const r = fakeReader([GALLATIN, PARK]);
    __setCountyReaderForTests(r.fn);
    await lookupCounty(45.68, -111.04);
    await lookupCounty(45.68, -111.04); // exact repeat → result cache
    await lookupCounty(45.2, -111.3); // different point, same loaded county → polygon cache
    expect(r.fn).toHaveBeenCalledTimes(1);
  });

  it('shares one request between concurrent calls for the same point', async () => {
    const r = fakeReader([GALLATIN]);
    __setCountyReaderForTests(r.fn);
    const [a, b] = await Promise.all([lookupCounty(45.68, -111.2), lookupCounty(45.68, -111.2)]);
    expect(a).toEqual(b);
    expect(r.fn).toHaveBeenCalledTimes(1);
  });

  it('snaps a point just outside every polygon to the nearest county', async () => {
    __setCountyReaderForTests(fakeReader([GALLATIN]).fn);
    // ~80 m west of Gallatin's west edge (e.g. a simplification sliver).
    const res = await lookupCounty(45.5, -111.501);
    expect(res.countyFips).toBe('031');
  });

  it('throws CountyNotFoundError (same message as the FCC path) outside every county', async () => {
    __setCountyReaderForTests(fakeReader([GALLATIN]).fn);
    const p = lookupCounty(0, 0);
    await expect(p).rejects.toBeInstanceOf(CountyNotFoundError);
    await expect(p).rejects.toThrow(/No FIPS results/);
  });

  it('rejects non-finite coordinates without a request', async () => {
    const r = fakeReader([GALLATIN]);
    __setCountyReaderForTests(r.fn);
    await expect(lookupCounty(NaN, -111)).rejects.toBeInstanceOf(CountyNotFoundError);
    expect(r.fn).not.toHaveBeenCalled();
  });

  it('wraps reader failures and does not cache them, so a retry can succeed', async () => {
    let fail = true;
    const good = fakeReader([GALLATIN]);
    __setCountyReaderForTests((url, rect) => {
      if (fail) {
        return {
          [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('HTTP 503')) }),
        };
      }
      return good.fn(url, rect);
    });
    await expect(lookupCounty(45.68, -111.2)).rejects.toThrow(/County boundary lookup failed: HTTP 503/);
    fail = false;
    await expect(lookupCounty(45.68, -111.2)).resolves.toMatchObject({ countyFips: '031' });
  });

  it('ignores features that are not county polygons', async () => {
    const pointFeature: Feature = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-111.2, 45.68] },
      properties: { statefp: '99', countyfp: '999' },
    };
    __setCountyReaderForTests(fakeReader([pointFeature, GALLATIN]).fn);
    await expect(lookupCounty(45.68, -111.2)).resolves.toMatchObject({ stateFips: '30' });
  });
});
