import { html } from 'hono/html';
import type { Env } from '../env';
import { loadEmbedFeed } from './loader';
import { embedHeaders, renderLayout } from './layout';
import { buildRouteMapData, renderMap } from './map';
import { renderScheduleTables } from './schedule';
import {
  activeServicesOn,
  buildServiceProfiles,
  dayOfWeekInTimezone,
  pickDefaultProfile,
  todayInTimezone,
  type ServiceProfile,
} from './services';

export async function renderRouteEmbed(
  request: Request,
  env: Env,
  slug: string,
  routeId: string,
): Promise<Response> {
  const feed = await loadEmbedFeed(env, slug);
  if (!feed) return new Response('Feed not found', { status: 404 });

  const route = feed.state.routes.find((r) => r.route_id === routeId);
  if (!route) return new Response('Route not found', { status: 404 });

  // ETag-aware short-circuit. Same version + same query → same bytes.
  const url = new URL(request.url);
  const requestedTab = url.searchParams.get('service');
  const ifNoneMatch = request.headers.get('If-None-Match');
  const etagBase = `"${feed.versionId}-${routeId}-${requestedTab ?? 'auto'}"`;
  if (ifNoneMatch && ifNoneMatch.includes(etagBase)) {
    const headers = embedHeaders(feed.versionId, feed.publishedAt);
    headers.set('ETag', etagBase);
    return new Response(null, { status: 304, headers });
  }

  const agency = feed.state.agencies[0];
  const tz = agency?.agency_timezone;
  const now = new Date();
  const today = todayInTimezone(tz, now);
  const dow = dayOfWeekInTimezone(tz, now);
  const activeToday = activeServicesOn(today, dow, feed.state.calendars, feed.state.calendarDates);

  const profiles = buildServiceProfiles(feed.state.calendars);
  const defaultProfile = pickDefaultProfile(profiles, activeToday);

  let selected: ServiceProfile | null = null;
  if (requestedTab) selected = profiles.find((p) => p.id === requestedTab) ?? null;
  if (!selected) selected = defaultProfile;

  const mapData = buildRouteMapData(route, feed.state);
  const map = renderMap(mapData, env.MAPBOX_TOKEN);

  const tabs = profiles.map((p) => {
    const active = selected && p.id === selected.id;
    const params = new URLSearchParams(url.search);
    params.set('service', p.id);
    return html`<a href="?${params.toString()}" class="${active ? 'active' : ''}">${p.label}</a>`;
  });

  const schedule = selected
    ? renderScheduleTables(route, new Set(selected.serviceIds), feed.state)
    : html`<p class="empty">No service patterns defined.</p>`;

  const routeColor = `#${route.route_color || 'cccccc'}`;
  const routeTextColor = `#${route.route_text_color || '000000'}`;
  const longName = route.route_long_name || '';
  const shortName = route.route_short_name || route.route_id;
  const effective =
    feed.state.feedInfo?.feed_start_date && feed.state.feedInfo?.feed_end_date
      ? `Schedule effective ${formatYmd(feed.state.feedInfo.feed_start_date)} – ${formatYmd(
          feed.state.feedInfo.feed_end_date,
        )}`
      : null;

  const body = html`
    <header class="embed-header">
      <span class="route-badge" style="background: ${routeColor}; color: ${routeTextColor};">${shortName}</span>
      <div>
        <h1>${longName || shortName}</h1>
        ${effective ? html`<div class="effective">${effective}</div>` : ''}
      </div>
    </header>
    ${map}
    ${profiles.length > 1
      ? html`<nav class="service-tabs" aria-label="Service day">${tabs}</nav>`
      : ''}
    ${schedule}
    <footer class="embed-footer">
      Powered by <a href="https://gtfsbuilder.net" target="_blank" rel="noopener">GTFS Builder</a>
      · ${agency?.agency_name ?? feed.projectName}
    </footer>
  `;

  const html5 = await renderLayout({
    title: `${shortName} ${longName} — ${agency?.agency_name ?? feed.projectName}`,
    body: await body,
  });

  const headers = embedHeaders(feed.versionId, feed.publishedAt);
  headers.set('ETag', etagBase);
  return new Response(String(html5), { status: 200, headers });
}

function formatYmd(ymd: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(parseInt(y, 10), parseInt(mo, 10) - 1, parseInt(d, 10)));
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date);
}
