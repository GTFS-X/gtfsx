// C5-03: footnote + docs agree with the implemented methodology.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TITLE_VI_METHOD_NOTE, titleVIBasisLabel } from '../titleVIText';

describe('Title VI text', () => {
  it('footnote states the two-tier buffer and the current ACS vintage', () => {
    expect(TITLE_VI_METHOD_NOTE).toContain('0.25');
    expect(TITLE_VI_METHOD_NOTE).toContain('0.5 mi');
    expect(TITLE_VI_METHOD_NOTE).toMatch(/ACS 20\d\d/);
  });
  it('labels the service day', () => {
    expect(titleVIBasisLabel({ label: 'Mon, Oct 5, 2026', date: '20261005', serviceIds: [] }))
      .toBe('Based on Mon, Oct 5, 2026');
    expect(titleVIBasisLabel(null)).toBeNull();
  });
  it.each(['title-vi-analysis', 'access-isochrones', 'demographic-coverage', 'cost-estimation'])(
    'docs/%s has no stale ACS 2022 or $50 default',
    (slug) => {
      const html = fs.readFileSync(`public/docs/${slug}/index.html`, 'utf8');
      expect(html).not.toMatch(/ACS 2022/);
      expect(html).not.toMatch(/default is \$50/);
    },
  );
});
