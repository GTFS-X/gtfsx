// Soft-404 prevention. Unknown URLs must return a real HTTP 404 (the static
// 404.html), NOT the SPA shell with a 200 — otherwise Googlebot indexes dead
// URLs as soft-404s. Known client-side routes must still get the shell (200)
// so React Router can render them. See worker/index.ts (isSpaShellRoute +
// the catch-all) and wrangler.jsonc (assets.not_found_handling: "404-page").

import { describe, it, expect } from 'vitest';
import { makeClient } from './_client';

const client = makeClient();

const isShell = (html: string) => html.includes('id="root"');

describe('genuine misses return a real 404 (no soft-404 shell)', () => {
  const deadUrls = [
    '/this-page-does-not-exist-xyz/',
    '/docs/totally-made-up/',
    '/compare/nonexistent-competitor/',
    '/learn/not-a-real-guide/',
    '/some/deep/bogus/path',
  ];

  for (const url of deadUrls) {
    it(`404s ${url}`, async () => {
      const res = await client.get(url, { redirect: 'manual' });
      expect(res.status).toBe(404);
      // The defining bug: a 404 must not be the 200 SPA shell.
      const html = await res.text();
      expect(isShell(html)).toBe(false);
    });
  }
});

describe('known client-side routes still get the SPA shell (200)', () => {
  // Routes with no pre-rendered HTML file that must fall back to index.html.
  // /community/* is intentionally excluded here (it hits the forum SSR + D1).
  const spaRoutes = ['/login', '/signup', '/feeds', '/account', '/import', '/help', '/upgrade'];

  for (const route of spaRoutes) {
    it(`serves the shell for ${route}`, async () => {
      const res = await client.get(route, { redirect: 'manual' });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(isShell(html)).toBe(true);
    });
  }
});

describe('real pages are unaffected', () => {
  it('serves the homepage shell at /', async () => {
    const res = await client.get('/', { redirect: 'manual' });
    expect(res.status).toBe(200);
    expect(isShell(await res.text())).toBe(true);
  });

  it('serves a pre-rendered static page at /about/', async () => {
    const res = await client.get('/about/', { redirect: 'manual' });
    expect(res.status).toBe(200);
  });
});

describe('private/functional shell routes are noindex; content pages are not', () => {
  // /import was the URL flagged as a Soft 404 in Search Console.
  const noindexRoutes = ['/import', '/login', '/signup', '/account', '/feeds', '/upgrade'];
  for (const route of noindexRoutes) {
    it(`sends X-Robots-Tag: noindex for ${route}`, async () => {
      const res = await client.get(route, { redirect: 'manual' });
      expect(res.status).toBe(200);
      expect(res.headers.get('X-Robots-Tag')).toContain('noindex');
    });
  }

  // Content pages served via the shell must stay indexable.
  it('does NOT noindex /help (a real content page in the sitemap)', async () => {
    const res = await client.get('/help', { redirect: 'manual' });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Robots-Tag') ?? '').not.toContain('noindex');
  });

  it('does NOT noindex the homepage /', async () => {
    const res = await client.get('/', { redirect: 'manual' });
    expect(res.headers.get('X-Robots-Tag') ?? '').not.toContain('noindex');
  });
});
