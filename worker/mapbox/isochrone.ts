// Authenticated proxy for the Mapbox Isochrone API.
//
// Network walksheds (Coverage) and transit access isochrones both need one
// Mapbox walking isochrone per distinct stop coordinate, and every call is
// billed to GTFS·X's Mapbox account. Since Oct 2026 those features are free on
// every plan but require a signed-in account, so the browser no longer calls
// Mapbox directly: it calls GET /api/mapbox/isochrone, which is mounted behind
// requireAuth. Anonymous requests get 401 before any upstream call is made.
//
// Only the walking profile and a single contour are supported: that's all the
// client uses, and a narrow surface keeps this from becoming a general-purpose
// Mapbox relay. Responses are cached at the edge (keyed WITHOUT the token) so a
// repeated analysis of the same stops doesn't re-bill.

import { Hono } from 'hono';
import type { AppContext, Env } from '../env';
import { requireAuth } from '../auth/middleware';
import { badGateway, validationFailed } from '../util/errors';
import { rateLimit } from '../util/rateLimit';

// Coordinates are normalized to 5 dp (≈ 1 m) for the edge cache key. The client
// already rounds to 3 dp before calling, so in practice keys collapse further.
const COORD_DP = 5;
const MAX_MINUTES = 60;
const CACHE_TTL_SEC = 30 * 24 * 60 * 60;
const UPSTREAM_TIMEOUT_MS = 15_000;
export const ISOCHRONE_MISSES_PER_HOUR = 1000;

function parseCoord(raw: string | undefined, min: number, max: number): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return Number(n.toFixed(COORD_DP));
}

function parseMinutes(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d{1,2}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= MAX_MINUTES ? n : null;
}

// The Mapbox token is URL-restricted to gtfsx.com origins, so a server-side
// request must present an allowed Referer (same approach as embeds/thumbnail).
function upstreamFetch(url: string, env: Env, signal: AbortSignal): Promise<Response> {
  const referer = (env.APP_ORIGIN || 'https://www.gtfsx.com').replace(/\/$/, '') + '/';
  return fetch(url, { headers: { Referer: referer }, signal });
}

export const mapboxRouter = new Hono<AppContext>();

mapboxRouter.get('/isochrone', requireAuth, async (c) => {
  const lon = parseCoord(c.req.query('lon'), -180, 180);
  const lat = parseCoord(c.req.query('lat'), -90, 90);
  const minutes = parseMinutes(c.req.query('contours_minutes'));
  if (lon === null || lat === null || minutes === null) {
    throw validationFailed('lon, lat and contours_minutes (1–60) are required');
  }
  const token = c.env.MAPBOX_TOKEN;
  if (!token) throw badGateway('Isochrone service is not configured');

  // Edge cache keyed on the normalized request (never the token).
  const cacheKey = new Request(
    `https://isochrone-cache.gtfsx.internal/walking/${lon},${lat}?m=${minutes}`,
  );
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const hit = cache ? await cache.match(cacheKey) : undefined;
  if (hit) {
    return new Response(hit.body, {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=86400', 'X-Cache': 'HIT' },
    });
  }

  // Per-account cap on BILLED (cache-miss) upstream calls, so one signed-in
  // account can't turn the proxy into an unmetered Mapbox relay. Sized for
  // ~5 full uncached analyses an hour (the client caps one analysis at
  // MAX_ISOCHRONE_REQUESTS = 200); cache hits above don't count.
  await rateLimit(c.env, {
    key: `mapbox:iso:${c.var.user!.id}`,
    limit: ISOCHRONE_MISSES_PER_HOUR,
    windowSec: 3600,
  });

  const url =
    `https://api.mapbox.com/isochrone/v1/mapbox/walking/${lon},${lat}` +
    `?contours_minutes=${minutes}&polygons=true&denoise=1&access_token=${encodeURIComponent(token)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await upstreamFetch(url, c.env, controller.signal);
  } catch {
    throw badGateway('Isochrone service did not respond');
  } finally {
    clearTimeout(timer);
  }
  if (!upstream.ok) {
    // Pass rate limiting through so the client can show a sensible notice;
    // everything else is an upstream failure from the client's point of view.
    if (upstream.status === 429) {
      return c.json({ error: 'rate_limited', message: 'Isochrone service is busy — try again shortly' }, 429);
    }
    throw badGateway(`Isochrone service returned ${upstream.status}`);
  }
  const body = await upstream.text();
  if (cache) {
    c.executionCtx.waitUntil(
      cache.put(
        cacheKey,
        new Response(body, {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_TTL_SEC}` },
        }),
      ),
    );
  }
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=86400', 'X-Cache': 'MISS' },
  });
});
