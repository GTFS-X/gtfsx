import { useState } from 'react';
import { patchThread } from '../../services/forumApi';

interface MarkSolvedButtonProps {
  postId: string;
  threadId: string;
  threadSolvedPostId: string | null;
  isCurrentlySolved: boolean;
  onChange: (newSolvedPostId: string | null) => void;
}

export function MarkSolvedButton({
  postId,
  threadId,
  threadSolvedPostId,
  isCurrentlySolved,
  onChange,
}: MarkSolvedButtonProps) {
  const [pending, setPending] = useState(false);
  const otherSolved = threadSolvedPostId && threadSolvedPostId !== postId;

  const handleClick = async () => {
    setPending(true);
    try {
      const newId = isCurrentlySolved ? null : postId;
      await patchThread(threadId, { solvedPostId: newId });
      onChange(newId);
    } finally {
      setPending(false);
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={pending}
      title={
        isCurrentlySolved
          ? 'Unmark as the answer'
          : otherSolved
            ? 'Replace the current accepted answer with this one'
            : 'Mark this reply as the answer'
      }
      className={`hover:text-teal transition-colors ${isCurrentlySolved ? 'text-teal font-semibold' : ''}`}
    >
      {isCurrentlySolved ? '✓ Accepted answer' : 'Mark as answer'}
    </button>
  );
}
