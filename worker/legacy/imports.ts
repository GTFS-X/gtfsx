import type { Env } from '../env';
import { getMobilityDbAccessToken } from '../distribution/mobility';

// ─── Mobility Database catalog search ──────────────────────────────────────────

const ALLOWED_SEARCH_PARAMS = new Set([
  'provider', 'producer_url', 'country_code', 'subdivision_name',
  'municipality', 'limit', 'offset',
]);

export async function handleSearch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  const baseParams = new URLSearchParams();
  for (const [k, v] of url.searchParams) {
    if (ALLOWED_SEARCH_PARAMS.has(k) && k !== 'provider') baseParams.set(k, v);
  }
  if (!baseParams.has('limit')) baseParams.set('limit', '50');
  if (!baseParams.has('status')) baseParams.set('status', 'active');

  const providerTerm = (url.searchParams.get('provider') || '').trim();
  const upstreams: URL[] = [];
  if (providerTerm) {
    const byProvider = new URL('https://api.mobilitydatabase.org/v1/gtfs_feeds');
    baseParams.forEach((v, k) => byProvider.searchParams.set(k, v));
    byProvider.searchParams.set('provider', providerTerm);
    upstreams.push(byProvider);

    if (!baseParams.has('municipality')) {
      const byMunicipality = new URL('https://api.mobilitydatabase.org/v1/gtfs_feeds');
      baseParams.forEach((v, k) => byMunicipality.searchParams.set(k, v));
      byMunicipality.searchParams.set('municipality', providerTerm);
      upstreams.push(byMunicipality);
    }
  } else {
    const single = new URL('https://api.mobilitydatabase.org/v1/gtfs_feeds');
    baseParams.forEach((v, k) => single.searchParams.set(k, v));
    upstreams.push(single);
  }

  let token: string;
  try {
    token = await getMobilityDbAccessToken(env);
  } catch (err) {
    return new Response(`Mobility DB auth failed: ${(err as Error).message}`, {
      status: 502,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }
  const authHeaders = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  const responses = await Promise.all(
    upstreams.map((u) => fetch(u.toString(), { headers: authHeaders })),
  );
  const failed = responses.find((r) => !r.ok);
  if (failed) {
    return new Response(`Mobility DB ${failed.status}: ${await failed.text()}`, {
      status: 502,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }
  // Mobility Database feed shape — we trim to a known subset before
  // returning. Only the fields we forward are typed; the rest passes through.
  interface CatalogFeed {
    id: string;
    provider?: string;
    feed_name?: string;
    note?: string;
    country_code?: string;
    subdivision_name?: string;
    municipality?: string;
    locations?: unknown;
    source_info?: { producer_url?: string };
    latest_dataset?: {
      id?: string;
      hosted_url?: string;
      downloaded_at?: string;
    };
  }
  const feedArrays = (await Promise.all(responses.map((r) => r.json()))) as CatalogFeed[][];
  const seen = new Set<string>();
  const feeds: CatalogFeed[] = [];
  for (const arr of feedArrays) {
    if (!Array.isArray(arr)) continue;
    for (const f of arr) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      feeds.push(f);
    }
  }
  const trimmed = (Array.isArray(feeds) ? feeds : []).map((f) => ({
    id: f.id,
    provider: f.provider,
    feed_name: f.feed_name,
    note: f.note,
    country_code: f.country_code,
    subdivision_name: f.subdivision_name,
    municipality: f.municipality,
    locations: f.locations,
    source_info: f.source_info && { producer_url: f.source_info.producer_url },
    latest_dataset: f.latest_dataset && {
      id: f.latest_dataset.id,
      hosted_url: f.latest_dataset.hosted_url,
      downloaded_at: f.latest_dataset.downloaded_at,
    },
  }));
  return new Response(JSON.stringify({ results: trimmed }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600, s-maxage=3600',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// The former /_import/proxy ZIP download proxy was removed: catalog downloads
// go through the hardened /api/import/fetch (worker/import/routes.ts).
