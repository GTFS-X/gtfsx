// Embed/landing hardening: feed text in hrefs and inline styles, date-aware
// ETags, the stop departure list, malformed percent-encoding on the JSON API,
// and the RT passthrough's upstream size cap.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SELF } from 'cloudflare:test';
import { ulid } from 'ulidx';
import { makeClient, type TestClient } from './_client';
import { applyMigrations, dbRun, gzip, resetDb, seedUser } from './_setup';
import { safeDecode, safeHex, safeLinkHref, safeTelHref } from '../embeds/safe';
import { todayInTimezone } from '../embeds/services';

describe('embed sanitizers', () => {
  it('safeHex accepts 6-digit hex (trimmed) and falls back otherwise', () => {
    expect(safeHex('8e44ad', 'cccccc')).toBe('8e44ad');
    expect(safeHex(' 005B95 ', 'cccccc')).toBe('005B95');
    expect(safeHex('fff;position:fixed', 'cccccc')).toBe('cccccc');
    expect(safeHex('fff', 'cccccc')).toBe('cccccc');
    expect(safeHex(undefined, '000000')).toBe('000000');
  });

  it('safeLinkHref allows only http(s)', () => {
    expect(safeLinkHref('https://agency.example/')).toBe('https://agency.example/');
    expect(safeLinkHref('javascript:alert(1)')).toBeNull();
    expect(safeLinkHref(' JavaScript:alert(1)')).toBeNull();
    expect(safeLinkHref('data:text/html,x')).toBeNull();
    expect(safeLinkHref('not a url')).toBeNull();
  });

  it('safeTelHref keeps only dialable characters', () => {
    expect(safeTelHref('+1 (406) 555-0100')).toBe('tel:+1(406)555-0100');
    expect(safeTelHref('" onclick="x')).toBeNull();
  });

  it('safeDecode returns null for malformed percent-encoding', () => {
    expect(safeDecode('a%20b')).toBe('a b');
    expect(safeDecode('%ZZ')).toBeNull();
    expect(safeDecode('%E0%A4%A')).toBeNull();
  });
});

const TZ = 'America/Denver';

function hostileState() {
  // 100 departures from s1 between 05:00 and 23:30.
  const trips = [];
  const stopTimes = [];
  for (let k = 0; k < 100; k++) {
    const mins = 5 * 60 + Math.round((k * (23.5 * 60 - 5 * 60)) / 99);
    const hh = String(Math.floor(mins / 60)).padStart(2, '0');
    const mm = String(mins % 60).padStart(2, '0');
    const id = `t${k}`;
    trips.push({ trip_id: id, route_id: 'R1', service_id: 'DAILY', direction_id: 0, shape_id: 'sh1', trip_headsign: 'Downtown' });
    stopTimes.push({ trip_id: id, arrival_time: `${hh}:${mm}:00`, departure_time: `${hh}:${mm}:00`, stop_id: 's1', stop_sequence: 1 });
    stopTimes.push({ trip_id: id, arrival_time: `${hh}:${mm}:00`, departure_time: `${hh}:${mm}:00`, stop_id: 's2', stop_sequence: 2 });
  }
  return {
    feedInfo: { feed_publisher_name: 'Agency', feed_start_date: '20200101', feed_end_date: '20991231' },
    agencies: [{
      agency_id: 'a1',
      agency_name: 'Hardening Agency',
      agency_url: 'javascript:alert(1)',
      agency_phone: '406" onmouseover="x',
      agency_timezone: TZ,
    }],
    routes: [{ route_id: 'R1', agency_id: 'a1', route_short_name: '1', route_long_name: 'Downtown', route_type: 3, route_color: 'fff;zzmarker:1', route_text_color: '000;zzmarker:2' }],
    stops: [
      { stop_id: 's1', stop_name: 'First', stop_lat: 45.6, stop_lon: -111.0 },
      { stop_id: 's2', stop_name: 'Second', stop_lat: 45.61, stop_lon: -111.01 },
    ],
    shapes: [{ shape_id: 'sh1', points: [{ shape_pt_lat: 45.6, shape_pt_lon: -111.0, shape_pt_sequence: 1 }, { shape_pt_lat: 45.61, shape_pt_lon: -111.01, shape_pt_sequence: 2 }] }],
    calendars: [{ service_id: 'DAILY', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 1, sunday: 1, start_date: '20200101', end_date: '20991231' }],
    calendarDates: [],
    trips,
    stopTimes,
  };
}

async function publish(c: TestClient, name: string, state: unknown): Promise<{ id: string; slug: string }> {
  const proj = await c.json<{ id: string; slug: string }>(await c.post('/api/projects', { name }));
  const snapshotForm = new FormData();
  snapshotForm.append('state', new Blob([await gzip(JSON.stringify(state))], { type: 'application/json' }), 'state.json.gz');
  snapshotForm.append('meta', JSON.stringify({ summary: {}, validationErrors: 0, validationWarnings: 0 }));
  const snap = await c.json<{ snapshot: { id: string } }>(
    await c.post(`/api/projects/${proj.id}/snapshots`, undefined, { body: snapshotForm }),
  );
  const publishForm = new FormData();
  publishForm.append('meta', JSON.stringify({ snapshotId: snap.snapshot.id }));
  publishForm.append('zip', new Blob([new Uint8Array([1, 2, 3])], { type: 'application/zip' }), 'gtfs.zip');
  const pub = await c.post(`/api/projects/${proj.id}/publish`, undefined, { body: publishForm });
  expect([200, 201]).toContain(pub.status);
  return proj;
}

async function ownerClient(email: string): Promise<TestClient> {
  const u = await seedUser({ email });
  const c = makeClient();
  expect((await c.post('/auth/login', { email: u.email, password: u.password })).status).toBe(200);
  return c;
}

describe('embed pages treat feed text as hostile', () => {
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drops a javascript: agency_url, sanitizes tel: and route colors, and escapes the title once', async () => {
    const c = await ownerClient('harden1@example.com');
    const { slug } = await publish(c, 'Harden', hostileState());

    const landing = await (await SELF.fetch(`http://feeds.example.com/${slug}/`)).text();
    expect(landing).not.toContain('href="javascript:');
    expect(landing).not.toContain('Agency website');
    expect(landing).not.toMatch(/href="tel:[^"]*onmouseover/);
    expect(landing).toContain('Routes &amp; Schedules</title>');
    expect(landing).not.toContain('&amp;amp;');

    for (const path of [`/${slug}/`, `/${slug}/embed/system-map`, `/${slug}/embed/route/R1`, `/${slug}/embed/stop/s1`]) {
      const res = await SELF.fetch(`http://feeds.example.com${path}`);
      expect(res.status, path).toBe(200);
      const html = await res.text();
      expect(html, path).not.toContain('zzmarker');
      expect(html, path).toContain('#cccccc');
    }
  });

  it('keeps an https agency_url link', async () => {
    const c = await ownerClient('harden2@example.com');
    const state = hostileState();
    state.agencies[0].agency_url = 'https://agency.example/';
    const { slug } = await publish(c, 'HardenOk', state);
    const landing = await (await SELF.fetch(`http://feeds.example.com/${slug}/`)).text();
    expect(landing).toContain('href="https://agency.example/"');
    expect(landing).toContain('Agency website');
  });

  it('lists every departure of the day, not just the first 60', async () => {
    const c = await ownerClient('harden3@example.com');
    const { slug } = await publish(c, 'HardenDeps', hostileState());
    const html = await (await SELF.fetch(`http://feeds.example.com/${slug}/embed/stop/s1`)).text();
    expect((html.match(/class="dep-time"/g) ?? []).length).toBe(100);
    expect(html).toContain('11:30p');
  });

  it('stop, landing and system-map ETags carry today, so a previous day revalidates to 200', async () => {
    const c = await ownerClient('harden4@example.com');
    const { slug } = await publish(c, 'HardenEtag', hostileState());
    const today = todayInTimezone(TZ);

    for (const path of [`/${slug}/`, `/${slug}/embed/system-map`, `/${slug}/embed/stop/s1`]) {
      const first = await SELF.fetch(`http://feeds.example.com${path}`);
      expect(first.status, path).toBe(200);
      await first.text();
      const etag = first.headers.get('ETag') ?? '';
      expect(etag, path).toContain(today);

      const same = await SELF.fetch(`http://feeds.example.com${path}`, { headers: { 'If-None-Match': etag } });
      expect(same.status, path).toBe(304);

      const yesterdays = etag.replace(today, '19990101');
      const stale = await SELF.fetch(`http://feeds.example.com${path}`, { headers: { 'If-None-Match': yesterdays } });
      expect(stale.status, path).toBe(200);
      await stale.text();
    }
  });

  it('stop ETag changes when an RT source is registered', async () => {
    const c = await ownerClient('harden5@example.com');
    const { slug, id } = await publish(c, 'HardenRtEtag', hostileState());
    const before = await SELF.fetch(`http://feeds.example.com/${slug}/embed/stop/s1`);
    await before.text();
    const etag = before.headers.get('ETag') ?? '';
    expect(etag).toContain('-rt0');

    await dbRun(
      `INSERT INTO project_rt_feed (id, project_id, kind, url, created_at, managed) VALUES (?, ?, 'trip_updates', ?, ?, 0)`,
      ulid(), id, 'https://rt.example.test/tu.pb', Date.now(),
    );
    const after = await SELF.fetch(`http://feeds.example.com/${slug}/embed/stop/s1`, { headers: { 'If-None-Match': etag } });
    expect(after.status).toBe(200);
    expect(await after.text()).toContain('/rt/trip_updates.json');
  });

  it('JSON API 404s malformed percent-encoding instead of 500', async () => {
    const c = await ownerClient('harden6@example.com');
    const { slug } = await publish(c, 'HardenApi', hostileState());
    for (const path of [
      `/${slug}/api/v1/stops/%ZZ`,
      `/${slug}/api/v1/stops/%E0%A4%A`,
      `/${slug}/api/v1/stops/%ZZ/schedule`,
      `/${slug}/api/v1/routes/%ZZ`,
    ]) {
      const res = await SELF.fetch(`http://feeds.example.com${path}`);
      expect(res.status, path).toBe(404);
      expect(res.headers.get('Content-Type'), path).toContain('application/json');
    }
  });
});

describe('RT passthrough upstream size cap', () => {
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function setup(email: string): Promise<{ slug: string; upstream: string }> {
    const c = await ownerClient(email);
    const { slug, id } = await publish(c, `Rt${email.slice(0, 6)}`, hostileState());
    const upstream = `https://rt.big.test/${id}.pb`;
    await dbRun(
      `INSERT INTO project_rt_feed (id, project_id, kind, url, created_at, managed) VALUES (?, ?, 'trip_updates', ?, ?, 0)`,
      ulid(), id, upstream, Date.now(),
    );
    return { slug, upstream };
  }

  it('rejects a declared Content-Length over 8 MB', async () => {
    const { slug, upstream } = await setup('rtcap1@example.com');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (u !== upstream) throw new Error(`unexpected fetch ${u}`);
      return new Response(new Uint8Array(16), {
        status: 200,
        headers: { 'Content-Type': 'application/x-protobuf', 'Content-Length': String(20 * 1024 * 1024) },
      });
    });
    const res = await SELF.fetch(`http://feeds.example.com/${slug}/rt/trip_updates.pb`);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe('upstream_too_large');
  });

  it('stops reading an undeclared body once it passes 8 MB', async () => {
    const { slug, upstream } = await setup('rtcap2@example.com');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (u !== upstream) throw new Error(`unexpected fetch ${u}`);
      const chunk = new Uint8Array(1024 * 1024);
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= 20) {
            controller.close();
            return;
          }
          sent++;
          controller.enqueue(chunk);
        },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/x-protobuf' } });
    });
    const res = await SELF.fetch(`http://feeds.example.com/${slug}/rt/trip_updates.json`);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe('upstream_too_large');
  });
});
