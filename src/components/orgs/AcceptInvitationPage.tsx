import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useStore } from '../../store';
import { AuthLayout } from '../auth/AuthLayout';
import { AuthButton } from '../auth/AuthButton';
import { ApiError, logout as apiLogout } from '../../services/authApi';
import {
  acceptInvitation,
  listPendingInvitations,
  type PendingInvitation,
} from '../../services/orgsApi';

export function AcceptInvitationPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const authChecked = useStore((s) => s.authChecked);
  const hydrateAuth = useStore((s) => s.hydrateAuth);
  const currentUser = useStore((s) => s.currentUser);
  const loadOrgs = useStore((s) => s.loadOrgs);
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace);
  const clearAuth = useStore((s) => s.clearAuth);

  const token = searchParams.get('token') ?? '';
  // Invitation emails embed the recipient's address so we can pre-fill the
  // signup form for first-time users. The server is the real authority on
  // which address the token is valid for.
  const invitedEmail = searchParams.get('email') ?? '';

  const [loading, setLoading] = useState(true);
  const [invite, setInvite] = useState<PendingInvitation | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mismatchedEmail, setMismatchedEmail] = useState(false);

  useEffect(() => {
    if (!authChecked) hydrateAuth();
  }, [authChecked, hydrateAuth]);

  useEffect(() => {
    if (!authChecked) return;
    if (!currentUser) {
      // First-time invitees almost certainly don't have an account yet —
      // default them to /signup with the email pre-filled and the accept
      // URL threaded through as `next` so the post-verify redirect lands
      // them straight in the org's workspace. The signup page surfaces a
      // "have an account?" link for the existing-user case.
      const acceptUrl = `/orgs/accept?token=${encodeURIComponent(token)}${invitedEmail ? `&email=${encodeURIComponent(invitedEmail)}` : ''}`;
      const q = new URLSearchParams();
      q.set('next', acceptUrl);
      if (invitedEmail) q.set('email', invitedEmail);
      navigate(`/signup?${q.toString()}`, { replace: true });
      return;
    }
    // We don't have a single-invitation lookup endpoint, so fetch the pending
    // list and surface the invite (if any) for this user's email. The server
    // is the real gate — we only use this to show a nice preview.
    listPendingInvitations()
      .then(({ invitations }) => {
        // We can't match against the token client-side (server stores a hash),
        // so just show the most recent pending invitation as the preview.
        setInvite(invitations[0] ?? null);
      })
      .catch(() => setInvite(null))
      .finally(() => setLoading(false));
  }, [authChecked, currentUser, navigate, token, invitedEmail]);

  const onAccept = async () => {
    if (!token) {
      setError('No invitation token provided.');
      return;
    }
    setAccepting(true);
    setError(null);
    setMismatchedEmail(false);
    try {
      const { organization, role } = await acceptInvitation({ token });
      await loadOrgs();
      setActiveWorkspace({ type: 'org', orgId: organization.id, role });
      navigate('/feeds');
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setMismatchedEmail(true);
        setError(err.message);
      } else {
        const msg = err instanceof ApiError ? err.message : 'Could not accept invitation';
        setError(msg);
      }
    } finally {
      setAccepting(false);
    }
  };

  if (!authChecked || loading || !currentUser) {
    return (
      <AuthLayout title="Accept invitation">
        <p className="text-sm text-warm-gray">Loading…</p>
      </AuthLayout>
    );
  }

  if (!token) {
    return (
      <AuthLayout
        title="Accept invitation"
        subtitle="No invitation token provided. Use the link from your invitation email."
      >
        <div className="flex justify-end">
          <AuthButton onClick={() => navigate('/feeds')}>Back to My Feeds</AuthButton>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Accept invitation"
      subtitle={
        invite
          ? `You've been invited to join ${invite.orgName} as a ${invite.role}.`
          : 'Review and accept your invitation below.'
      }
    >
      <div className="text-sm text-warm-gray mb-4">
        Signed in as <span className="font-medium text-dark-brown">{currentUser.email}</span>.
      </div>

      {error && (
        <div className="mb-3 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-sm">
          {error}
        </div>
      )}

      {mismatchedEmail ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-warm-gray">
            This invitation was sent to a different email address. Sign out and sign in with
            the invited email to accept.
          </p>
          <AuthButton
            variant="secondary"
            onClick={async () => {
              try {
                await apiLogout();
              } catch {
                // ignore
              }
              clearAuth();
              const next = `/orgs/accept?token=${encodeURIComponent(token)}`;
              navigate(`/login?next=${encodeURIComponent(next)}`, { replace: true });
            }}
          >
            Sign out and sign in with a different email
          </AuthButton>
          <AuthButton variant="ghost" onClick={() => navigate('/feeds')}>
            Cancel
          </AuthButton>
        </div>
      ) : (
        <div className="flex justify-end gap-2">
          <AuthButton variant="secondary" onClick={() => navigate('/feeds')}>
            Not now
          </AuthButton>
          <AuthButton onClick={onAccept} disabled={accepting}>
            {accepting ? 'Accepting…' : 'Accept invitation'}
          </AuthButton>
        </div>
      )}
    </AuthLayout>
  );
}
