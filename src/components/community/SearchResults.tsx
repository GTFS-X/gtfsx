import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { searchForum, type ForumSearchHit } from '../../services/forumApi';
import { Avatar } from './Avatar';
import { relativeTime } from './time';

export function SearchResults() {
  const [searchParams] = useSearchParams();
  const q = searchParams.get('q') ?? '';

  const [results, setResults] = useState<ForumSearchHit[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initial query
  useEffect(() => {
    let cancelled = false;
    if (!q.trim()) {
      // Drop into a microtask so we don't violate react-hooks/set-state-in-effect
      // (which forbids synchronous setState calls in the effect body).
      queueMicrotask(() => {
        if (cancelled) return;
        setResults([]);
        setNextCursor(null);
        setError(null);
      });
      return () => {
        cancelled = true;
      };
    }
    queueMicrotask(() => {
      if (cancelled) return;
      setLoading(true);
      setError(null);
    });
    searchForum(q)
      .then((res) => {
        if (cancelled) return;
        setResults(res.results);
        setNextCursor(res.nextCursor);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [q]);

  const handleLoadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await searchForum(q, nextCursor);
      setResults((prev) => [...prev, ...res.results]);
      setNextCursor(res.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load more results');
    } finally {
      setLoadingMore(false);
    }
  };

  const heading = useMemo(() => {
    if (!q.trim()) return 'Search the community';
    if (loading) return `Searching for "${q}"…`;
    return `${results.length}${nextCursor ? '+' : ''} result${results.length === 1 ? '' : 's'} for "${q}"`;
  }, [q, loading, results.length, nextCursor]);

  return (
    <div>
      <nav className="text-xs text-warm-gray mb-3">
        <Link to="/community" className="hover:text-coral">Community</Link>
        {' / '}
        <span>Search</span>
      </nav>
      <h1 className="font-heading font-bold text-2xl text-dark-brown break-words">{heading}</h1>

      {!q.trim() && (
        <p className="mt-3 text-sm text-warm-gray">
          Type a search above to find threads and replies across the community forum.
        </p>
      )}

      {error && (
        <div className="mt-4 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-sm">
          {error}
        </div>
      )}

      {q.trim() && !loading && results.length === 0 && !error && (
        <p className="mt-4 text-sm text-warm-gray">
          Nothing matches yet — try different keywords, or{' '}
          <Link to="/community/new" className="text-coral underline">start a new thread</Link>.
        </p>
      )}

      <ul className="mt-4 space-y-3">
        {results.map((hit, i) => (
          <li
            key={`${hit.thread.id}-${i}`}
            className="bg-white border border-sand rounded-lg p-4 hover:border-coral transition-colors"
          >
            <Link
              to={`/community/${encodeURIComponent(hit.thread.categoryId)}/${encodeURIComponent(`${hit.thread.id}-${hit.thread.slug}`)}`}
              className="block"
            >
              <h2 className="font-heading font-bold text-base text-dark-brown hover:text-coral">
                {hit.thread.title}
              </h2>
              <div
                className="forum-md text-sm text-warm-gray mt-1 line-clamp-2"
                dangerouslySetInnerHTML={{ __html: hit.snippet }}
              />
              <div className="mt-2 flex items-center gap-2 text-xs text-warm-gray">
                <Avatar
                  gravatarHash={hit.thread.author.gravatarHash}
                  displayName={hit.thread.author.displayName}
                  size={16}
                />
                <span>{hit.thread.author.displayName}</span>
                <span>·</span>
                <span>{hit.thread.categoryId}</span>
                <span>·</span>
                <span>{hit.thread.postCount} repl{hit.thread.postCount === 1 ? 'y' : 'ies'}</span>
                <span>·</span>
                <span>last activity {relativeTime(hit.thread.lastPostAt)}</span>
                {hit.thread.solvedPostId && (
                  <>
                    <span>·</span>
                    <span className="text-teal font-semibold">solved</span>
                  </>
                )}
              </div>
            </Link>
          </li>
        ))}
      </ul>

      {nextCursor && (
        <div className="mt-4 text-center">
          <button
            type="button"
            onClick={handleLoadMore}
            disabled={loadingMore}
            className="px-4 py-2 rounded-md text-xs font-heading font-bold bg-sand text-brown hover:bg-coral-light hover:text-coral transition-colors disabled:opacity-50"
          >
            {loadingMore ? 'Loading…' : 'Load more results'}
          </button>
        </div>
      )}
    </div>
  );
}
