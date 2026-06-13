import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { listCategories, listThreads, type ForumCategory, type ForumThread } from '../../services/forumApi';
import {
  getSeenMap,
  isCategoryUnseen,
  isThreadUnseen,
  type SeenMap,
} from '../../services/forumReadState';
import { relativeTime } from './time';
import { Avatar } from './Avatar';
import { SearchBar } from './SearchBar';

export function CategoryIndex() {
  const navigate = useNavigate();
  const [cats, setCats] = useState<ForumCategory[] | null>(null);
  const [recent, setRecent] = useState<ForumThread[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Read localStorage once on mount; remounts after thread navigation pick up the fresh state.
  const [seenMap, setSeenMap] = useState<SeenMap>(() => getSeenMap());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [catRes, recentRes] = await Promise.all([
          listCategories(),
          listThreads({ sort: 'active', limit: 8 }),
        ]);
        if (cancelled) return;
        setCats(catRes.categories);
        setRecent(recentRes.threads);
        // Refresh seenMap after data loads so the seen/unseen state
        // reflects any threads the user opened before navigating here.
        setSeenMap(getSeenMap());
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load forum');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <div className="text-red-700 text-sm">{error}</div>;
  if (!cats) return <div className="text-warm-gray text-sm">Loading…</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="font-heading font-bold text-2xl text-dark-brown">Community</h1>
        <button
          onClick={() => navigate('/community/new')}
          className="px-3 py-2 rounded-lg font-heading font-bold text-sm bg-coral text-white hover:bg-[#d4603a] transition-colors shrink-0"
        >
          + New thread
        </button>
      </div>

      <div>
        <SearchBar
          onSubmit={(q) => navigate(`/community/search?q=${encodeURIComponent(q)}`)}
        />
      </div>

      <section>
        <h2 className="font-heading font-bold text-sm text-warm-gray uppercase tracking-wide mb-2">Categories</h2>
        <div className="bg-white border border-sand rounded-lg divide-y divide-sand">
          {cats.map((cat) => {
            const hasNew = isCategoryUnseen(cat.id, cat.latestActivityAt, seenMap);
            return (
              <Link
                key={cat.id}
                to={`/community/${encodeURIComponent(cat.id)}`}
                className="flex items-center gap-4 px-4 py-3 hover:bg-cream/40 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-dark-brown text-sm">{cat.title}</span>
                    {hasNew && (
                      <>
                        {/* Teal dot — matches the unseen thread-row accent/pill; color is
                            reinforced by the sr-only text for screen readers */}
                        <span
                          aria-hidden="true"
                          className="inline-block w-2 h-2 rounded-full bg-teal flex-none"
                        />
                        <span className="sr-only">has new posts</span>
                      </>
                    )}
                  </div>
                  <div className="text-xs text-warm-gray truncate">{cat.description}</div>
                </div>
                <div className="text-right shrink-0 text-xs text-warm-gray">
                  <div>{cat.threadCount ?? 0} thread{cat.threadCount === 1 ? '' : 's'}</div>
                  {cat.latestActivityAt && <div>Last: {relativeTime(cat.latestActivityAt)}</div>}
                </div>
              </Link>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="font-heading font-bold text-sm text-warm-gray uppercase tracking-wide mb-2">Latest activity</h2>
        {recent.length === 0 ? (
          <div className="bg-white border border-sand rounded-lg p-6 text-center text-warm-gray text-sm">
            No threads yet. Be the first — pick a category above or start a new thread.
          </div>
        ) : (
          <div className="bg-white border border-sand rounded-lg divide-y divide-sand">
            {recent.map((t) => (
              <ThreadRow key={t.id} t={t} seenMap={seenMap} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ThreadRow({ t, seenMap }: { t: ForumThread; seenMap: SeenMap }) {
  const unseen = isThreadUnseen(t.id, t.lastPostAt, seenMap);
  return (
    <Link
      to={`/community/${encodeURIComponent(t.categoryId)}/${encodeURIComponent(t.id)}-${t.slug}`}
      className={`flex items-center gap-3 px-4 py-3 hover:bg-cream/40 transition-colors ${
        unseen ? 'bg-teal-light/40 border-l-2 border-teal' : ''
      }`}
    >
      <Avatar gravatarHash={t.author.gravatarHash} displayName={t.author.displayName} size={28} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-sm font-semibold text-dark-brown">
          {t.pinned && <span className="text-[10px] uppercase tracking-wide text-coral shrink-0">Pinned</span>}
          {t.solvedPostId && <span className="text-[10px] uppercase tracking-wide text-teal shrink-0">Solved</span>}
          {unseen && (
            <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-teal bg-teal-light px-1.5 py-0.5 rounded">
              New
            </span>
          )}
          <span className="truncate">{t.title}</span>
        </div>
        <div className="text-xs text-warm-gray truncate">
          {t.author.displayName} · {t.categoryId} · {t.postCount} repl{t.postCount === 1 ? 'y' : 'ies'} · {relativeTime(t.lastPostAt)}
        </div>
      </div>
    </Link>
  );
}
