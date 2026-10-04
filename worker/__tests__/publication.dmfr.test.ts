// W2-18: buildDmfrDocument() must never emit two operators with the same
// onestop_id. Agencies whose names reduce to the same Onestop name component
// collide on the feed-wide geohash; the first keeps its plain id (stable for
// already-published operators), later ones are suffixed.

import { describe, expect, it } from 'vitest';
import { buildDmfrDocument } from '../publication/dmfr';

describe('buildDmfrDocument operator ids', () => {
  const base = {
    slug: 'metro',
    feedsOrigin: 'https://feeds.example.test',
    feedTitle: 'Metro',
    centroid: { lat: 35.68, lon: 139.76 },
  };

  it('dedupes colliding onestop ids, keeping the first occurrence unchanged', () => {
    const doc = buildDmfrDocument({
      ...base,
      agencies: [
        { agency_id: 'tokyo', agency_name: '東京' },
        { agency_id: 'osaka', agency_name: '大阪' },
        { agency_id: 'MT', agency_name: 'Metro Transit' },
        { agency_id: 'MT2', agency_name: 'Metro-Transit' },
      ],
    });
    const ids = (doc.feeds[0].operators ?? []).map((o) => o.onestop_id);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);

    // First of each colliding pair is what a single-agency feed would emit.
    const solo = (name: string) =>
      buildDmfrDocument({ ...base, agencies: [{ agency_id: 'x', agency_name: name }] }).feeds[0].operators![0].onestop_id;
    expect(ids[0]).toBe(solo('東京'));
    expect(ids[2]).toBe(solo('Metro Transit'));
    // Later duplicates carry the agency_id.
    expect(ids[1]).toBe(`${ids[0]}~osaka`);
    expect(ids[3]).toBe(`${ids[2]}~mt2`);
  });

  it('falls back to a counter when the agency_id is missing or also collides', () => {
    const doc = buildDmfrDocument({
      ...base,
      agencies: [
        { agency_name: 'Metro Transit' },
        { agency_name: 'Metro Transit' },
        { agency_name: 'Metro Transit' },
      ],
    });
    const ids = (doc.feeds[0].operators ?? []).map((o) => o.onestop_id);
    expect(new Set(ids).size).toBe(3);
    expect(ids[1]).toBe(`${ids[0]}~2`);
    expect(ids[2]).toBe(`${ids[0]}~3`);
  });
});
