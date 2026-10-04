import type { Env } from '../env';

// Stripe subscription statuses that still bill (or can resume billing) the
// customer. A row in any of these states means the owner has a live paid
// relationship with Stripe that the app must not silently override or orphan:
// checkout must not start a second subscription, staff comp grants/revokes
// must not fight the webhook, and the owner can't be deleted out from under
// it (the billing portal is unreachable once the org is gone).
export const LIVE_SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due', 'unpaid'] as const;

const STATUS_SQL = LIVE_SUBSCRIPTION_STATUSES.map((s) => `'${s}'`).join(', ');

export interface LiveSubscriptionOptions {
  /**
   * Deleting the owner (DELETE /api/me, DELETE /api/orgs/:id) only needs the
   * customer to be safe from further charges. An active or trialing
   * subscription the customer already cancelled in the billing portal
   * (cancel_at_period_end = 1) ends on its own at period end, so it does not
   * block deletion. Checkout, staff plan grants and the hard-purge reaper keep
   * the strict rule: the subscription still exists until Stripe ends it.
   */
  ignoreScheduledCancel?: boolean;
}

/** SQL predicate (on alias `alias`) for a subscription that blocks the caller. */
function liveSql(alias: string, opts: LiveSubscriptionOptions): string {
  const base = `${alias}.status IN (${STATUS_SQL})`;
  if (!opts.ignoreScheduledCancel) return base;
  return `${base} AND NOT (${alias}.cancel_at_period_end = 1 AND ${alias}.status IN ('active', 'trialing'))`;
}

export async function hasLiveSubscription(
  env: Env,
  ownerType: 'user' | 'org',
  ownerId: string,
  opts: LiveSubscriptionOptions = {},
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS n FROM subscription s
      WHERE s.owner_type = ? AND s.owner_id = ? AND ${liveSql('s', opts)}
      LIMIT 1`,
  )
    .bind(ownerType, ownerId)
    .first<{ n: number }>();
  return !!row;
}

/**
 * Orgs with a live subscription that deleting this user's account would leave
 * with nobody able to manage billing: orgs where the user is the only member,
 * or the only owner. Returns their names (for the error copy).
 */
export async function orgsWithLiveSubscriptionSoleOwnedBy(
  env: Env,
  userId: string,
  opts: LiveSubscriptionOptions = {},
): Promise<string[]> {
  const res = await env.DB.prepare(
    `SELECT o.name AS name
       FROM organization_membership m
       JOIN organization o ON o.id = m.org_id AND o.deleted_at IS NULL
      WHERE m.user_id = ?
        AND (
          (SELECT COUNT(*) FROM organization_membership m2 WHERE m2.org_id = m.org_id) = 1
          OR (m.role = 'owner'
              AND (SELECT COUNT(*) FROM organization_membership m3
                    WHERE m3.org_id = m.org_id AND m3.role = 'owner') = 1)
        )
        AND EXISTS (
          SELECT 1 FROM subscription s
           WHERE s.owner_type = 'org' AND s.owner_id = m.org_id AND ${liveSql('s', opts)}
        )`,
  )
    .bind(userId)
    .all<{ name: string }>();
  return (res.results ?? []).map((r) => r.name);
}
