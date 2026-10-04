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
      return 'This account has been scheduled for deletion. Email hello@gtfsx.com within 30 days if you want it restored.';
    default:
      return null;
  }
}
