import type { PendingInvitation } from '../../services/orgsApi';

/**
 * `GET /invitations/pending?token=` returns only the row matching the URL
 * token. Anything other than exactly one row means no usable preview, so the
 * page falls back to a generic subtitle rather than naming the wrong org.
 */
export function pickInvitePreview(invitations: PendingInvitation[]): PendingInvitation | null {
  return invitations.length === 1 ? invitations[0] : null;
}

export function invitationSubtitle(invite: PendingInvitation | null): string {
  return invite
    ? `You've been invited to join ${invite.orgName} as a ${invite.role}.`
    : 'Review and accept your invitation below.';
}

/**
 * The accept endpoint 403s both for an unverified email and for an invitation
 * addressed to someone else; only the latter should offer "sign in with a
 * different email".
 */
export function isUnverifiedEmailMessage(message: string): boolean {
  return /verify your email/i.test(message);
}
