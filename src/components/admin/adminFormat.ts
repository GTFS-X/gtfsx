export function formatDateTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatDate(ms: number | null | undefined): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
