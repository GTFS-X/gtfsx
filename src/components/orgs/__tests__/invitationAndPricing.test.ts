// C4-09 invitation preview, C4-02 pricing target org.
import { describe, expect, it } from 'vitest';
import type { PendingInvitation } from '../../../services/orgsApi';
import { invitationSubtitle, isUnverifiedEmailMessage, pickInvitePreview } from '../invitationPreview';
import { orgToManageBilling, pickCheckoutOrg } from '../../billing/orgTrial';

const inv = (orgName: string) => ({ orgName, role: 'editor' }) as PendingInvitation;

describe('invitation preview', () => {
  it('uses the matched invitation only when exactly one comes back', () => {
    expect(pickInvitePreview([inv('A')])?.orgName).toBe('A');
    expect(pickInvitePreview([inv('A'), inv('B')])).toBeNull();
    expect(pickInvitePreview([])).toBeNull();
    expect(invitationSubtitle(null)).toBe('Review and accept your invitation below.');
    expect(invitationSubtitle(inv('A'))).toMatch(/join A as a editor/);
  });
  it('distinguishes unverified-email 403s', () => {
    expect(isUnverifiedEmailMessage('Please verify your email address before accepting invitations')).toBe(true);
    expect(isUnverifiedEmailMessage('Invitation is for a different email address')).toBe(false);
  });
});

describe('pricing target org', () => {
  const now = 1_000;
  const paid = { plan: 'agency' as const, trialEndsAt: null, planExpiresAt: null };
  const free = { plan: 'free' as const };
  const trial = { plan: 'agency' as const, trialEndsAt: 5_000, planExpiresAt: 5_000 };
  it('sends admins of only-paid orgs to billing, not checkout', () => {
    expect(orgToManageBilling(null, [paid], now)).toBe(paid);
    expect(orgToManageBilling(paid, [paid, free], now)).toBe(paid);
  });
  it('still allows checkout for free and trial orgs', () => {
    expect(orgToManageBilling(null, [paid, free], now)).toBeNull();
    expect(orgToManageBilling(trial, [trial], now)).toBeNull();
    expect(pickCheckoutOrg(null, [paid, free], now)).toBe(free);
    expect(pickCheckoutOrg(null, [paid], now)).toBeNull();
  });
});
