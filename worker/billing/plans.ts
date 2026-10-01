// Feature gating — which plans unlock which capabilities.
// See docs/REQUIREMENTS.md for the source-of-truth tier/feature map.
// NOTE: this matrix is mirrored by hand in src/components/billing/planConfig.ts —
// edit BOTH in lockstep.

import type { Plan } from '../projects/quotas';

export type FeatureKey =
  | 'managed_publishing'   // POST /api/projects/:id/publish → canonical URL + embeds
  | 'draft_links'          // POST /api/projects/:id/draft-links → public share URLs
  | 'mobility_db_submit'   // submit feed to Mobility Database
  | 'embeds'               // rider-facing embed widgets + mini-site
  | 'embed_remove_badge'   // serve embeds without the "Powered by GTFS·X" badge
  | 'snapshot_history'     // named snapshots + restore + delete
  | 'analysis_basic'       // demographic coverage + cost estimation
  | 'analysis_title_vi'    // Title VI equity analysis
  | 'analysis_propensity'  // propensity heatmap
  | 'network_walksheds'    // street-network (Mapbox isochrone) coverage walksheds
  | 'org_workspace'        // create or be a member of an org
  | 'cross_org_member'     // member of orgs you don't own (e.g. consultants in client orgs)
  | 'multi_org'            // own MORE THAN ONE org (create additional orgs beyond the first)
  | 'org_logo'             // upload a custom org logo
  | 'brand_color'          // custom brand primary color
  | 'service_alerts'       // author GTFS-Realtime Service Alerts
  | 'geojson_export'       // export routes + stops as GeoJSON for GIS
  | 'access_isochrones'    // schedule-based transit travel-time reach analysis
  | 'variants'             // feed variants (fork / compare-to-baseline) — client-side; mirrored for parity
  | 'assistant'            // "Ask GTFS·X" embedded help assistant (all tiers; per-plan daily quota)
  | 'phone_support';       // SLA-backed phone support

// Per-feature: which plans grant access. Free is excluded by absence.
//
// Free planning (Sep 2026): GTFS·X is no longer pursuing commercialization of
// the planning suite. Every planning/analysis feature (route-level cost &
// coverage, stop analysis, Title VI, network walksheds, access isochrones,
// variants/scenario comparison) is granted to EVERY plan, including free and
// anonymous editors. The keys stay in this matrix (rather than being deleted) so
// a future re-gate is a one-line config change in BOTH files.
//
// Free hosting (Oct 2026): snapshot history, publishing + hosting (managed
// publishing, draft links, Mobility Database submission, embeds + mini-site,
// badge removal), Service Alerts and org branding (logo, brand color) are also
// granted to EVERY plan. The ONLY paid features left are organizational/team
// management (org_workspace member invites, cross_org_member, multi_org) and
// phone_support. Free-plan quotas were raised to match (see PLAN_QUOTAS in
// worker/projects/quotas.ts). Access isochrones + network walksheds are free on
// every plan but need a signed-in account: the Mapbox call is proxied through
// the auth-gated GET /api/mapbox/isochrone (worker/mapbox/isochrone.ts).
//
// Pricing v4 (Jul 2026): the Pro tier is retired (zero subscribers — no
// migration needed). Everything that was Pro+ moves up to Agency+ (internal
// plan id 'agency'; displayed as "Planner"), except geojson_export which
// drops DOWN to every plan including free. analysis_propensity (demand dots)
// stays free for everyone.
export const FEATURE_PLANS: Record<FeatureKey, readonly Plan[]> = {
  managed_publishing:  ['free', 'agency', 'enterprise'],
  draft_links:         ['free', 'agency', 'enterprise'],
  mobility_db_submit:  ['free', 'agency', 'enterprise'],
  embeds:              ['free', 'agency', 'enterprise'],
  embed_remove_badge:  ['free', 'agency', 'enterprise'],
  snapshot_history:    ['free', 'agency', 'enterprise'],
  analysis_basic:      ['free', 'agency', 'enterprise'],
  analysis_title_vi:   ['free', 'agency', 'enterprise'],
  analysis_propensity: ['free', 'agency', 'enterprise'],
  network_walksheds:   ['free', 'agency', 'enterprise'],
  org_workspace:       ['agency', 'enterprise'],
  cross_org_member:    ['agency', 'enterprise'],
  // Owning MORE THAN ONE org is Enterprise-only; the first org is available to
  // Planner (and to the no-card trial). Enforced in the org-creation route.
  multi_org:           ['enterprise'],
  org_logo:            ['free', 'agency', 'enterprise'],
  brand_color:         ['free', 'agency', 'enterprise'],
  service_alerts:      ['free', 'agency', 'enterprise'],
  geojson_export:      ['free', 'agency', 'enterprise'],
  access_isochrones:   ['free', 'agency', 'enterprise'],
  variants:            ['free', 'agency', 'enterprise'],
  // "Ask GTFS·X" is available to every logged-in tier; the differentiation is a
  // per-plan daily message quota enforced server-side (see worker/assistant/quota.ts),
  // not plan membership.
  assistant:           ['free', 'agency', 'enterprise'],
  phone_support:       ['agency', 'enterprise'],
};

export function planHasFeature(plan: Plan, feature: FeatureKey): boolean {
  return FEATURE_PLANS[feature].includes(plan);
}

// The smallest plan that unlocks a given feature — used by the upgrade modal
// to suggest a target. Order matches the price ladder.
const PLAN_ORDER: Plan[] = ['free', 'agency', 'enterprise'];

export function cheapestPlanFor(feature: FeatureKey): Plan {
  for (const plan of PLAN_ORDER) {
    if (planHasFeature(plan, feature)) return plan;
  }
  return 'enterprise';
}

// Whether a plan represents a billable subscription (vs. free / staff-granted enterprise).
export function isPaidPlan(plan: Plan): boolean {
  return plan !== 'free';
}

// The multi-org gate (feature 'multi_org'): a user may OWN at most one
// organization unless they own an enterprise-plan org, which unlocks creating
// additional orgs. Given the plans of the orgs the user already owns, returns
// whether creating ANOTHER org is blocked. The first org (empty list) is always
// allowed — that's what lets the no-card trial auto-create a workspace for a
// brand-new user. Staff bypass is handled by the caller.
// NOTE: mirrored client-side in src/components/billing/planConfig.ts
// (blockedFromAdditionalOrg) — keep the two in parity.
export function blockedFromAdditionalOrg(ownedOrgPlans: readonly (string | null | undefined)[]): boolean {
  if (ownedOrgPlans.length === 0) return false;
  return !ownedOrgPlans.some((p) => p === 'enterprise');
}

// Public copy used by the pricing page and paywall overlays. Kept in sync with
// the Stripe Product metadata generated by scripts/setup-stripe.ts.
export interface PlanCatalogEntry {
  plan: Plan;
  displayName: string;
  monthlyPriceUsd: number | null;   // null = invoice-only (enterprise)
  annualPriceUsd: number | null;
  perSeat: boolean;
  tagline: string;
  features: string[];
  // Optional "see more" link rendered below the bullet list (e.g. the Agency
  // card → the /planning reference page).
  detailsHref?: string;
  detailsLabel?: string;
}

export const PLAN_CATALOG: PlanCatalogEntry[] = [
  {
    plan: 'free',
    displayName: 'Editor',
    monthlyPriceUsd: 0,
    annualPriceUsd: 0,
    perSeat: false,
    tagline: 'Edit, plan, publish, and host transit feeds. Free.',
    features: [
      'Create, edit, and validate GTFS and GTFS-Flex feeds on a live map',
      'The full planning suite: route-level cost, coverage & Title VI equity',
      'Access isochrones, stop analysis & street-network walksheds (free account)',
      'Scenario comparison with feed variants, timetables & vehicle blocking',
      'Hosted publishing: stable feed URL, rider mini-site, embeds & Service Alerts',
      'Up to 99 cloud feeds with snapshot history',
      'Export a spec-clean GTFS .zip or GeoJSON (no signup required)',
    ],
  },
  {
    plan: 'agency',
    displayName: 'Planner',
    monthlyPriceUsd: 299,
    annualPriceUsd: 2988,
    perSeat: false,
    tagline: 'Team workspaces for transit agencies.',
    features: [
      'Team workspaces: invite members and manage roles',
      'Cross-org membership for consultants working in client orgs',
      'Unlimited cloud feeds',
      'Phone + email support',
    ],
    detailsHref: '/docs/pricing/',
    detailsLabel: 'Compare plans in detail →',
  },
  {
    plan: 'enterprise',
    displayName: 'Enterprise',
    monthlyPriceUsd: null,
    annualPriceUsd: null,
    perSeat: false,
    tagline: 'Multi-agency subscriptions for consultants and state DOTs.',
    features: [
      'Own and manage multiple organization workspaces',
      'Custom feed and seat limits',
      'Phone + email support with SLA',
      'Contract terms via PO or invoice',
    ],
  },
];
