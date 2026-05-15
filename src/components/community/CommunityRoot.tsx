import { Link, useNavigate } from 'react-router-dom';
import { useStore } from '../../store';
import { Avatar } from './Avatar';
import { useEffect, useState } from 'react';
import { getMyForumProfile, type ForumProfile } from '../../services/forumApi';

// Shared chrome for /community/* pages — top strip with brand, search bar (TBD),
// and the current user's avatar shortcut to their profile.

export function CommunityRoot({ children }: { children: React.ReactNode }) {
  const currentUser = useStore((s) => s.currentUser);
  const navigate = useNavigate();
  const [me, setMe] = useState<ForumProfile | null>(null);

  useEffect(() => {
    if (!currentUser) {
      setMe(null);
      return;
    }
    let cancelled = false;
    getMyForumProfile()
      .then(({ profile }) => {
        if (!cancelled) setMe(profile);
      })
      .catch(() => {
        if (!cancelled) setMe(null);
      });
    return () => {
      cancelled = true;
    };
  }, [currentUser]);

  return (
    <div className="min-h-screen bg-cream">
      <header className="bg-white border-b border-sand">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link to="/community" className="font-heading font-bold text-base text-dark-brown hover:text-coral transition-colors">
            GTFS Studio · Community
          </Link>
          <span className="text-[10px] font-bold uppercase tracking-wide bg-teal-light text-teal px-1.5 py-0.5 rounded">
            New
          </span>
          <div className="flex-1" />
          <Link
            to="/"
            className="text-xs text-warm-gray hover:text-coral transition-colors"
          >
            ← Back to Editor
          </Link>
          {currentUser ? (
            <>
              <Link to="/community/profile" className="hover:opacity-80" title="Your community profile">
                <Avatar
                  gravatarHash={me?.gravatarHash ?? null}
                  displayName={me?.displayName ?? currentUser.displayName}
                  size={28}
                />
              </Link>
            </>
          ) : (
            <button
              onClick={() => navigate(`/login?next=${encodeURIComponent(window.location.pathname)}`)}
              className="px-3 py-1.5 rounded-md text-xs font-heading font-bold bg-coral text-white hover:bg-[#d4603a] transition-colors"
            >
              Sign in
            </button>
          )}
        </div>
      </header>
      <main className="max-w-4xl mx-auto px-4 py-6">{children}</main>
    </div>
  );
}
