// C3-24: "Whole feed" on a multi-agency feed must inform every agency.
import { describe, expect, it } from 'vitest';
import { expandEntities } from '../alertEntities';

const routes = [{ route_id: 'R1' }, { route_id: 'R2' }];

describe('expandEntities', () => {
  it('emits one agency selector per agency', () => {
    expect(expandEntities([{ agency_id: 'A1' }], routes, [{ agency_id: 'A1' }, { agency_id: 'A2' }]))
      .toEqual([{ agency_id: 'A1' }, { agency_id: 'A2' }]);
  });

  it('falls back to every route when an agency has no agency_id', () => {
    expect(expandEntities([{ agency_id: '' }], routes, [{ agency_id: '' }]))
      .toEqual([{ route_id: 'R1' }, { route_id: 'R2' }]);
  });

  it('expands several whole-feed rows once and keeps route/stop rows', () => {
    const agencies = [{ agency_id: 'A1' }, { agency_id: 'A2' }];
    expect(expandEntities(
      [{ agency_id: 'A1' }, { stop_id: 'S1' }, { agency_id: 'A2' }],
      routes,
      agencies,
    )).toEqual([{ agency_id: 'A1' }, { agency_id: 'A2' }, { stop_id: 'S1' }]);
  });
});
