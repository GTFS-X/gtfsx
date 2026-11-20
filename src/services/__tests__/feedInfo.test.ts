// feed_info.txt editor: spec validation, the service-calendar date helper, the
// version bump, the feed_end_date-behind-service validation rule + its one-click
// fix, the fixed GTFS·X publisher, and the import → edit → export round-trip.
//
// See services/feedInfo.ts, services/gtfsExport.ts
// (buildFeedInfoRow), services/validation.ts, services/validationFixes.ts.
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import Papa from 'papaparse';
import { useStore } from '../../store';
import { importGtfsZip, loadImportIntoStore } from '../gtfsImport';
import { buildFeedInfoRow, exportGtfsZip } from '../gtfsExport';
import { resetEditorState } from '../../db/serverPersistence';
import { runValidation } from '../validation';
import { applyValidationFix, applyServiceDatesToFeedInfo, getValidationFix } from '../validationFixes';
import {
  feedEndBehindService, gtfsDateToIso, isoToGtfsDate, isValidEmail, isValidFeedUrl, isValidGtfsDate,
  nextFeedVersion, serviceDateRange, validateFeedInfo, GTFSX_PUBLISHER_NAME, GTFSX_PUBLISHER_URL,
} from '../feedInfo';
import { analyzeTranslations } from '../translations';
import type { Calendar, CalendarDate, FeedInfo } from '../../types/gtfs';

const FIXTURE = path.resolve(__dirname, '../../../tests/fixtures/sample-gtfs-feed');

async function fixtureZip(overrides: Record<string, string | null> = {}): Promise<File> {
  const zip = new JSZip();
  for (const f of readdirSync(FIXTURE)) {
    if (!f.endsWith('.txt') || f in overrides) continue;
    zip.file(f, readFileSync(path.join(FIXTURE, f)));
  }
  for (const [name, body] of Object.entries(overrides)) if (body !== null) zip.file(name, body);
  return (await zip.generateAsync({ type: 'uint8array' })) as unknown as File;
}

async function exportedFeedInfo(): Promise<{ header: string; row: Record<string, string> } | null> {
  const blob = await exportGtfsZip();
  const zip = await JSZip.loadAsync(new Uint8Array(await blob.arrayBuffer()));
  const f = zip.file('feed_info.txt');
  if (!f) return null;
  const csv = await f.async('string');
  const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
  expect(parsed.data).toHaveLength(1);
  return { header: csv.split(/\r?\n/)[0], row: parsed.data[0] };
}

const cal = (service_id: string, start_date: string, end_date: string): Calendar => ({
  service_id, monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0, start_date, end_date,
});
const info = (over: Partial<FeedInfo> = {}): FeedInfo => ({
  feed_publisher_name: '', feed_publisher_url: '', feed_lang: 'en', ...over,
});

beforeEach(() => resetEditorState());

describe('value formats', () => {
  it('GTFS dates must be real YYYYMMDD days', () => {
    expect(isValidGtfsDate('20261120')).toBe(true);
    expect(isValidGtfsDate('20240229')).toBe(true);
    expect(isValidGtfsDate('20250229')).toBe(false);
    expect(isValidGtfsDate('2026-11-20')).toBe(false);
    expect(isValidGtfsDate('20261301')).toBe(false);
    expect(isValidGtfsDate('')).toBe(false);
  });
  it('converts between GTFS and ISO dates; malformed shows blank', () => {
    expect(gtfsDateToIso('20261120')).toBe('2026-11-20');
    expect(gtfsDateToIso('11/20/2026')).toBe('');
    expect(isoToGtfsDate('2026-11-20')).toBe('20261120');
    expect(isoToGtfsDate('')).toBe('');
  });
  it('URLs must be fully qualified http(s)', () => {
    expect(isValidFeedUrl('https://agency.gov/gtfs')).toBe(true);
    expect(isValidFeedUrl('http://agency.gov')).toBe(true);
    expect(isValidFeedUrl('agency.gov')).toBe(false);
    expect(isValidFeedUrl('ftp://agency.gov')).toBe(false);
    expect(isValidFeedUrl('https://localhost')).toBe(false);
  });
  it('emails are plain addresses', () => {
    expect(isValidEmail('gtfs@agency.gov')).toBe(true);
    expect(isValidEmail('mailto:gtfs@agency.gov')).toBe(false);
    expect(isValidEmail('GTFS Team <gtfs@agency.gov>')).toBe(false);
    expect(isValidEmail('gtfs@agency')).toBe(false);
  });
});

describe('validateFeedInfo', () => {
  it('accepts a complete, valid row and a blank one', () => {
    expect(validateFeedInfo(info({
      feed_start_date: '20260101', feed_end_date: '20261231', feed_version: 'v1',
      feed_contact_email: 'gtfs@agency.gov', feed_contact_url: 'https://agency.gov/contact', default_lang: 'en',
    }))).toEqual([]);
    expect(validateFeedInfo(info({ feed_lang: '' }))).toEqual([]);
    expect(validateFeedInfo(null)).toEqual([]);
  });
  it('flags malformed dates, an inverted window, bad email and URL', () => {
    const fields = validateFeedInfo(info({
      feed_start_date: '2026-01-01', feed_contact_email: 'nope', feed_contact_url: 'agency.gov',
    })).map((i) => i.field);
    expect(fields).toEqual(['feed_start_date', 'feed_contact_email', 'feed_contact_url']);
    expect(validateFeedInfo(info({ feed_start_date: '20261231', feed_end_date: '20260101' })))
      .toEqual([{ field: 'feed_end_date', message: 'End date is before the start date.' }]);
  });
  it('flags bad language codes unless told the translations rules own them', () => {
    const bad = info({ feed_lang: 'English', default_lang: 'Spanish' });
    expect(validateFeedInfo(bad).map((i) => i.field)).toEqual(['feed_lang', 'default_lang']);
    expect(validateFeedInfo(bad, { includeLanguages: false })).toEqual([]);
    expect(validateFeedInfo(info({ feed_lang: 'mul' }))).toEqual([]);
  });
  it('never checks the publisher pair (always GTFS·X on export)', () => {
    expect(validateFeedInfo(info({ feed_publisher_name: '', feed_publisher_url: 'not a url' }))).toEqual([]);
  });
});

describe('serviceDateRange', () => {
  it('spans calendar start/end and added calendar_dates, ignoring removed ones', () => {
    const cals = [cal('A', '20260105', '20260630'), cal('B', '20260301', '20261231')];
    const dates: CalendarDate[] = [
      { service_id: 'X', date: '20270115', exception_type: 1 },
      { service_id: 'A', date: '20251201', exception_type: 2 },
    ];
    expect(serviceDateRange(cals, dates)).toEqual({ start: '20260105', end: '20270115' });
  });
  it('handles a calendar_dates-only feed and skips malformed rows', () => {
    expect(serviceDateRange([cal('bad', '2026', '20261231')], [
      { service_id: 'X', date: '20260704', exception_type: 1 },
      { service_id: 'X', date: '20260101', exception_type: 1 },
    ])).toEqual({ start: '20260101', end: '20260704' });
  });
  it('is null with no service', () => {
    expect(serviceDateRange([], [])).toBeNull();
  });
});

describe('nextFeedVersion', () => {
  const now = new Date(2026, 10, 20, 9, 0);
  it('stamps today, then counts up within the day', () => {
    expect(nextFeedVersion(undefined, now)).toBe('20261120');
    expect(nextFeedVersion('third version', now)).toBe('20261120');
    expect(nextFeedVersion('20261119-4', now)).toBe('20261120');
    expect(nextFeedVersion('20261120', now)).toBe('20261120-2');
    expect(nextFeedVersion('20261120-2', now)).toBe('20261120-3');
  });
});

describe('feedEndBehindService', () => {
  const range = { start: '20260101', end: '20261231' };
  it('fires only when feed_end_date ends before the service', () => {
    expect(feedEndBehindService(info({ feed_end_date: '20210301' }), range))
      .toEqual({ feedEnd: '20210301', serviceEnd: '20261231' });
    expect(feedEndBehindService(info({ feed_end_date: '20261231' }), range)).toBeNull();
    expect(feedEndBehindService(info({ feed_end_date: '20270101' }), range)).toBeNull();
    expect(feedEndBehindService(info(), range)).toBeNull();
    expect(feedEndBehindService(info({ feed_end_date: '20210301' }), null)).toBeNull();
  });
});

describe('validation rule + fix: feed_end_date behind the service calendar', () => {
  // The Butte-Silver Bow case: a stale imported window over extended calendars.
  function staleFeed() {
    const s = useStore.getState();
    s.setAgencies([{ agency_id: 'A', agency_name: 'Valley Transit', agency_url: 'https://valley.example.gov', agency_timezone: 'America/Denver' }]);
    s.setCalendars([cal('WK', '20260101', '20271231')]);
    s.setFeedInfo(info({ feed_start_date: '20201228', feed_end_date: '20210301', feed_version: 'old' }));
  }

  it('warns with a registered one-click fix, and does not double-report expiry', () => {
    staleFeed();
    const msgs = runValidation(useStore.getState());
    const behind = msgs.filter((m) => m.fix?.id === 'feed-info-dates-from-service');
    expect(behind).toHaveLength(1);
    expect(behind[0].message).toMatch(/2021-03-01 is in the past and is earlier than the service calendar, which runs through 2027-12-31/);
    expect(behind[0].entity_type).toBe('agency');
    expect(getValidationFix('feed-info-dates-from-service')?.apply).toBeTypeOf('function');
    // The stale date isn't ALSO reported by the expiry heads-up.
    expect(msgs.some((m) => /This feed expired/.test(m.message))).toBe(false);
  });

  it('the fix resets the window to the service calendar, clears the warning, and undoes', () => {
    staleFeed();
    const m = runValidation(useStore.getState()).find((x) => x.fix?.id === 'feed-info-dates-from-service')!;
    const r = applyValidationFix(m)!;
    expect(r.changed).toBe(true);
    expect(useStore.getState().feedInfo).toMatchObject({ feed_start_date: '20260101', feed_end_date: '20271231', feed_version: 'old' });
    expect(runValidation(useStore.getState()).some((x) => x.fix?.id === 'feed-info-dates-from-service')).toBe(false);
    r.undo();
    expect(useStore.getState().feedInfo).toMatchObject({ feed_start_date: '20201228', feed_end_date: '20210301' });
  });

  it('creates feed_info for a feed that has none, and undo removes only the dates', () => {
    useStore.getState().setCalendars([cal('WK', '20260101', '20261231')]);
    expect(useStore.getState().feedInfo).toBeNull();
    const r = applyServiceDatesToFeedInfo();
    expect(useStore.getState().feedInfo).toMatchObject({ feed_start_date: '20260101', feed_end_date: '20261231' });
    useStore.getState().updateFeedInfo({ feed_version: 'typed-after' });
    r.undo();
    const fi = useStore.getState().feedInfo!;
    expect(fi.feed_start_date).toBeUndefined();
    expect(fi.feed_end_date).toBeUndefined();
    expect(fi.feed_version).toBe('typed-after');
  });

  it('is a no-op without service dates', () => {
    expect(applyServiceDatesToFeedInfo().changed).toBe(false);
  });

  it('reports malformed values as errors deep-linked to the Agency panel', () => {
    useStore.getState().setFeedInfo(info({ feed_end_date: '2021-03-01', feed_contact_email: 'x' }));
    const msgs = runValidation(useStore.getState()).filter((m) => m.message.startsWith('Feed info:'));
    expect(msgs.map((m) => [m.severity, m.field, m.entity_type])).toEqual([
      ['error', 'feed_end_date', 'agency'],
      ['error', 'feed_contact_email', 'agency'],
    ]);
  });
});

describe('publisher', () => {
  it('publisher translations stay omitted (the export always names GTFS·X)', () => {
    const feed = {
      agencies: [], stops: [], routes: [], trips: [], stopTimes: [], pathways: [], levels: [],
      translations: [{ table_name: 'feed_info', field_name: 'feed_publisher_name', language: 'es', translation: 'Tránsito' }],
    };
    expect(analyzeTranslations({ ...feed, feedInfo: info({ feed_publisher_name: 'Valley', feed_publisher_url: 'https://v.example.gov' }) }))
      .toEqual([{ index: 0, kind: 'publisher-overwritten' }]);
  });
});

describe('round-trip: import → edit → export', () => {
  it('writes exactly the edited values', async () => {
    loadImportIntoStore(await importGtfsZip(await fixtureZip()));
    const s = useStore.getState();
    expect(s.feedInfo).toMatchObject({ feed_start_date: '20190303', feed_end_date: '20190810', feed_version: 'third version' });

    s.updateFeedInfo({
      feed_start_date: '20260101',
      feed_end_date: '20271231',
      feed_version: '20261120',
      feed_contact_email: 'gtfs@valley.example.gov',
      feed_contact_url: undefined, // cleared in the panel
      default_lang: 'en',
      feed_lang: 'en-US',
    });
    const out = (await exportedFeedInfo())!;
    expect(out.row).toEqual({
      feed_publisher_name: GTFSX_PUBLISHER_NAME,
      feed_publisher_url: GTFSX_PUBLISHER_URL,
      feed_lang: 'en-US',
      default_lang: 'en',
      feed_start_date: '20260101',
      feed_end_date: '20271231',
      feed_version: '20261120',
      feed_contact_email: 'gtfs@valley.example.gov',
    });
  });

  it('an imported or edited publisher never reaches the export', async () => {
    loadImportIntoStore(await importGtfsZip(await fixtureZip()));
    expect(useStore.getState().feedInfo?.feed_publisher_name).toBe('Some Transit Authority');
    useStore.getState().updateFeedInfo({ feed_publisher_name: 'Valley Transit', feed_publisher_url: 'https://valley.example.gov' });
    const out = (await exportedFeedInfo())!;
    expect(out.row.feed_publisher_name).toBe(GTFSX_PUBLISHER_NAME);
    expect(out.row.feed_publisher_url).toBe(GTFSX_PUBLISHER_URL);
  });

  it('is stable: export → import → export gives the same feed_info.txt', async () => {
    loadImportIntoStore(await importGtfsZip(await fixtureZip()));
    useStore.getState().updateFeedInfo({ feed_end_date: '20271231', feed_version: 'v2' });
    const first = await exportedFeedInfo();
    const blob = await exportGtfsZip();
    loadImportIntoStore(await importGtfsZip(new Uint8Array(await blob.arrayBuffer()) as unknown as File));
    expect(await exportedFeedInfo()).toEqual(first);
  });

  it('a feed with no feed_info can create one from the editor', async () => {
    loadImportIntoStore(await importGtfsZip(await fixtureZip({ 'feed_info.txt': null })));
    expect(useStore.getState().feedInfo).toBeNull();
    useStore.getState().updateFeedInfo({ feed_end_date: '20261231', feed_contact_url: 'https://valley.example.gov/contact' });
    const out = (await exportedFeedInfo())!;
    expect(out.row).toMatchObject({
      feed_publisher_name: GTFSX_PUBLISHER_NAME,
      feed_end_date: '20261231',
      feed_contact_url: 'https://valley.example.gov/contact',
    });
    expect(out.row.feed_lang).toBeTruthy();
  });

  it('trims stray whitespace and omits blanks', () => {
    const row = buildFeedInfoRow({ agencies: [], feedInfo: info({ feed_version: '  v3 ', feed_contact_email: '  ', feed_lang: 'fr' }) });
    expect(row).toEqual({ feed_publisher_name: GTFSX_PUBLISHER_NAME, feed_publisher_url: GTFSX_PUBLISHER_URL, feed_lang: 'fr', feed_version: 'v3' });
  });
});
