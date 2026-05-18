# Domain + brand migration — `gtfsstudio.net` → `gtfsx.com` (GTFS·X rebrand)

Started 2026-05-18. Working runbook — update the checkboxes as steps complete.

## Decisions

| Decision | Choice |
|---|---|
| Brand name | "GTFS·X" (middle dot, U+00B7). Was "GTFS Studio". Spoken: "G-T-F-S X". |
| Canonical domain | `gtfsx.com` (was `gtfsstudio.net`). |
| Cutover style | Parallel — `gtfsstudio.net`, `gtfsstudio.com`, and `gtfsbuilder.net` stay bound to the Worker indefinitely and 301 to the matching `gtfsx.com` host. Preserves `feeds.gtfsstudio.net/<slug>/gtfs.zip` URLs already polled by downstream consumers (which themselves are the post-rebrand replacements for the original `feeds.gtfsbuilder.net` URLs). |
| Email sending domain | `gtfsx.com`. Subdomain `mail.gtfsx.com` optional. |
| Stripe webhooks | Add new endpoint on the new domain. Keep the old endpoint running until cutover is verified, then remove. |
| Tagline | Unchanged — "GTFS Builder and Editor". |

## Subdomain plan

| Purpose | Previous (canonical) | New (canonical) |
|---|---|---|
| Editor (apex + www) | `gtfsstudio.net`, `www.gtfsstudio.net` | `gtfsx.com`, `www.gtfsx.com` |
| Public feeds + embeds | `feeds.gtfsstudio.net` | `feeds.gtfsx.com` |
| Staging editor | `staging.gtfsstudio.net` | `staging.gtfsx.com` |
| Staging feeds | `staging-feeds.gtfsstudio.net` | `staging-feeds.gtfsx.com` |

Legacy hostnames still bound (all 301 to the matching `gtfsx.com` host with path + query preserved):

- `gtfsstudio.net`, `www.gtfsstudio.net`, `feeds.gtfsstudio.net`, `staging.gtfsstudio.net`, `staging-feeds.gtfsstudio.net`
- `gtfsstudio.com`, `www.gtfsstudio.com`, `staging.gtfsstudio.com`
- `gtfsbuilder.net`, `www.gtfsbuilder.net`, `feeds.gtfsbuilder.net`, `staging.gtfsbuilder.net`, `staging-feeds.gtfsbuilder.net`

---

## Execution order

Same shape as the prior `gtfsbuilder.net` → `gtfsstudio.net` runbook (`DOMAIN_MIGRATION.md`).

### Phase 1 — Buy + bind the domain (user) ✅

- [x] `gtfsx.com` registered and the DNS zone is active in Cloudflare (per user 2026-05-18).
- [x] Confirm zone shows "Active" in Cloudflare dashboard.

### Phase 2 — Prep code changes (Claude) — this branch

- [x] `wrangler.jsonc` — add `gtfsx.com` routes (prod + staging), promote to canonical, update `APP_ORIGIN`, `FEEDS_ORIGIN`, `AUTH_EMAIL_FROM` on both blocks.
- [x] `worker/index.ts` — redirect `gtfsstudio.net`/`gtfsstudio.com`/`gtfsbuilder.net` → corresponding `gtfsx.com` host.
- [x] `scripts/setup-stripe.ts` — webhook URLs + `RETURN_URL_BASE` + support email.
- [x] `scripts/dev-seed-user.ts` — dev origin.
- [x] `worker/email/index.ts` — sender footer + brand name.
- [x] `worker/embeds/{landing,route,stop,systemMap}.ts` — "Powered by …" footer link in 4 embed templates.
- [x] `worker/forum/{seo,notify,dispatcher}.ts` — community brand name and fallback origin.
- [x] `worker/publication/feeds.ts`, `worker/legacy/imports.ts`, `worker/import/routes.ts` — fallback origins and User-Agent.
- [x] `src/components/layout/AppBrand.tsx` — swap logo + wordmark text.
- [x] `src/components/auth/{LoginPage,SignupPage}.tsx` — "from gtfsx.com" copy + subtitle.
- [x] `src/components/{billing/PricingPage,billing/WelcomePlanPage,embed/EmbedPanel,publication/PublishPanel}.tsx`, `src/services/orgsApi.ts` — example URLs + contact emails.
- [x] `src/components/community/{CommunityRoot,ProfileEditor}.tsx`, `src/components/help/HelpPage.tsx` — brand + logo.
- [x] `public/{about,docs,docs/quick-start,docs/deep-links,embed-demo,learn/gtfs,learn/gtfs-flex,privacy-policy}/index.html`, `index.html` — marketing pages + title/OG meta + canonical URLs.
- [x] `public/favicon.svg` + new `public/gtfsx-*.svg` brand assets dropped in alongside the legacy `gtfs-studio-logo.svg` (deprecated; still served for legacy deep-link buttons until ecosystem partners update).
- [x] `README.md`, `docs/*.md` (except `DOMAIN_MIGRATION.md` which stays as historical record).
- [ ] `tiles/cors.json` — R2 CORS allowed origins. Reviewed; needs no change if it already lists `*` or both old + new.

### Phase 3 — Cloudflare custom domains (Claude) ⏳

After Phase 1 zone is active and Phase 2 branch is ready:

- [ ] Run `wrangler deploy --env staging` against this branch. Wrangler binds the staging custom domains (`staging.gtfsx.com`, `staging-feeds.gtfsx.com`) and Cloudflare provisions edge certs (5–60 min).
- [ ] Confirm `https://staging.gtfsx.com` returns the SPA.
- [ ] Production custom domains will bind when we tag for prod in Phase 9.

### Phase 4 — Resend sending domain (user) ⏳

- [ ] In [Resend Dashboard](https://resend.com/domains), click **Add Domain** and enter `gtfsx.com`.
- [ ] Add the SPF, DKIM, and MX records Resend prints into the Cloudflare DNS zone for `gtfsx.com`:
  - `TXT` at the apex for SPF: `v=spf1 include:_spf.resend.com ~all`
  - `TXT` at `resend._domainkey` for DKIM (long value Resend provides)
  - Optional `MX` and DMARC
- [ ] Wait until Resend marks the domain as **Verified** (usually < 5 min on Cloudflare DNS).
- [ ] (Optional) Configure aliases for `noreply@gtfsx.com`, `support@gtfsx.com`, `sales@gtfsx.com`, `mark@gtfsx.com`.
- [ ] Keep the existing `gtfsstudio.net` Resend domain verified for the transition period. No emails are sent from `@gtfsstudio.net` after deploy (AUTH_EMAIL_FROM has flipped), but keeping it verified avoids ambiguity if we need to roll back.

### Phase 5 — Stripe (user) ⏳

- [ ] Run `uv run scripts/setup-stripe.ts` (staging) — registers staging webhook at `https://staging.gtfsx.com/api/billing/webhooks/stripe`.
- [ ] Run `uv run scripts/setup-stripe.ts --live` (prod) — registers prod webhook at `https://www.gtfsx.com/api/billing/webhooks/stripe` and updates portal return URL.
- [ ] Store new staging signing secret as `STRIPE_WEBHOOK_SIGNING_SECRET` worker secret on the staging env.
- [ ] Store new prod signing secret as `STRIPE_WEBHOOK_SIGNING_SECRET` worker secret on the prod env.
- [ ] Leave the old `gtfsstudio.net` Stripe webhook active during the transition; Stripe will keep retrying both endpoints. Delete in Phase 12.
- [ ] (Optional) Update **Branding** in Stripe Dashboard to reference `gtfsx.com`.

### Phase 6 — Cloudflare Turnstile (user) ⏳

- [ ] In Cloudflare Dashboard → **Turnstile**, edit the existing site.
- [ ] Add hostnames: `gtfsx.com`, `www.gtfsx.com`, `staging.gtfsx.com`.
- [ ] Leave existing `gtfsstudio.net`/`gtfsbuilder.net` hostnames in the list (transition period).
- [ ] No new secret needed — same site key works across all hostnames.

### Phase 7 — Mapbox (user) ⏳

- [ ] In [Mapbox Account → Access Tokens](https://account.mapbox.com/access-tokens/), click the public token.
- [ ] Under **URL allowlist**, add: `https://gtfsx.com/*`, `https://*.gtfsx.com/*`.
- [ ] Leave the old `gtfsstudio.net`/`gtfsbuilder.net` entries (transition period).
- [ ] Save.

### Phase 8 — Staging verification (Claude + user) ⏳

Once Phases 3–7 are done:

- [ ] Open `https://staging.gtfsx.com` in a fresh incognito window — Cloudflare cert provisioned, SPA loads with new brand.
- [ ] Sign up with a real email → Turnstile widget renders → verify-email arrives from `noreply@gtfsx.com` → click link → land in editor.
- [ ] Run the full `DEPLOY_BACKEND.md` §7 smoke test against the new domain.
- [ ] Hit `https://staging.gtfsx.com/?ref=rebrand-test`, check `/admin/events` shows the new ref.
- [ ] Stripe test-mode checkout → confirm the new webhook fires and updates `subscription` row in D1.
- [ ] On the old domain (`https://staging.gtfsstudio.net`) — verify 301 to `https://staging.gtfsx.com` with path + query preserved.
- [ ] Verify embed iframes on `embed-demo` page render against `staging-feeds.gtfsx.com`.

### Phase 9 — Production cutover (Claude) ⏳

- [ ] Merge `gtfsx-rebrand` → `main` via fast-forward.
- [ ] Tag `prod-YYYY-MM-DD` to trigger the prod deploy workflow.
- [ ] Confirm `https://www.gtfsx.com` serves the SPA (cert provisioning may take a few minutes after the deploy completes).

### Phase 10 — 301 redirect old → new (Claude) ✅ (bundled with Phase 2)

Same atomic pattern as the prior migration — the redirect block is part of `worker/index.ts` and ships in the same commit as the new routes.

- [x] Worker now redirects `gtfsstudio.net`, `gtfsstudio.com`, and `gtfsbuilder.net` (and every subdomain of each) → matching `gtfsx.com` host.
- [ ] Verify on staging post-deploy: `curl -I https://staging.gtfsstudio.net` → `301`, location `https://staging.gtfsx.com/`.
- [ ] Verify on prod post-deploy: `curl -I https://feeds.gtfsstudio.net/<slug>/gtfs.zip` → `301`, location `https://feeds.gtfsx.com/<slug>/gtfs.zip`.
- [ ] Verify the second-hop chain: `curl -IL https://feeds.gtfsbuilder.net/bozeman-demo/gtfs.zip` → 301 → 301 → 200 (gtfsbuilder.net → gtfsstudio.net → gtfsx.com is collapsed in the redirect logic; this should be a single hop to gtfsx.com).

### Phase 11 — Catalog notifications (user, async) — likely N/A

- [ ] No feeds were ever submitted to Mobility Database or transit.land under any prior brand (`gtfsbuilder.net` / `gtfsstudio.net`) — both integrations remain stubbed. Same applies here; no action needed unless a feed has been submitted in the interim.
- [ ] Update any external links you control: social profiles, README badges, agency partner sites.

### Phase 12 — Cleanup (Claude + user, deferred — months later) ⏳

When confident no traffic is hitting the old domains:

- [ ] Remove `gtfsstudio.net`/`gtfsstudio.com`/`gtfsbuilder.net` custom domain bindings from Cloudflare.
- [ ] Remove the redirect block from `worker/index.ts`.
- [ ] Remove old hostnames from Turnstile + Mapbox allowlists.
- [ ] Remove old Stripe webhook endpoints.
- [ ] Eventually: don't renew the old domains. (Or keep `gtfsstudio.com` / `gtfsbuilder.net` indefinitely for brand protection — cheap.)

---

## Rollback plan

If something goes wrong between Phase 9 and the redirect verification:

1. Revert the `gtfsx-rebrand` merge on `main`; tag a new `prod-…` to re-deploy the prior config. The old domains are still serving traffic.
2. The new `gtfsx.com` bindings can be left in place harmlessly.

If something goes wrong after the redirect is live:

1. Comment out the redirect block in `worker/index.ts` and re-deploy. Old domain serves the SPA directly again.
2. No data is at risk — D1 + R2 are domain-agnostic.

---

## Reference: hostname → service mapping after cutover

| Hostname | Bound to | Behavior |
|---|---|---|
| `gtfsx.com` / `www.gtfsx.com` | `gtfs-builder` Worker | SPA |
| `feeds.gtfsx.com` | `gtfs-builder` Worker | Public feeds + embeds |
| `staging.gtfsx.com` | `gtfs-builder-staging` Worker | SPA |
| `staging-feeds.gtfsx.com` | `gtfs-builder-staging` Worker | Public feeds + embeds |
| `gtfsstudio.net` (+ subdomains) | `gtfs-builder` / staging Worker | 301 → corresponding `gtfsx.com` host |
| `gtfsstudio.com` (+ subdomains) | `gtfs-builder` / staging Worker | 301 → corresponding `gtfsx.com` host |
| `gtfsbuilder.net` (+ subdomains) | `gtfs-builder` / staging Worker | 301 → corresponding `gtfsx.com` host |
