// Staff export hygiene: CSV formula injection (W3-14) and ISO-week bucketing of
// the ads-attribution table (W3-18). Pure helpers, no HTTP.

import { describe, expect, it } from 'vitest';
import { csvCell } from '../util/csv';
import { renderCsv, type WarmRow } from '../admin/warmCohort';
import { groupAdsAttribution } from '../admin/routes';

describe('csvCell', () => {
  it('neutralizes formula-leading values and still quotes per RFC 4180', () => {
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(csvCell('+1')).toBe(`'+1`);
    expect(csvCell('-2')).toBe(`'-2`);
    expect(csvCell('@SUM(A1)')).toBe(`'@SUM(A1)`);
    expect(csvCell('\tx')).toBe(`'\tx`);
    expect(csvCell('\rx')).toBe(`"'\rx"`);
  });

  it('leaves ordinary values alone', () => {
    expect(csvCell('')).toBe('');
    expect(csvCell('Bozeman Transit')).toBe('Bozeman Transit');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('{"k":1}')).toBe('"{""k"":1}"');
    expect(csvCell('user@example.com')).toBe('user@example.com');
  });
});

describe('warm-cohort CSV', () => {
  it('an org_name formula is emitted as text', () => {
    const row: WarmRow = {
      email: 'a@example.com',
      account_created_at: null,
      last_active_at: null,
      org_name: '=HYPERLINK("http://evil.example","click")',
      saved_feeds_count: 0,
      at_free_cap: false,
      exported_gtfs_count: 0,
      has_flex_zones: false,
      distinct_active_days_30d: 0,
      sessions_last_30d: 0,
      attempted_pro_action_count: 0,
      attempted_pro_action_last_action: null,
      attempted_pro_action_last_ts: null,
      is_consultant_signal: false,
      score: 0,
    };
    const dataLine = renderCsv([row]).split('\n')[1];
    expect(dataLine).toContain(`"'=HYPERLINK(""http://evil.example"",""click"")"`);
    expect(dataLine).not.toMatch(/(^|,)=/);
  });
});

describe('groupAdsAttribution (ISO weeks)', () => {
  it('buckets 2027-01-01 into ISO week 2026-53, not SQLite %W week 2027-00', () => {
    const rows = groupAdsAttribution([
      { ts: Date.UTC(2027, 0, 1, 12), kind: 'sign_up', gclid: 'g1' },
    ]);
    expect(rows).toEqual([{ week: '2026-53', kind: 'sign_up', n: 1, sample_gclids: 'g1' }]);
  });

  it('sorts week DESC, count DESC, kind ASC and keeps 5 newest samples', () => {
    const wk2 = Date.UTC(2026, 9, 14); // ISO 2026-42
    const wk1 = Date.UTC(2026, 9, 7); // ISO 2026-41
    const events = [
      ...Array.from({ length: 6 }, (_, i) => ({ ts: wk2 - i, kind: 'feed_exported', gclid: `e${i}` })),
      { ts: wk2 - 100, kind: 'paywall_view', gclid: 'p0' },
      { ts: wk1, kind: 'feed_exported', gclid: 'old' },
    ];
    const rows = groupAdsAttribution(events);
    expect(rows.map((r) => [r.week, r.kind, r.n])).toEqual([
      ['2026-42', 'feed_exported', 6],
      ['2026-42', 'paywall_view', 1],
      ['2026-41', 'feed_exported', 1],
    ]);
    expect(rows[0].sample_gclids).toBe('e0, e1, e2, e3, e4');
  });
});
