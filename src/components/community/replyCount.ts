// A thread's post_count includes the opening post, so the number of replies is
// one less. Shared by every list that labels a thread with its reply count.
export function replyCountLabel(postCount: number): string {
  const n = Math.max(0, postCount - 1);
  return `${n} repl${n === 1 ? 'y' : 'ies'}`;
}
