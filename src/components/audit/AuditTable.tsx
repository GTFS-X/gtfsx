import type { AuditEvent } from '../../services/distributionApi';
import { formatTimestamp, prettyAction, summarizeMetadata } from './auditFormat';

// Shared audit-event table. Used by both the per-project tab and the account
// page's "Recent activity" section. Callers own pagination/loading state and
// pass rows in via `events`.
export function AuditTable({
  events,
  currentUserId,
  compact = false,
}: {
  events: AuditEvent[];
  currentUserId?: string | null;
  compact?: boolean;
}) {
  if (events.length === 0) {
    return <div className="px-4 py-6 text-sm text-warm-gray">No activity yet.</div>;
  }

  return (
    <table className="w-full text-sm">
      <thead className={compact ? 'hidden' : ''}>
        <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-warm-gray border-b border-sand">
          <th className="px-4 py-2">When</th>
          <th className="px-3 py-2">Action</th>
          <th className="px-3 py-2">Actor</th>
          <th className="px-3 py-2">Details</th>
        </tr>
      </thead>
      <tbody>
        {events.map((event) => {
          const meta = summarizeMetadata(event.metadataJson);
          const isYou = currentUserId && event.actorUserId === currentUserId;
          const actorLabel = event.actorUserId ? (isYou ? 'You' : shortId(event.actorUserId)) : 'system';
          return (
            <tr key={event.id} className="border-b border-sand/60 last:border-0 align-top">
              <td className="px-4 py-2 text-warm-gray whitespace-nowrap text-xs">
                {formatTimestamp(event.createdAt)}
              </td>
              <td className="px-3 py-2 font-medium text-dark-brown">
                {prettyAction(event.action)}
              </td>
              <td className="px-3 py-2 text-xs text-warm-gray whitespace-nowrap">{actorLabel}</td>
              <td className="px-3 py-2 text-xs text-warm-gray">
                {meta || <span className="text-warm-gray/60">—</span>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function shortId(id: string): string {
  if (id.length <= 10) return id;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}
