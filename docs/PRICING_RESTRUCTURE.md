# Pricing Restructure — Planning Doc

**Status:** ✅ Code shipped May 2026. Stripe + grandfathering follow-ups pending (see §9).
**Source-of-truth doc:** `docs/FREEMIUM_PLAN.md` (updated with the v2 matrix).

## 0. What was actually decided (May 2026)

| Topic | Decision |
|---|---|
| Tier names | **Free / Pro / Agency / Enterprise** (display only — internal id `team` stays put) |
| Taglines | Free: "Edit and export feeds" · Pro: "Host and publish feeds" · Agency: "Plan routes and service as a team" |
| Pro price | Unchanged ($49/mo, $499/yr) |
| Agency price | **$199/mo → $299/mo**, **$1,999/yr → $2,499/yr** |
| Feature move | `analysis_basic` (cost + coverage) moved from Pro to Agency-and-up. Only feature movement. |
| Grandfathering | Not implemented yet — flagged as a follow-up; existing Pro subscribers will lose cost+coverage on the next reload unless we add a legacy override. |
| Stripe products | Display names + price IDs need manual updates in the Stripe dashboard before prod can charge $299. |

## 1. The proposal

Mark's framing:
> Move feed publication into the Pro tier (i.e., make it the defining feature
> of Pro), move the route-planning tools (propensity, cost, coverage, Title VI)
> into the Team tier, and rephrase the tiers — e.g. Edit / Publish / Plan
> instead of Free / Pro / Team. The bet: a $50 publishing tier drives network
> effects (more agencies on the platform), and a $199 planning tier puts a
> credible competitor in front of Remix at 1/10th of its price.

## 2. What's actually changing (vs. today)

Today's feature matrix (relevant subset):

| Feature                | Free | Pro | Team | Enterprise |
|------------------------|------|-----|------|------------|
| Export ZIP             | ✓    | ✓   | ✓    | ✓          |
| Managed publishing     |      | ✓   | ✓    | ✓          |
| Embeds + mini-site     |      | ✓   | ✓    | ✓          |
| Draft links            |      | ✓   | ✓    | ✓          |
| Snapshot history       |      | ✓   | ✓    | ✓          |
| Brand color            |      | ✓   | ✓    | ✓          |
| **Cost estimation**    |      | ✓   | ✓    | ✓          |
| **Coverage analysis**  |      | ✓   | ✓    | ✓          |
| Title VI               |      |     | ✓    | ✓          |
| Propensity heatmap     |      |     | ✓    | ✓          |
| Org/team workspace     |      |     | ✓    | ✓          |

Publishing is **already** in Pro. The actual delta the proposal creates is:

- **Move `analysis_basic` (cost + coverage) up from Pro → Team.** That's the
  only feature movement.
- **Rename tier labels** (Free→Edit, Pro→Publish, Team→Plan). Keep Enterprise.
- **Reposition the marketing narrative** around publish-for-network-effects and
  plan-vs-Remix.

Everything else (publishing, embeds, draft links, snapshots, brand color,
Title VI, propensity, org features) stays where it is.

## 3. Strategic evaluation

### Pros

- **Sharper tier story.** "Edit / Publish / Plan" cleanly maps to the user's
  journey. Today the Pro tier is "publishing + a couple of analyses thrown
  in" — fuzzy. Splitting analysis cleanly into the planning tier removes
  the muddle.
- **Network-effects logic is sound.** More published feeds on
  `feeds.gtfsbuilder.net` → more discoverable footprint → more inbound. The
  marginal user who wanted to publish but balked at "do I need cost +
  coverage?" is now an easier yes.
- **Plan-vs-Remix positioning is real.** Title VI + propensity + cost +
  coverage at $199/mo is a defensible Remix alternative for the long tail of
  small-to-mid agencies who can't justify $20k+/yr.
- **Implementation is small.** Single feature key (`analysis_basic`) moves
  in two config files. The hard work is around migration, naming, and copy.

### Cons / risks

- **Existing Pro subscribers lose features.** Anyone on Pro today had cost +
  coverage. Hard cutover = downgrade for paying customers. Needs
  grandfathering (see §6).
- **"Plan" tier name is overloaded.** "Which plan are you on?" / "I'm on
  the Plan plan." The word collides with subscription-plan terminology in
  every billing UI. Strong recommendation to call it "Planning" or
  "Planner" instead (transit-industry standard term anyway).
- **"Edit" tier name feels weak for a paid-adjacent product.** Free tiers
  benefit from sounding like a product, not a permission. "Free" is the
  most copy-friendly label; "Build" is the closest action-verb that
  doesn't undersell.
- **Cost estimation is operationally useful to publishers.** A small agency
  publishing its schedule still wants to know "what does my service cost?"
  — that's a one-screen feature, not a planning workflow. Stripping it
  entirely may push borderline upgraders to skip Pro for Team they don't
  need, or churn.
- **Coverage analysis is more clearly a planning feature** (it asks
  questions about reach, not about your own operations) — easier to argue
  it moves up cleanly.
- **Pro's value-per-dollar drops.** Same $49 for fewer features. Worth
  considering a price adjustment (see §5).

## 4. Naming recommendation

| Tier         | Current | Mark's proposal | Recommendation                |
|--------------|---------|-----------------|-------------------------------|
| Free         | Free    | Edit            | **Free** (keep) — universally understood; "Edit" sounds like a button, not a product |
| Publishing   | Pro     | Publish         | **Publish** — fits the narrative; or keep "Pro" for SEO/recognizability |
| Planning     | Team    | Plan            | **Planner** or **Planning** — avoid "Plan" because it collides with subscription-plan UX language |
| Enterprise   | Enterprise | Enterprise   | Keep                          |

A defensible composite: **Free / Publish / Planner / Enterprise**.

Internal tier IDs (DB columns, Stripe metadata, code) should keep the
existing `free`/`pro`/`team`/`enterprise` keys regardless of display
rename — a code rename ripples through migrations, Stripe products, the
webhook log, and the test suite for little benefit.

## 5. Pricing options

| Option | Publish | Plan | Notes |
|---|---|---|---|
| **A (no change)** | $49 / $499 | $199 / $1,999 | Simplest; Pro value-per-dollar drops slightly |
| **B (drop Publish)** | $29 / $299 | $199 / $1,999 | Reflects feature removal; doubles down on volume play |
| **C (raise Plan)** | $49 / $499 | $299 / $2,999 | Positions vs Remix more aggressively; still <1/6 of Remix |
| **D (Publish down, Plan up)** | $29 / $299 | $299 / $2,999 | Maximum spread; clearest "which tier am I" decision |

**Recommendation: Option C.** Publish at $49 keeps the friction low for the
network-effects bet without telegraphing weakness. Planner at $299/mo
($3.6k/yr annual) still undercuts Remix by ~5x while sustaining the
margin needed to fund the planning features (Census API, propensity
modeling, Title VI tooling).

If the network-effects bet is paramount, **Option D** is more aggressive
but requires comfort with the support burden a cheaper publish tier
brings.

## 6. Migration: existing Pro subscribers

Three viable paths:

1. **Hard cutover.** Email Pro subscribers; on switchover date, cost +
   coverage become Plan-only. Simplest implementation, worst UX. Expect
   churn + refund requests.

2. **Permanent grandfather.** Add `legacy_features` JSON column on
   `users`/`orgs`. Existing Pro subscribers retain `analysis_basic`
   forever; new signups don't. `planHasFeature()` checks the override
   first. Best customer experience; mild code complexity; means the
   "Pro/Publish" tier copy can't truthfully claim cost+coverage was ever
   excluded.

3. **Time-limited grandfather.** Existing Pro keeps cost+coverage for 6
   months; thereafter must upgrade to Planner. Email comms at T-90, T-30,
   T-7. Balances customer goodwill against eventual catalog clarity.

**Recommendation: Option 2 (permanent grandfather).** The number of
existing Pro subscribers is small enough (early days) that the long-tail
override is cheap, and the goodwill cost of taking features away from
paying customers is high relative to the volume.

Implementation: a single `pro_legacy_analysis` boolean (or
`grandfathered_features: string[]` JSON) on the user/org row, set by a
one-time migration script keyed off subscription start date.

## 7. Implementation surface (when ready)

Ordered by dependency:

1. **`docs/FREEMIUM_PLAN.md`** — Update feature matrix table, tier names
   in §1.1; update §6 (managed-publishing rationale) and §9 (resolved
   decisions); add a "Pricing v2" section documenting the migration plan.
2. **`worker/billing/plans.ts`** — Move `analysis_basic` from
   `['pro','team','enterprise']` → `['team','enterprise']`. Update
   display labels if renaming. Add `pro_legacy_analysis` plumbing if
   grandfathering.
3. **`src/components/billing/planConfig.ts`** — Same change in the client
   mirror. Same legacy override plumbing in `planHasFeature()`.
4. **`src/components/billing/PricingPage.tsx`** — Rewrite tier copy:
   strip cost/coverage from the Publish bullet list, add them to the
   Planner bullet list. Reorder bullets to lead with the tier's defining
   value. Update tier titles if renaming.
5. **`src/services/billingApi.ts`** — `Plan` type stays as-is (internal
   IDs unchanged). Add `legacyFeatures` field to user/org billing
   responses if grandfathering.
6. **Frontend gates** — No code change needed if we move
   `analysis_basic` in the matrix; `PaywallOverlay feature="analysis_basic"`
   wrappers in `RightRail.tsx` automatically gate to the new tier.
7. **Backend gates** — Cost + coverage are pure client-side; no backend
   route gates today. No work needed unless we want server-side
   validation later.
8. **Stripe** — No price/product changes needed for Option A pricing. For
   B/C/D, create new prices in Stripe (keep old prices for existing
   subscribers) and update env vars.
9. **Stripe product display names** — Optional rename in the Stripe
   dashboard so receipts read "Publish" instead of "Pro". Keep internal
   IDs (`STRIPE_PRICE_PRO_MONTHLY` etc.) unchanged to avoid env churn.
10. **`docs/EMBEDS_REQUIREMENTS.md`** — Update tier references.
11. **Tests** — `worker/__tests__/projects.quota.test.ts` and any
    analysis-gate tests; verify legacy-override path.
12. **Email comms** — Draft email to existing Pro subscribers explaining
    the change and the grandfathering decision.
13. **Marketing tagline** — "GTFS Editor • Route Planner" currently in
    the static pages; consider "GTFS Editor • Publisher • Planner" to
    reflect the three-tier narrative.

Estimated effort: ~1 day of code + 1 day of copy + Stripe dashboard work
+ comms. The bulk of the value is in the marketing/positioning rewrite,
not the code.

## 8. Open questions for Mark

1. **Grandfather vs hard cutover** for existing Pro subscribers? Recommendation: permanent grandfather.
2. **Pricing option** — A (status quo), B (drop Publish), C (raise Plan), or D (both)? Recommendation: C.
3. **Tier names** — "Plan" or "Planner"/"Planning"? Free or Edit? Recommendation: Free / Publish / Planner.
4. **Keep cost estimation in Publish?** Operationally useful to small-agency publishers; splitting it (basic in Publish, advanced/comparative in Planner) is an option.
5. **Stripe product display names** — rename to match new tier labels in receipts, or keep "Pro"/"Team" for billing continuity?
6. **Timeline / launch window** — coordinated with any blog post / Mobility Database announcement?

## 9. Follow-up work still pending

The May-2026 code change updated only the catalog, taglines, prices, and the
feature matrix. These still need attention before / right after the prod
rollout:

1. **Stripe dashboard updates.** Create new prices for the Agency tier at
   $299/mo and $2,499/yr in both live and test mode. Update
   `STRIPE_PRICE_TEAM_MONTHLY` / `STRIPE_PRICE_TEAM_ANNUAL` in
   `wrangler.jsonc` (both default + staging env). Existing Team subscribers
   on the $199 price stay grandfathered at their original price because
   Stripe charges off the price ID stored on the subscription, not the
   product. Without these env-var updates, checkout on prod will still
   send users to the $199 price.

2. **Stripe product display names.** Rename "Team" → "Agency" in the
   Stripe dashboard so receipts and the customer portal read consistently
   with the marketing site.

3. **Grandfathering for existing Pro subscribers.** Anyone on Pro today
   had cost + coverage; the v2 rules silently revoke them. Add a
   `legacy_features` JSON column (or a single `pro_legacy_analysis` flag)
   on `user`, populate it for every paid Pro signup before today's date,
   and have `planHasFeature()` short-circuit on that flag. Worker side
   the same plumbing applies to org rows if any existed on Pro (none
   today; orgs are Team/Agency-only).

4. **Email to existing Pro subscribers.** Short note explaining the tier
   refocus, what they keep (publishing, embeds, branding, snapshots),
   what they lose (cost + coverage — covered by grandfather if we ship
   it), and the upgrade path to Agency if they want the planning suite.

5. **Tagline on the static marketing pages.** "GTFS Editor • Route
   Planner" in `index.html` and the compare pages can stay, or move to
   "GTFS Editor • Publisher • Planner" if we want the three-tier
   narrative to surface above the fold.
