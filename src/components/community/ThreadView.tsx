import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  deleteThread,
  getMySubscription,
  getThread,
  patchThread,
  replyToThread,
  subscribeToThread,
  unsubscribeFromThread,
  type ForumPost,
  type ForumThread,
} from '../../services/forumApi';
import { ApiError } from '../../services/authApi';
import { useStore } from '../../store';
import { Avatar } from './Avatar';
import { Composer } from './Composer';
import { PostCard } from './PostCard';
import { relativeTime } from './time';

export function ThreadView() {
  const { threadKey } = useParams<{ catId: string; threadKey: string }>();
  const navigate = useNavigate();
  const currentUser = useStore((s) => s.currentUser);
  // threadKey is "<id>-<slug>"; pull the id off the front
  const threadId = useMemo(() => {
    if (!threadKey) return null;
    return threadKey.split('-')[0] ?? null;
  }, [threadKey]);

  const [thread, setThread] = useState<ForumThread | null>(null);
  const [posts, setPosts] = useState<ForumPost[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [replyPending, setReplyPending] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);

  useEffect(() => {
    if (!threadId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await getThread(threadId);
        if (cancelled) return;
        setThread(res.thread);
        setPosts(res.posts);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Could not load thread');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  useEffect(() => {
    if (!threadId || !currentUser) {
      setSubscribed(null);
      return;
    }
    let cancelled = false;
    getMySubscription(threadId)
      .then(({ subscribed }) => {
        if (!cancelled) setSubscribed(subscribed);
      })
      .catch(() => {
        if (!cancelled) setSubscribed(null);
      });
    return () => {
      cancelled = true;
    };
  }, [threadId, currentUser]);

  if (error) {
    return (
      <div className="bg-white border border-sand rounded-lg p-6">
        <p className="text-sm text-red-700 mb-2">{error}</p>
        <Link to="/community" className="text-sm text-coral hover:underline">← Back to community</Link>
      </div>
    );
  }
  if (!thread) return <div className="text-warm-gray text-sm">Loading…</div>;

  const isAdmin = !!currentUser?.staff;
  const isAuthor = currentUser?.id === thread.author.id;

  const handleReply = async (md: string) => {
    if (!currentUser) {
      navigate(`/login?next=${encodeURIComponent(window.location.pathname)}`);
      return;
    }
    setReplyError(null);
    setReplyPending(true);
    try {
      const res = await replyToThread(thread.id, md);
      setPosts((prev) => [...prev, res.post]);
      setThread({ ...thread, postCount: thread.postCount + 1, lastPostAt: res.post.createdAt });
    } catch (e) {
      if (e instanceof ApiError && (e.extra as { reason?: string })?.reason === 'needs_display_name') {
        setReplyError('Set a community display name before posting — open the picker above.');
      } else {
        setReplyError(e instanceof Error ? e.message : 'Could not post reply');
      }
    } finally {
      setReplyPending(false);
    }
  };

  const handlePostUpdate = (updated: ForumPost) => {
    setPosts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
  };

  const handlePostDelete = (postId: string) => {
    setPosts((prev) => prev.map((p) => (p.id === postId ? { ...p, deletedAt: Date.now(), bodyMd: '' } : p)));
    if (thread.solvedPostId === postId) setThread({ ...thread, solvedPostId: null });
  };

  const handleMarkSolved = (postId: string | null) => {
    setThread({ ...thread, solvedPostId: postId });
    setPosts((prev) => prev.map((p) => ({ ...p, isSolved: p.id === postId })));
  };

  const handleSubscribeToggle = async () => {
    if (!currentUser || !thread) return;
    try {
      const res = subscribed ? await unsubscribeFromThread(thread.id) : await subscribeToThread(thread.id);
      setSubscribed(res.subscribed);
    } catch {
      // ignore
    }
  };

  const handleDeleteThread = async () => {
    if (!confirm('Delete this thread? This cannot be undone.')) return;
    try {
      await deleteThread(thread.id);
      navigate(`/community/${encodeURIComponent(thread.categoryId)}`);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Could not delete thread');
    }
  };

  const handleAdminToggle = async (field: 'pinned' | 'locked') => {
    try {
      const res = await patchThread(thread.id, { [field]: !thread[field] });
      setThread(res.thread);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Could not update thread');
    }
  };

  const [op, ...replies] = posts;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-warm-gray">
            <Link to="/community" className="hover:text-coral">Community</Link>
            {' / '}
            <Link to={`/community/${encodeURIComponent(thread.categoryId)}`} className="hover:text-coral">
              {thread.categoryId}
            </Link>
          </div>
          <h1 className="font-heading font-bold text-2xl text-dark-brown mt-1 break-words">
            {thread.title}
          </h1>
          <div className="text-xs text-warm-gray mt-1 flex flex-wrap items-center gap-2">
            <Avatar gravatarHash={thread.author.gravatarHash} displayName={thread.author.displayName} size={20} />
            <span className="font-semibold text-dark-brown">{thread.author.displayName}</span>
            <span>·</span>
            <span>started {relativeTime(thread.createdAt)}</span>
            <span>·</span>
            <span>{thread.postCount} repl{thread.postCount === 1 ? 'y' : 'ies'}</span>
            {thread.solvedPostId && (
              <span className="text-teal font-semibold flex items-center gap-1">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden>
                  <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Solved
              </span>
            )}
            {thread.locked && <span className="italic">· Locked</span>}
            {thread.pinned && <span className="text-coral">· Pinned</span>}
          </div>
        </div>
        {currentUser && (
          <div className="flex flex-col items-end gap-1 shrink-0">
            <button
              onClick={handleSubscribeToggle}
              className="px-2 py-1 rounded-md text-xs border border-sand hover:border-coral hover:text-coral transition-colors"
            >
              {subscribed ? '🔔 Unsubscribe' : '🔕 Subscribe'}
            </button>
            {(isAdmin || isAuthor) && (
              <button
                onClick={handleDeleteThread}
                className="text-xs text-warm-gray hover:text-red-700"
              >
                Delete thread
              </button>
            )}
            {isAdmin && (
              <div className="flex gap-1 text-[11px]">
                <button onClick={() => handleAdminToggle('pinned')} className="hover:text-coral">
                  {thread.pinned ? 'Unpin' : 'Pin'}
                </button>
                <span>·</span>
                <button onClick={() => handleAdminToggle('locked')} className="hover:text-coral">
                  {thread.locked ? 'Unlock' : 'Lock'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {op && (
        <PostCard
          post={op}
          thread={thread}
          isOp
          onUpdate={handlePostUpdate}
          onDelete={handlePostDelete}
          onMarkSolved={handleMarkSolved}
        />
      )}

      {/* If there's an accepted answer that isn't the OP, hoist it to the top of the replies. */}
      {(() => {
        const ordered = orderReplies(replies, thread.solvedPostId);
        return ordered.map((p) => (
          <PostCard
            key={p.id}
            post={p}
            thread={thread}
            isOp={false}
            onUpdate={handlePostUpdate}
            onDelete={handlePostDelete}
            onMarkSolved={handleMarkSolved}
          />
        ));
      })()}

      <div className="mt-4">
        {thread.locked ? (
          <div className="bg-sand/40 border border-sand rounded-lg p-4 text-sm text-warm-gray italic">
            This thread is locked — replies are closed.
          </div>
        ) : currentUser ? (
          <>
            {replyError && (
              <div className="mb-2 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-xs">
                {replyError}
              </div>
            )}
            <Composer
              submitLabel={replyPending ? 'Posting…' : 'Post reply'}
              onSubmit={handleReply}
              disabled={replyPending}
            />
          </>
        ) : (
          <div className="bg-white border border-sand rounded-lg p-4 text-sm text-warm-gray flex items-center gap-3">
            <span className="flex-1">
              Sign in to join the conversation.
            </span>
            <button
              onClick={() => navigate(`/login?next=${encodeURIComponent(window.location.pathname)}`)}
              className="px-3 py-1.5 rounded-md text-xs font-heading font-bold bg-coral text-white hover:bg-[#d4603a] transition-colors"
            >
              Sign in
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function orderReplies(replies: ForumPost[], solvedPostId: string | null): ForumPost[] {
  if (!solvedPostId) return replies;
  const solved = replies.find((p) => p.id === solvedPostId);
  if (!solved) return replies;
  return [solved, ...replies.filter((p) => p.id !== solvedPostId)];
}
