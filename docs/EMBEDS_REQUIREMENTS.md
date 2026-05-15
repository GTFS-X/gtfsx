# GTFS Studio — Embeds Reference

Reference + future-work tracker for the rider-facing render layer (mini-site landing, per-route embed, per-stop embed, system map embed, demo agency page). The high-level overview lives in [`REQUIREMENTS.md`](./REQUIREMENTS.md) §4.4. The phases that motivated the original spec — mini-site MVP (7a), iframe embeds (7b), branding + brand color (7d) — are shipped on staging; this file keeps the underlying research findings and the unbuilt-phase backlog.

`EM-*` numbers are anchors that the codebase and other docs may reference; they're preserved even where the corresponding feature shipped.

---

## 1. Why this exists (research findings)

A survey of five small-agency websites (Streamline / Bozeman MT, Mountain Line / Missoula MT, Mountain Express / Crested Butte CO, Skagit Transit / WA, Park City Transit / UT) grounded the original spec. Patterns:

| Pattern | Observed at | Problem |
|---|---|---|
| Schedules ship as PDF only | Streamline, Mountain Line, Mountain Express | Drifts out of sync with the GTFS feed; not screen-readable; bad on mobile; impossible to deep-link. |
| Route map is a static image or absent | Streamline (image), Mountain Line (no map) | No way to see "where does Route 4 go relative to my address?" without leaving the agency site. |
| Service variants live in separate PDFs | All five | Riders open the wrong one. Effective dates buried in filenames. |
| Detours/holiday adjustments live on a separate Alerts page | Streamline, Mountain Line | The rider on the schedule doesn't see "this Friday is a Sunday schedule." |
| Trip planning offloaded to third-party app | Park City, Skagit, Streamline | Agencies lose visitors. |
| Real-time only in apps, not the website | Streamline, Mountain Line, Mountain Express | Riders without the app are out of luck. |
| Best-in-class small-agency reference | Skagit Transit | Integrated realtime map + trip planner — but they paid a vendor. Embeds give every agency that capability for free. |

**Net:** the gap isn't "build a fancier trip planner." It's that the canonical schedule (GTFS) and the rider-facing website are maintained separately, so the website is always stale. Embedding fixes that at the source.

---

## 2. Architecture (as built)

Server-rendered HTML on the FEEDS origin, edge-cached, version-id ETag, same renderer powers all surfaces. Hono `html` template tag, no SSR machinery to maintain. Mapbox GL JS via CDN for the map; tile token bound to the Worker as `MAPBOX_TOKEN`.

```
feeds.gtfsstudio.net/<slug>/                          # mini-site landing (indexable)
feeds.gtfsstudio.net/<slug>/embed/system-map          # system overview embed
feeds.gtfsstudio.net/<slug>/embed/route/<route_id>    # per-route map + schedule
feeds.gtfsstudio.net/<slug>/embed/stop/<stop_id>      # per-stop "departures today"
feeds.gtfsstudio.net/_/orgs/<org_id>/logo             # public org-logo bytes (CORS open)
```

Cross-cutting headers: `Content-Security-Policy: frame-ancestors *` on embeds (publicly framable), `frame-ancestors 'none'` on the mini-site landing (canonical destination, anti-clickjacking). `X-Robots-Tag: noindex` on the embeds (don't outrank the host page); the landing is indexable.

`worker/embeds/` modules:

- `loader.ts` — D1 publication lookup → R2 state.json.gz fetch → ungzip → parsed `FeedState`.
- `services.ts` — service-day grouping (Weekday / Saturday / Sunday / custom; split by date range when patterns repeat across seasons), today-in-agency-tz pick.
- `schedule.ts` — schedule-table renderer (longest-trip canonical stop order, after-midnight times annotated, sticky stop-name column).
- `map.ts` — Mapbox config + GeoJSON for shapes + stops + popup markup.
- `layout.ts` — shared HTML scaffold, brand-color CSS variables, social meta.
- `route.ts`, `stop.ts`, `systemMap.ts`, `landing.ts` — the four page renderers.

---

## 3. Capability snapshot

(Full version with status markers in [`REQUIREMENTS.md`](./REQUIREMENTS.md) §4.4.)

Shipped:

- ✅ EM-1/2/3 — mini-site landing with system overview, today's-service banner, effective date strip, expiry warning when ≤14 days from `feed_end_date`.
- ✅ EM-10/11/12/13 — per-route page: header, map, schedule tables per direction, service-day tabs (split by date range when needed).
- ✅ EM-15/16/17/18 — per-stop page: header, map, "departures today," routes-serving list. Map dot popups link to the per-stop page.
- ✅ EM-20/21/22/23 — server-rendered HTML, semantic markup, Open Graph + Twitter card meta, canonical URLs, sitemap-ready.
- ✅ EM-30/31/32/33/34 — iframe embed pattern: any URL above is iframe-friendly; `frame-ancestors *`; query params for `theme`, `service`, `version`; auto-resize via `postMessage` heartbeat.
- ✅ EM-60/61 (partial) — per-org brand logo upload + per-project brand color, applied via CSS custom property `--brand` on every embed surface.
- ✅ EM-80/81/83 — service-day logic + expiry warning.
- ✅ EM-100..103 — performance: critical CSS inlined, Mapbox tiles lazy-loaded, edge-cached.
- ✅ EM-110..115 — accessibility baseline: WCAG 2.1 AA target, semantic `<th scope=…>` on schedule tables, color-contrast checks, screen-reader announcements on tab changes.
- ✅ EM-120..123 — privacy: no third-party analytics, `Permissions-Policy: interest-cohort=()`, `Referrer-Policy: strict-origin-when-cross-origin`.
- ✅ EM-130/132 — Editor "Embed" bottom-tab with copy-pasteable iframe snippets per route + system map and a brand-color picker.

Not yet built (planned phases):

- 🔲 **EM-40..44 (Phase 7c) — Web-component / `widgets.js` loader.** Declarative `<gtfs-route-map>`, `<gtfs-schedule>`, etc.; shadow DOM scoping; <25 KB gzipped budget. The iframe pattern works today; the loader is a polish-up for agencies that want in-page DOM rather than iframes.
- 🔲 **EM-50..53 (Phase 7e) — Headless JSON API at `feeds.*/<slug>/api/*`.** Public read-only routes JSON / route detail / stop departures / alerts. Caching + CORS already designed for it.
- 🔲 **EM-60 logo + custom CSS variables** — logo is shipped (per-org). Custom CSS knobs for advanced theming are deferred.
- 🔲 **EM-65..67 (localization)** — UI strings, `?lang=` param, `translations.txt` consumption. English only for now; Spanish queued (Streamline already publishes Spanish PDFs).
- 🔲 **EM-82 (alerts integration)** — free-text alerts entered in the editor (or pulled from a registered GTFS-RT alerts feed per BE-89) shown on relevant route/stop pages.
- 🔲 **EM-131 (per-widget impression counts)** — `embed_view_count` rollup, agency-facing usage view.
- 🔲 **EM-90 (Phase 7f stretch) — GTFS-RT integration.** Live arrival times on stop pages and "next bus" indicators on the system map. Reads from a project's registered RT feed URL (BE-87); we don't host RT.
- 🔲 **EM-135 (admin dashboard)** — total embed impressions, top-N most-embedded agencies. Just numbers, no per-rider data.

Deferred (deliberately out of scope):

- 🚫 In-app trip planning. Riders use Transit / Google / Apple; we deep-link.
- 🚫 Fare purchase / account-linked fare products.
- 🚫 Native mobile apps. Mini-site PWA install is the path.
- 🚫 Per-route comments, ratings, community.
- 🚫 Custom domains for the mini-site (same rationale as BACKEND_REQUIREMENTS §5.3).
- 🚫 GTFS-RT hosting. We coordinate, we don't generate.
- 🚫 Advertising / sponsored content.

---

## 4. Open questions

These came up during initial design; the answers chosen at implementation time are noted. Worth re-visiting if usage scale changes the calculus.

1. **Map tile costs.** Mapbox is generous on the free tier but a popular agency could cross it. Today: we use the same publishable token across editor + embeds. If a single agency embed becomes high-traffic, options are (a) cap views and switch to OSM tiles past a threshold, (b) require per-agency Mapbox tokens, (c) absorb cost as part of the RTAP licensing model.
2. **Branding logo image processing.** Today we store the upload as-is (PNG/JPEG/WebP/SVG, ≤1 MB). Cloudflare Image Resizing could compose responsive variants on-demand; not worth the complexity until we see real usage.
3. **Embed default — always-latest vs version-pinned.** Decision: always-latest, with `?version=<id>` opt-in for testing. The whole point is to remove drift; version-pinning by default would re-introduce the staleness we're solving for.
4. **Multi-agency feeds.** A regional org publishes one feed for three agencies (multi-`agency_id`). Today the mini-site shows the first agency's name and a single system map. Per-agency picker is queued behind the localization work since both touch `agency.txt` rendering.
