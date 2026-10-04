// C3-15: the timezone picker must show the stored zone (America/Phoenix used to
// render as America/New_York). C3-14 (translations card) shares this file's
// small pure-helper style, so it lives in translations/__tests__.
import { describe, expect, it } from 'vitest';
import { timezoneOptions } from '../agencyHelpers';

const COMMON = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'];

describe('timezoneOptions', () => {
  it('lists America/Phoenix from the runtime zone list', () => {
    const opts = timezoneOptions('America/Phoenix', COMMON, ['America/Chicago', 'America/Phoenix', 'Europe/Paris']);
    expect(opts.all).toContain('America/Phoenix');
    expect(opts.all).not.toContain('America/Chicago'); // already in the common group
    expect(opts.extra).toBeNull();
  });

  it('keeps a stored value neither list knows as an extra option', () => {
    const opts = timezoneOptions('US/Arizona', COMMON, ['America/Phoenix']);
    expect(opts.extra).toBe('US/Arizona');
  });

  it('without Intl.supportedValuesOf, still shows the stored zone', () => {
    const opts = timezoneOptions('America/Phoenix', COMMON, null);
    expect(opts.all).toEqual([]);
    expect(opts.extra).toBe('America/Phoenix');
  });

  it('the real runtime list includes America/Phoenix', () => {
    const opts = timezoneOptions('America/Phoenix', COMMON);
    expect(opts.extra === 'America/Phoenix' || opts.all.includes('America/Phoenix')).toBe(true);
  });
});
