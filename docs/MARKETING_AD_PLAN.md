# GTFS·X — Google Ads Readiness Plan

**Status:** Planning. Recommendations only.
**Author:** drafted with Claude, May 2026.

## 0. Premise

Two things in scope:

1. **Address the Search Console structured-data errors** flagged in the
   2026-05-25 email (Merchant Listings validator complaints — see §1).
2. **Sketch the site changes and content development** that would make a
   Google Ads campaign actually convert to paid plans, vs. just burning
   click budget.

## 1. Search Console errors — fixed

Google Search Console classified `/pricing/` as a Merchant Listing
because the page emitted `schema.org/Product` with an `offers[]` array.
The Merchant Listings validator then flagged it for missing physical-
product fields:

| Error | Severity | Cause |
|---|---|---|
| Missing `image` on Product | Critical | Required for merchant rich results |
| Missing `hasMerchantReturnPolicy` in Offers | Non-critical | Required for full merchant rich results |
| Missing `shippingDetails` in Offers | Non-critical | Required — SaaS doesn't ship |
| Missing `price` in Offers | Non-critical | Triggered by the Enterprise offer (invoice-only, no fixed price) |

**Fix shipped** (worker/marketing/ssr.ts): switched the pricing page's
JSON-LD from `@type: 'Product'` to `@type: 'SoftwareApplication'` —
which is what GTFS·X actually is — added an `image` (the logo),
`applicationCategory: 'BusinessApplication'` + `operatingSystem: 'Web'`,
and dropped the price-less Enterprise offer from the structured data
(it's still in the on-page marketing copy; just not in machine-readable
offers). The `/demo/` page was already using SoftwareApplication, so
this brings the two in line. Search Console re-validation typically
clears in 3-7 days.

Next-tier improvements once the basics validate:

- Add `aggregateRating` once we have credible reviews (e.g., G2 / Capterra signup).
- Add `screenshot` URLs pointing at editor screenshots — eligible for richer SoftwareApplication result cards.
- Consider adding a `BreadcrumbList` JSON-LD for navigation pages — currently we render the breadcrumb visually but don't mark it up.

## 2. The diagnosis: where Ads spend will leak today

| Issue | Why it matters for paid traffic |
|---|---|
| No purpose-built landing pages | Ads land on the editor (anonymous-first) or `/pricing/` (no above-the-fold value prop / no FAQ / no social proof). Quality Score suffers; bounce rate is high. |
| No conversion tracking | Without Google Ads conversion events fired on signup / first save / first publish, the campaign optimises blind. ROAS is unknowable. |
| Anonymous-first editor | The free editor works without signup. That's great for product UX but kills attribution — paid clicks bounce into editing, never become a tracked conversion. |
| Mobile UX still rough below 600 px | Ad clicks are heavily mobile; the editor is desktop-first. Mobile visitors who can't immediately do something useful leave. |
| No social proof anywhere | No customer logos, testimonials, agency names, "powering N feeds at M agencies" counters. Cold ad traffic distrusts unknown SaaS. |
| Comparison pages exist but don't anchor on Ads keywords | `vs. Remix`, `vs. Trillium` are good. Need `vs. spreadsheet`, `for paratransit`, `for university shuttles` to capture vertical ad intent. |
| No ROI / cost-savings framing | Remix is $20k+/yr, Agency is $3.6k/yr. The 5-6x savings story isn't told above the fold anywhere. |

## 3. Pre-launch site changes — ranked by ROI on ad spend

### Tier 1 — block-launch items (do these before turning on Ads)

1. **Google Ads conversion tracking + GA4 events.**
   - Install the gtag.js conversion pixel on the auth-success page (signup is the primary conversion).
   - Add secondary conversions on: first project save, first publish click, Stripe checkout-completed.
   - Wire to GA4 as Recommended Events so the data flows to the campaign optimizer.
   - Without this, you cannot run a conversion-optimised campaign. Period.

2. **Dedicated landing page(s) per ad campaign.**
   - One page per ad-group intent. Don't send "GTFS editor for agencies" ad clicks to the same URL as "publish GTFS feed for Mobility Database."
   - Pattern: `/lp/<campaign-slug>/` — focused above-the-fold value prop, one CTA (sign up / start free), inline social proof, FAQ below the fold, no nav distractions.
   - Three to start: `/lp/publish-gtfs/`, `/lp/transit-planning-tools/`, `/lp/gtfs-editor-for-agencies/`.

3. **Pricing-page rewrite — above the fold.**
   - Headline that names the buyer and the outcome ("Publish your transit feed in an afternoon. Plan service like Remix at 1/6 the price.")
   - 3-card pricing block (already there) but with the "most popular" badge on Pro (the network-effects bet from the May-2026 restructure), not Agency.
   - Single FAQ block below the fold (currently none): "Can I host the feed at my own URL?", "How does this compare to Remix?", "What if I outgrow Pro?", "Is there a free trial?", "Do you submit to the Mobility Database for me?"
   - Trust strip: "Built on the GTFS spec • Compatible with Google Transit • Used by [N] agencies" once we have real numbers to put there.

4. **Mobile UX audit on the marketing surface.**
   - Pricing page, pages under `/compare/*/`, and the home page all need to look good below 400 px wide. Editor itself can stay desktop-first; marketing cannot.
   - Acceptance criteria: any of those pages, viewed on iPhone, has tap-sized CTAs, no horizontal scroll, no >2-line headlines.

### Tier 2 — high-leverage content (ship before ad spend ramps)

5. **Vertical landing pages** — capture the long-tail ad intent that converts highest:
   - `/for/microtransit/` — frame around GTFS-Flex authoring, which is genuinely differentiated
   - `/for/university-shuttles/` — small ops with annual schedule changes; obvious fit for Pro
   - `/for/paratransit/` — same, plus the rural / RTAP angle
   - `/for/consultants/` — emphasise cross-org membership in Agency

6. **Mobility Database story.**
   - Single page: `/publish/mobility-database/` — explains the workflow, the value of being listed, links to live examples of feeds published through GTFS·X. This is the single feature that most directly differentiates the Pro tier from "just export a ZIP."

7. **ROI / cost comparison page or calculator.**
   - `/compare/cost/` — table comparing GTFS·X Agency ($3.6k/yr) to Remix (~$20k+/yr), Optibus (~$25k+/yr), Trillium (managed service, $5-10k+/yr). Honest about what each does that the others don't.
   - Bonus: simple calculator ("Number of routes? Annual budget? Here's what each tier costs you per route.")

8. **Case studies / customer logos.**
   - Even one — Streamline (Bozeman) since you've used their feed throughout dev — written up as a short page would help. Permission first.
   - Cold ad traffic needs to see *someone* trusts this before signing up.

### Tier 3 — nice to have (run with launch, not blockers)

9. **G2 / Capterra listings** to seed aggregateRating + reviews.
10. **Blog or "GTFS guides" section** — content marketing fuels organic + retargeting.
11. **Live demo CTA** ("Book a 15-min demo") for the Agency tier — typical buyer journey is consultative, not self-serve.

## 4. Google Ads campaign architecture (for the moment you turn it on)

### Campaign structure

| Campaign | Match types | Landing page | Goal |
|---|---|---|---|
| Brand defense | Exact ("gtfs·x", "gtfsx", "gtfsbuilder") | Home | Capture branded search, defend against competitors bidding on your name |
| GTFS publishing (intent) | Phrase / exact ("publish GTFS feed", "GTFS hosting", "GTFS canonical URL") | `/lp/publish-gtfs/` | Pro signups |
| Planning tools (competitive) | Phrase ("Remix alternative", "transit planning software", "Title VI analysis software") | `/lp/transit-planning-tools/` | Agency signups |
| Verticals | Phrase per vertical | `/for/<vertical>/` | Tier varies |

### Quality Score hygiene

- Ad copy must literally contain the landing-page headline keyword. Don't bid on "Remix alternative" and land on a generic page.
- Page load: marketing pages are already prerendered + static-asset-served, so Core Web Vitals should be fine. Sanity-check with PageSpeed Insights on staging before launch.
- Sitelink extensions: pricing, compare, demo, mobility database story.

### Negative keywords (critical to dollar efficiency)

- `realtime`, `RT`, `GTFS-RT` (developer / API traffic, not buyers)
- `python`, `R`, `library`, `parser`, `validator open source` (dev tools)
- `free`, `tutorial`, `download` for paid-intent campaigns (but yes for the editor-driven campaigns where free *is* the hook)
- `definition`, `what is`, `wikipedia`, `pdf`

### Budget shape (suggested)

- Start at $30-50/day to gather conversion data. Don't optimise for cost-per-conversion until you have ~30 conversions in the campaign (Google's minimum threshold for Smart Bidding).
- Target CPA when bidding switches on: ~$60-80 for a Pro signup (assumes ~10-15% trial-to-paid; first-year LTV $588 for Pro annual covers it).
- Agency-tier campaigns will run hotter CPA ($200-400) but the LTV math still works ($2,499/yr annual).

## 5. Conversion-funnel instrumentation we need

The single most expensive ads mistake is running blind. Before flipping the switch on Google Ads:

1. **GA4 property** wired with Enhanced Measurement enabled (page views, scroll, outbound clicks already auto-captured).
2. **Google Ads account linked to GA4** so conversions flow back.
3. **Manual conversion events** for the funnel stages we care about:
   - `sign_up` (account created)
   - `start_project` (first feed saved server-side)
   - `start_checkout` (Stripe checkout session created)
   - `subscription_active` (Stripe webhook → `customer.subscription.created`)
4. **UTM tagging discipline** on every ad URL so campaign source/medium/term are attributable. Build a UTM-template doc; don't ad-hoc.
5. **Microsoft Clarity or PostHog session recording** (free tiers) on the landing pages for the first 30 days — watch real visitors, see where they bounce.

## 6. Suggested launch sequence

1. **Week 1 (now):** Search Console fix lands. Set up GA4 + Ads conversion tracking. Wire `sign_up` + `subscription_active` events.
2. **Week 2:** Pricing-page rewrite (FAQ, badge, trust strip). One landing page (`/lp/publish-gtfs/`).
3. **Week 3:** Mobile audit + fixes. Mobility Database story page.
4. **Week 4:** Launch a small ($30/day) brand-defense + publish-intent campaign. Use the first 2 weeks to measure CTR, bounce, conversions; do not optimise yet.
5. **Week 5-8:** Expand to vertical landing pages + competitive (Remix-alternative) campaign. Switch bidding to Target CPA once threshold is met.
6. **Week 8+:** Iterate landing-page copy based on Clarity recordings + ad-keyword performance data.

## 7. Open questions for Mark

1. **Conversion target.** What's the realistic Pro sign-up CPA you're willing to pay? Drives the bidding strategy.
2. **Vertical priority.** Of microtransit / university / paratransit / consultants, which one should ship first?
3. **Case study consent.** Comfortable approaching Streamline (or any current real-world user of the platform) for a written-up case study?
4. **Demo CTA.** Do you want a "book a demo" path for Agency-tier ad traffic, or stay self-serve only?
5. **Ad budget envelope.** $30/day to start is conservative; what's the total monthly ceiling you're willing to commit before measurable conversions?
