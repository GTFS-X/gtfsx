// Shared by the post-verify landing pages and account settings.
//
// When a verify-email link is opened outside the browser that signed up, the
// worker activates the account but discards the signup password (see
// dropUnprovenSignupState in worker/auth/routes.ts) and adds this flag to the
// redirect. The landing page then explains why and offers to set one.

/** Query flag on the post-verify redirect. Mirrors SET_PASSWORD_NOTICE_PARAM in worker/auth/routes.ts. */
export const SET_PASSWORD_NOTICE_PARAM = 'set_password';

/** Where the notice sends the user: account settings' "Set a password" section. */
export const SET_PASSWORD_HREF = '/account#password';

export const SET_PASSWORD_NOTICE_TEXT =
  'Your email is verified. For security, set a password to sign in with one.';

/**
 * Show the notice when the redirect carried the flag, unless we already know
 * the account has a password again (e.g. set in another tab).
 */
export function showSetPasswordNotice(params: URLSearchParams, hasPassword: boolean | undefined): boolean {
  return params.get(SET_PASSWORD_NOTICE_PARAM) === '1' && hasPassword !== true;
}

/**
 * Which password section account settings renders. `hasPassword` comes from
 * GET /api/me; undefined (older response, or the login response) keeps the
 * change form, since a password login proves a password exists.
 */
export function passwordSectionMode(hasPassword: boolean | undefined): 'change' | 'set' {
  return hasPassword === false ? 'set' : 'change';
}
