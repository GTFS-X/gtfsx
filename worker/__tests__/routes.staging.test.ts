// Staging hosts must stay out of search indexes: the Worker serves a
// Disallow-all robots.txt and stamps X-Robots-Tag: noindex on every response
// when APP_ORIGIN points at staging. Prod is unaffected. See worker/index.ts.

import { afterEach, describe, expect, it } from 'vitest';
import { makeClient } from './_client';
import { env } from './_setup';

const client = makeClient();
const ORIG = (env as { APP_ORIGIN?: string }).APP_ORIGIN;

afterEach(() => {
  (env as { APP_ORIGIN?: string }).APP_ORIGIN = ORIG;
});

describe('staging is kept out of search indexes', () => {
  it('serves Disallow-all robots.txt + noindex header on staging', async () => {
    (env as { APP_ORIGIN?: string }).APP_ORIGIN = 'https://staging.gtfsx.com';
    const robots = await client.get('/robots.txt', { redirect: 'manual' });
    expect(robots.status).toBe(200);
    expect(await robots.text()).toContain('Disallow: /');
    expect(robots.headers.get('X-Robots-Tag')).toContain('noindex');
    // Every other staging response also carries the noindex header.
    const home = await client.get('/', { redirect: 'manual' });
    expect(home.headers.get('X-Robots-Tag')).toContain('noindex');
  });

  it('prod (non-staging APP_ORIGIN) does not add noindex to the homepage', async () => {
    (env as { APP_ORIGIN?: string }).APP_ORIGIN = 'https://www.gtfsx.com';
    const home = await client.get('/', { redirect: 'manual' });
    expect(home.headers.get('X-Robots-Tag') ?? '').not.toContain('noindex');
  });
});
