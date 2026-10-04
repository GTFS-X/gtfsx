// W1-16/W1-12 login redirect errors, C4-02/W1-03 billing 409 helpers.
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../services/apiClient';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ACCOUNT_DELETED_CONFIRMATION,
  ACCOUNT_DELETED_PARAM,
  DELETE_ACCOUNT_DESCRIPTION,
  loginRedirectErrorMessage,
} from '../loginErrors';
import {
  deleteBlockedMessage,
  isActiveSubscriptionError,
  isAlreadySubscribedError,
} from '../../billing/billingErrors';

describe('loginRedirectErrorMessage', () => {
  it('handles every redirect code the worker emits', () => {
    expect(loginRedirectErrorMessage('magic_link_invalid')).toMatch(/invalid or has expired/);
    expect(loginRedirectErrorMessage('sms_unavailable')).toMatch(/text/);
    expect(loginRedirectErrorMessage('account_deleted')).toMatch(/hello@gtfsx.com/);
    expect(loginRedirectErrorMessage('nope')).toBeNull();
    expect(loginRedirectErrorMessage(null)).toBeNull();
  });
});

describe('billing 409 helpers', () => {
  const e = (reason: string, extra: Record<string, unknown> = {}) =>
    new ApiError('conflict', 'x', 409, { reason, ...extra });
  it('classifies by reason', () => {
    expect(isAlreadySubscribedError(e('already_subscribed'))).toBe(true);
    expect(isAlreadySubscribedError(e('active_subscription'))).toBe(false);
    expect(isActiveSubscriptionError(e('active_subscription'))).toBe(true);
    expect(isAlreadySubscribedError(new ApiError('conflict', 'x', 400, { reason: 'already_subscribed' }))).toBe(false);
  });
  it('points at Manage billing and names blocking orgs', () => {
    expect(deleteBlockedMessage(e('active_subscription'), 'organization', 'f')).toMatch(/Manage billing/);
    const m = deleteBlockedMessage(e('active_subscription', { orgs: ['Acme'] }), 'account', 'f');
    expect(m).toMatch(/Acme/);
    expect(m).toMatch(/Manage billing/);
    expect(deleteBlockedMessage(new Error('boom'), 'account', 'fallback')).toBe('fallback');
  });
});

// E2E A8/A9: deleted-account copy is the same on every sign-in path, self-delete
// ends on a confirmation, and the in-app copy and docs match the reaper.
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('deleted-account copy', () => {
  it('password login (worker) and the redirect banner use the same copy', () => {
    const msg = loginRedirectErrorMessage('account_deleted')!;
    expect(read('../../../../worker/util/errors.ts')).toContain(`'${msg}'`);
  });

  it('self-delete lands on /login?deleted=1, which confirms the deletion', () => {
    expect(ACCOUNT_DELETED_PARAM).toBe('deleted');
    expect(read('../AccountSettingsPage.tsx')).toMatch(
      /onDeleted=\{async \(\) => \{[\s\S]*?navigate\(`\/login\?\$\{ACCOUNT_DELETED_PARAM\}=1`\)/,
    );
    expect(read('../LoginPage.tsx')).toMatch(/\{accountDeleted && \([\s\S]*?\{ACCOUNT_DELETED_CONFIRMATION\}/);
    expect(ACCOUNT_DELETED_CONFIRMATION).toMatch(/deleted.*signed out.*30 days.*hello@gtfsx\.com/);
  });

  it('the Delete account description matches the 30-day reaper and has no self-serve restore', () => {
    expect(read('../../../../worker/cron/tasks.ts')).toContain(
      'export const DELETE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;',
    );
    expect(read('../AccountSettingsPage.tsx')).toMatch(/description=\{DELETE_ACCOUNT_DESCRIPTION\}/);
    expect(DELETE_ACCOUNT_DESCRIPTION).toMatch(/30 days after deletion/);
    expect(DELETE_ACCOUNT_DESCRIPTION).toMatch(/can't be undone from the app/);
    expect(DELETE_ACCOUNT_DESCRIPTION).not.toMatch(/remain available unless you take them down/);
  });

  it('the public docs no longer claim immediate deletion with no grace period', () => {
    const docs = read('../../../../public/docs/account-and-cloud-sync/index.html');
    expect(docs).not.toMatch(/no grace period/i);
    expect(docs).toMatch(/permanently removed 30 days after/);
  });
});
