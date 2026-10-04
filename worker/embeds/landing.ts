import { html } from 'hono/html';
import type { Env } from '../env';
import { loadEmbedFeed } from './loader';
import { renderLayout, embedFooter } from './layout';
import { buildSystemMapData, renderMap } from './map';
import { renderExpiryWarning } from './route';
import {
  activeServicesOn,
  buildServiceProfiles,
  dayOfWeekInTimezone,
  expiredProfileIds,
  pickDefaultProfile,
  todayInTimezone,
} from './services';
import { safeHex, safeLinkHref, safeTelHref } from './safe';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Mini-site landing page at /<slug>/. Server-rendered, indexable HTML
 * intended as the destination an agency 301s their old route page to.
 *
 * Differs from /<slug>/embed/system-map (which is iframe-friendly):
 * - No `noindex`; SEO friendly (Open Graph + structured data)
 * - More spacious chrome and an explicit today's-service banner
 * - frame-ancestors 'none' so the canonical view can't be clickjacked
 */
export async function renderLandingPage(
  request: Request,
  env: Env,
  slug: string,
): Promise<Response> {
  const feed = await loadEmbedFeed(env, slug);
  if (!feed) return new Response('Feed not found', { status: 404 });

  const url = new URL(request.url);
  const agency = feed.state.agencies[0];
  const tz = agency?.agency_timezone;
  // The body depends on today's date (banner, active services, expiry), so
  // the ETag carries it: a 304 must never revalidate yesterday's page.
  const today = todayInTimezone(tz);
  const etag = `"${feed.snapshotId}-landing-${today}"`;
  const ifNoneMatch = request.headers.get('If-None-Match');
  if (ifNoneMatch && ifNoneMatch.includes(etag)) {
    const headers = landingHeaders(etag, feed.publishedAt);
    return new Response(null, { status: 304, headers });
  }

  const dow = dayOfWeekInTimezone(tz);
  const dayName = DAY_NAMES[dow] ?? '';
  const activeToday = activeServicesOn(today, dow, feed.state.calendars, feed.state.calendarDates);
  const profiles = buildServiceProfiles(feed.state.calendars);
  // Expiry-aware for the same reason the route embed is (#71): this banner
  // names a schedule as being "in effect", and it must not name a dead one.
  const profileExpiry = expiredProfileIds(profiles, feed.state.calendarDates, today);
  const defaultProfile = pickDefaultProfile(profiles, activeToday, profileExpiry);
  const expiryWarning = renderExpiryWarning(feed.state.feedInfo?.feed_end_date, today);

  const data = buildSystemMapData(feed.state, slug);
  const map = renderMap(data, env.MAPBOX_TOKEN);

  const agencyName = agency?.agency_name ?? feed.projectName;
  // Feed text: only http(s) links and dialable digits reach an href.
  const agencyUrl = safeLinkHref(agency?.agency_url);
  const agencyPhone = agency?.agency_phone ?? null;
  const agencyTel = safeTelHref(agencyPhone);

  const todayBanner =
    activeToday.size === 0 || !defaultProfile
      ? html`<div class="today-banner muted" role="status">
          <span class="dot"></span>
          <span><strong>Today is ${dayName}</strong> <span class="sep">·</span> No service today</span>
        </div>`
      : html`<div class="today-banner" role="status">
          <span class="dot"></span>
          <span>
            <strong>Today is ${dayName}</strong>
            <span class="sep">·</span>
            ${defaultProfile.label} schedule in effect
          </span>
        </div>`;

  const routeLinks = feed.state.routes
    .slice()
    .sort((a, b) => {
      const an = a.route_short_name || a.route_id;
      const bn = b.route_short_name || b.route_id;
      return an.localeCompare(bn, undefined, { numeric: true });
    })
    .map((r) => {
      const color = `#${safeHex(r.route_color, 'cccccc')}`;
      const text = `#${safeHex(r.route_text_color, '000000')}`;
      const short = r.route_short_name || r.route_id;
      return html`
        <a href="/${encodeURIComponent(slug)}/embed/route/${encodeURIComponent(r.route_id)}">
          <span class="route-badge" style="background: ${color}; color: ${text};">${short}</span>
          <span class="name">${r.route_long_name}</span>
        </a>
      `;
    });

  // Plain text: renderLayout escapes it.
  const titleText = `${agencyName} — Routes & Schedules`;
  const description = `Routes, schedules, and stops for ${agencyName}. ${feed.state.routes.length} routes serving ${feed.state.stops.length} stops.`;

  const body = html`
    <header class="embed-header landing-header">
      ${feed.brandLogoUrl
        ? html`<img class="brand-logo" src="${feed.brandLogoUrl}" alt="${agencyName} logo" />`
        : ''}
      <div>
        <h1>${agencyName}</h1>
        <div class="effective">
          ${feed.state.routes.length} route${feed.state.routes.length === 1 ? '' : 's'} ·
          ${feed.state.stops.length} stop${feed.state.stops.length === 1 ? '' : 's'}
          ${agencyPhone ? (agencyTel ? html` · <a href="${agencyTel}">${agencyPhone}</a>` : html` · ${agencyPhone}`) : ''}
          ${agencyUrl ? html` · <a href="${agencyUrl}" target="_blank" rel="noopener">Agency website</a>` : ''}
        </div>
      </div>
    </header>
    ${expiryWarning}
    ${todayBanner}
    ${map}
    <h3>Routes</h3>
    <div class="route-list">${routeLinks}</div>
    <p class="landing-footnote">
      Click any stop on the map for upcoming departures.
    </p>
    ${embedFooter(feed.ownerPlan, agencyName)}
  `;

  const thumbUrl =
    feed.thumbnailVersion > 0
      ? `${env.FEEDS_ORIGIN.replace(/\/$/, '')}/${encodeURIComponent(slug)}/thumbnail.png?v=${feed.thumbnailVersion}`
      : undefined;

  const html5 = await renderLayout({
    title: titleText,
    social: {
      title: titleText,
      description,
      url: url.toString(),
      imageUrl: thumbUrl,
      imageWidth: thumbUrl ? 1200 : undefined,
      imageHeight: thumbUrl ? 630 : undefined,
    },
    bodyClass: 'landing',
    noindex: false,
    brandColor: feed.brandPrimaryColor,
    body: await body,
  });
  return new Response(String(html5), { status: 200, headers: landingHeaders(etag, feed.publishedAt) });
}

function landingHeaders(etag: string, publishedAt: number): Headers {
  const h = new Headers();
  h.set('Content-Type', 'text/html; charset=utf-8');
  h.set('ETag', etag);
  h.set('Last-Modified', new Date(publishedAt).toUTCString());
  // Canonical, indexable; frame-ancestors 'none' to prevent clickjacking
  // of this top-level destination (embeds use 'frame-ancestors *').
  h.set('Content-Security-Policy', "frame-ancestors 'none';");
  h.set('Cache-Control', 'public, max-age=300, s-maxage=3600');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return h;
}
