// C5-08: the Access Isochrones panel counts resident workers (ACS, where people
// live), not jobs at a workplace. The gate card copy must say the same.
import { describe, expect, it } from 'vitest';
import { FEATURE_COPY } from '../planConfig';

describe('Access isochrones gate copy (C5-08)', () => {
  it('describes resident workers, not jobs', () => {
    const { description } = FEATURE_COPY.access_isochrones;
    expect(description).toMatch(/resident workers/);
    expect(description).not.toMatch(/\bjobs\b/);
  });
});
