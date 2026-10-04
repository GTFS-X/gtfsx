// Feed data (stop names, ids, labels) interpolated into inline <script>
// blocks on the feeds origin must not be able to end the script element.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import { makeClient } from './_client';
import {
  applyMigrations,
  gzip,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';
import { escapeJsonForScript, safeJsonForScript } from '../util/safeJson';

describe('safeJsonForScript', () => {
  it('escapes <, >, &, U+2028 and U+2029 and round-trips to the same value', () => {
    const value = { name: 'a</script><script>x()</script>&<!--\u2028\u2029', n: 1, list: ['<b>'] };
    const out = safeJsonForScript(value);
    expect(out).not.toMatch(/[<>&\u2028\u2029]/);
    expect(out).toContain('\\u003c/script\\u003e');
    expect(JSON.parse(out)).toEqual(value);
    expect(new Function(`return ${out};`)()).toEqual(value);
  });

  it('handles undefined as null and leaves plain JSON untouched', () => {
    expect(safeJsonForScript(undefined)).toBe('null');
    expect(safeJsonForScript({ a: [1, 'b'] })).toBe('{"a":[1,"b"]}');
    expect(escapeJsonForScript('"a\\\\<"')).toBe('"a\\\\\\u003c"');
  });
});

describe('embed + landing pages escape feed data in inline scripts', () => {
  let capture: EmailCapture;
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });
  afterEach(() => capture.restore());

  it('a stop_name containing a closing script tag stays inside the script', async () => {
    const u = await seedUser({ email: 'feedowner-esc@example.com' });
    const c = makeClient();
    expect((await c.post('/auth/login', { email: u.email, password: u.password })).status).toBe(200);
    const proj = await c.json<{ id: string; slug: string }>(await c.post('/api/projects', { name: 'EscFeed' }));
    const evilName = 'Main St</script><script>window.__pwn=1</script>';
    const state = {
      feedInfo: { feed_publisher_name: 'EmbedAgency', feed_start_date: '20260101', feed_end_date: '20261231' },
      agencies: [{ agency_id: 'a1', agency_name: 'Embed Agency', agency_url: 'https://x.test', agency_timezone: 'America/Denver' }],
      routes: [{ route_id: 'R1', agency_id: 'a1', route_short_name: '1', route_long_name: 'Downtown', route_type: 3, route_color: '8e44ad', route_text_color: 'ffffff' }],
      stops: [
        { stop_id: 's1', stop_name: evilName, stop_lat: 45.6, stop_lon: -111.0 },
        { stop_id: 's2', stop_name: 'Main & 2nd', stop_lat: 45.61, stop_lon: -111.01 },
      ],
      shapes: [{ shape_id: 'sh1', points: [{ shape_pt_lat: 45.6, shape_pt_lon: -111.0, shape_pt_sequence: 1 }, { shape_pt_lat: 45.61, shape_pt_lon: -111.01, shape_pt_sequence: 2 }] }],
      calendars: [{ service_id: 'DAILY', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 1, sunday: 1, start_date: '20260101', end_date: '20261231' }],
      calendarDates: [],
      trips: [{ trip_id: 't1', route_id: 'R1', service_id: 'DAILY', direction_id: 0, shape_id: 'sh1', trip_headsign: 'Downtown' }],
      stopTimes: [
        { trip_id: 't1', arrival_time: '08:00:00', departure_time: '08:00:00', stop_id: 's1', stop_sequence: 1 },
        { trip_id: 't1', arrival_time: '08:05:00', departure_time: '08:05:00', stop_id: 's2', stop_sequence: 2 },
      ],
    };
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

    const paths = [
      `/${proj.slug}/embed/system-map`,
      `/${proj.slug}/`,
      `/${proj.slug}/embed/route/R1`,
      `/${proj.slug}/embed/stop/s1`,
    ];
    for (const path of paths) {
      const res = await SELF.fetch(`http://feeds.example.com${path}`);
      expect(res.status, path).toBe(200);
      const html = await res.text();
      expect(html, path).not.toContain('</script><script>window.__pwn=1</script>');
      expect(html, path).not.toContain('<script>window.__pwn=1');
    }
  });
});
