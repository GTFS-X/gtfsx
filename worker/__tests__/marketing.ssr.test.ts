// SEO routing for marketing pages: legacy-alias 301 redirects and the
// /pricing + /demo SSR injection. See worker/index.ts and worker/marketing/ssr.ts.

import { describe, it, expect } from 'vitest';
import { makeClient, locationPath } from './_client';

const client = makeClient();

describe('legacy-alias 301 redirects', () => {
  const cases: Array<[string, string]> = [
    ['/quickstart', '/docs/quick-start/'],
    ['/gtfs-flex', '/learn/gtfs-flex/'],
    ['/what-is-gtfs', '/learn/gtfs/'],
  ];

  for (const [from, to] of cases) {
    it(`301s ${from} → ${to}`, async () => {
      const res = await client.get(from, { redirect: 'manual' });
      expect(res.status).toBe(301);
      expect(locationPath(res)).toBe(to);
    });

    it(`301s ${from} with a trailing slash too`, async () => {
      const res = await client.get(`${from}/`, { redirect: 'manual' });
      expect(res.status).toBe(301);
      expect(locationPath(res)).toBe(to);
    });
  }

  it('preserves the query string on redirect', async () => {
    const res = await client.get('/quickstart?ref=newsletter', { redirect: 'manual' });
    expect(res.status).toBe(301);
    const loc = res.headers.get('Location') ?? '';
    expect(loc).toContain('/docs/quick-start/');
    expect(loc).toContain('ref=newsletter');
  });
});

describe('/pricing and /demo SSR', () => {
  it('serves a pricing-specific title and self-canonical', async () => {
    const res = await client.get('/pricing', { redirect: 'manual' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/<title>[^<]*Pricing[^<]*<\/title>/);
    expect(html).not.toContain('<title>GTFS·X – GTFS Builder and Editor</title>');
    expect(html).toContain('href="http://127.0.0.1/pricing/"');
  });

  it('serves a demo-specific title and self-canonical', async () => {
    const res = await client.get('/demo', { redirect: 'manual' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/<title>[^<]*Demo[^<]*<\/title>/);
    expect(html).toContain('href="http://127.0.0.1/demo/"');
  });

  it('includes Product structured data on /pricing', async () => {
    const res = await client.get('/pricing');
    const html = await res.text();
    expect(html).toContain('"@type":"Product"');
  });
});
