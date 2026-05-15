import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../../store';
import { toggleUpvote } from '../../services/forumApi';

interface UpvoteButtonProps {
  postId: string;
  authorId: string;
  initialCount: number;
  initialUpvoted: boolean;
}

export function UpvoteButton({ postId, authorId, initialCount, initialUpvoted }: UpvoteButtonProps) {
  const currentUser = useStore((s) => s.currentUser);
  const navigate = useNavigate();
  const [count, setCount] = useState(initialCount);
  const [upvoted, setUpvoted] = useState(initialUpvoted);
  const [pending, setPending] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);

  const isOwnPost = currentUser?.id === authorId;
  const disabled = isOwnPost || pending;

  const handleClick = async () => {
    if (!currentUser) {
      setPopoverOpen(true);
      return;
    }
    if (disabled) return;
    setPending(true);
    const wasUpvoted = upvoted;
    setUpvoted(!wasUpvoted);
    setCount(wasUpvoted ? count - 1 : count + 1);
    try {
      const res = await toggleUpvote(postId);
      setUpvoted(res.upvotedByMe);
      setCount(res.upvoteCount);
    } catch {
      setUpvoted(wasUpvoted);
      setCount(count);
    } finally {
      setPending(false);
    }
  };

  const button = (
    <button
      onClick={handleClick}
      disabled={isOwnPost}
      title={isOwnPost ? "Can't upvote your own post" : upvoted ? 'Remove upvote' : 'Upvote'}
      className={`flex flex-col items-center gap-0.5 px-2 py-1 rounded-md transition-colors ${
        isOwnPost ? 'opacity-50 cursor-not-allowed' : 'hover:bg-cream'
      } ${upvoted ? 'text-coral' : 'text-warm-gray'}`}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill={upvoted ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" aria-hidden>
        <path d="M12 4l8 10h-5v6h-6v-6H4z" strokeLinejoin="round" />
      </svg>
      <span className="text-xs font-semibold tabular-nums">{count}</span>
    </button>
  );

  if (currentUser) return button;

  return (
    <Popover.Root open={popoverOpen} onOpenChange={setPopoverOpen}>
      <Popover.Trigger asChild>{button}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="center"
          sideOffset={6}
          className="bg-white rounded-lg shadow-lg border border-sand p-3 w-56 z-50"
        >
          <p className="text-xs text-dark-brown mb-2">Sign in to upvote helpful answers.</p>
          <div className="flex gap-2">
            <button
              onClick={() => navigate(`/login?next=${encodeURIComponent(window.location.pathname)}`)}
              className="flex-1 px-2 py-1.5 rounded-md bg-coral text-white font-heading font-bold text-xs hover:bg-[#d4603a] transition-colors"
            >
              Sign in
            </button>
            <button
              onClick={() => navigate(`/signup?next=${encodeURIComponent(window.location.pathname)}`)}
              className="flex-1 px-2 py-1.5 rounded-md bg-teal text-white font-heading font-bold text-xs hover:bg-[#22847a] transition-colors"
            >
              Sign up
            </button>
          </div>
          <Popover.Arrow className="fill-white" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
