/**
 * Copy for the `?error=` codes the worker redirects to /login with (magic-link
 * and Google callbacks). Unknown codes render nothing.
 */
export function loginRedirectErrorMessage(code: string | null): string | null {
  switch (code) {
    case 'magic_link_invalid':
      return 'That sign-in link is invalid or has expired. Request a new one below.';
    case 'sms_unavailable':
      return "We couldn't send your verification text just now. Please try again in a few minutes, or sign in another way.";
    case 'account_deleted':
      // Same copy as ACCOUNT_DELETED_MESSAGE in worker/util/errors.ts (password login).
      return 'This account has been scheduled for deletion. Email hello@gtfsx.com within 30 days if you want it restored.';
    default:
      return null;
  }
}

/** Query flag the account page adds when it lands here after self-delete. */
export const ACCOUNT_DELETED_PARAM = 'deleted';

/** Confirmation shown on /login?deleted=1 right after the user deletes their account. */
export const ACCOUNT_DELETED_CONFIRMATION =
  "Your account has been deleted and you've been signed out. It will be permanently removed in 30 days. " +
  'To restore it before then, email hello@gtfsx.com.';

/**
 * In-app copy for Account settings → Delete account. Matches what happens:
 * immediate soft delete + sign-out, hard purge by the reaper 30 days later,
 * no self-serve restore.
 */
export const DELETE_ACCOUNT_DESCRIPTION =
  "You'll be signed out everywhere right away. 30 days after deletion, your account and your personal " +
  'feeds, snapshots and published feeds are permanently removed; published feeds stay online until then. ' +
  "This can't be undone from the app. To restore the account within those 30 days, email hello@gtfsx.com. " +
  'Export any feed you want to keep first.';
