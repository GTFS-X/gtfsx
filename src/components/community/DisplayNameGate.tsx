import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { getMyForumProfile, patchMyForumProfile } from '../../services/forumApi';

// Sticky modal — appears on first visit to any /community/* page for any
// authed user without a forum display name set. The user can dismiss it,
// but the server-side write block is the real enforcement (every state-
// changing endpoint returns 412 needs_display_name until the name is set).

const DISMISSED_KEY = 'gtfs:forum:gate-dismissed-session';

export function DisplayNameGate({ children }: { children: React.ReactNode }) {
  const currentUser = useStore((s) => s.currentUser);
  const [needsName, setNeedsName] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!currentUser) {
      setNeedsName(false);
      return;
    }
    let cancelled = false;
    setNeedsName(null);
    getMyForumProfile()
      .then(({ profile }) => {
        if (cancelled) return;
        setNeedsName(profile.needsDisplayName);
        // Pre-fill with the account display name as a sensible default.
        setName(currentUser.displayName ?? '');
      })
      .catch(() => {
        if (cancelled) return;
        setNeedsName(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentUser]);

  // Per-session dismissal so the modal doesn't trap the user on every page.
  useEffect(() => {
    if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem(DISMISSED_KEY)) {
      setDismissed(true);
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      setError('Display name must be at least 2 characters.');
      return;
    }
    setSubmitting(true);
    try {
      const { profile } = await patchMyForumProfile({ displayName: trimmed });
      setNeedsName(profile.needsDisplayName);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save display name');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDismiss = () => {
    try {
      sessionStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // ignore
    }
    setDismissed(true);
  };

  const showModal = !!currentUser && needsName === true && !dismissed;

  return (
    <>
      {children}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30" onClick={handleDismiss} aria-hidden />
          <div className="relative bg-white rounded-xl shadow-lg p-6 max-w-md w-[90%] mx-4">
            <h2 className="font-heading font-bold text-lg text-dark-brown mb-1">Pick your community name</h2>
            <p className="text-sm text-warm-gray mb-4">
              This is how you'll appear on posts and replies. You can change it later in your profile.
            </p>
            <form onSubmit={handleSubmit}>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your display name"
                maxLength={40}
                disabled={submitting}
                className="w-full px-3 py-2 border border-sand rounded-lg text-sm outline-none focus:border-coral mb-3"
              />
              {error && (
                <div className="px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-xs mb-3">
                  {error}
                </div>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleDismiss}
                  disabled={submitting}
                  className="flex-1 px-3 py-2 bg-sand text-brown rounded-lg font-heading font-bold text-sm hover:bg-coral-light hover:text-coral transition-colors disabled:opacity-50"
                >
                  Skip for now
                </button>
                <button
                  type="submit"
                  disabled={submitting || name.trim().length < 2}
                  className="flex-1 px-3 py-2 bg-coral text-white rounded-lg font-heading font-bold text-sm hover:bg-[#d4603a] transition-colors disabled:opacity-50"
                >
                  {submitting ? 'Saving…' : 'Set name'}
                </button>
              </div>
              <p className="text-[11px] text-warm-gray mt-3">
                Posting and upvoting are blocked until you pick a name.
              </p>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
