import { STAFF_IMPERSONATOR_KEY } from '../../services/adminApi';

/**
 * Whether to show the red "Impersonating" banner.
 *
 * The server's answer (GET /api/me `impersonating`, read from the session's
 * impersonation binding) wins whenever we have it. The localStorage hint
 * (gb_staff_id) is only a fallback for user objects that didn't come from
 * /api/me, so a stale or forged hint can't show the banner on its own.
 */
export function impersonationBannerVisible(
  user: { id: string; impersonating?: boolean } | null,
  hint: string | null,
): boolean {
  if (!user) return false;
  if (user.impersonating !== undefined) return user.impersonating;
  return !!hint && hint !== user.id;
}

/**
 * The hint is stale once the server says this session isn't an impersonation.
 * Returning true means the caller should remove it.
 */
export function impersonationHintIsStale(
  user: { impersonating?: boolean } | null,
  hint: string | null,
): boolean {
  return !!hint && !!user && user.impersonating === false;
}

export function readStaffHint(): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(STAFF_IMPERSONATOR_KEY) : null;
  } catch {
    return null;
  }
}

export function clearStaffHint(): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(STAFF_IMPERSONATOR_KEY);
  } catch {
    /* storage unavailable: nothing to clear */
  }
}
