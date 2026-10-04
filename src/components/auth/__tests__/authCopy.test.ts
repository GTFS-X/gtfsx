// W1-16/W1-12 login redirect errors, C4-02/W1-03 billing 409 helpers.
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../services/apiClient';
import { loginRedirectErrorMessage } from '../loginErrors';
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
