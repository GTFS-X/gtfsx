import { ApiError } from '../../services/apiClient';

/**
 * The server's 409 conflicts carry a machine-readable `reason`. Checkout
 * returns `already_subscribed` (enterprise or a live subscription); org and
 * account delete return `active_subscription`; signup returns
 * `account_deleted`.
 */
export function conflictReason(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const reason = err.extra?.reason;
  return typeof reason === 'string' ? reason : null;
}

export function isAlreadySubscribedError(err: unknown): boolean {
  return conflictReason(err) === 'already_subscribed';
}

export function isActiveSubscriptionError(err: unknown): boolean {
  return conflictReason(err) === 'active_subscription';
}

/** Names of the orgs blocking an account delete (`orgs` in the 409 payload). */
function blockingOrgNames(err: ApiError): string[] {
  const orgs = err.extra?.orgs;
  if (!Array.isArray(orgs)) return [];
  const names: string[] = [];
  for (const o of orgs) {
    if (typeof o === 'string') names.push(o);
    else if (o && typeof o === 'object' && typeof (o as { name?: unknown }).name === 'string') {
      names.push((o as { name: string }).name);
    }
  }
  return names;
}

/**
 * User-facing copy for an `active_subscription` 409 on org/account delete,
 * pointing at Manage billing. `fallback` is used for any other error.
 */
export function deleteBlockedMessage(
  err: unknown,
  what: 'organization' | 'account',
  fallback: string,
): string {
  if (!isActiveSubscriptionError(err)) {
    return err instanceof ApiError ? err.message : fallback;
  }
  const names = blockingOrgNames(err as ApiError);
  const which = names.length > 0 ? ` (${names.join(', ')})` : '';
  return what === 'organization'
    ? 'This organization has an active subscription. Cancel it in Manage billing first, then delete the organization.'
    : `You have an active subscription${which}. Cancel it in Manage billing first, then delete your account.`;
}
