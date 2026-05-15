// Relative-time formatter for forum timestamps. Falls through to an
// absolute date when the delta is older than ~30 days.

export function relativeTime(ts: number): string {
  const now = Date.now();
  const delta = Math.max(0, now - ts);
  const sec = Math.round(delta / 1000);
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 45) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  if (day < 30) return `${Math.round(day / 7)}w ago`;
  return new Date(ts).toLocaleDateString();
}
