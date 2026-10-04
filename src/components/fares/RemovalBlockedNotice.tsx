/** Inline message shown when a Fares v2 delete is refused because other rows
 *  still reference the entity (see describeRemovalBlockers). */
export function RemovalBlockedNotice({ message, onDismiss }: { message: string | null; onDismiss?: () => void }) {
  if (!message) return null;
  return (
    <div role="alert" className="mb-3 p-3 rounded-lg bg-red-50 border-2 border-red-200 text-[12px] text-red-700 flex items-start gap-2">
      <span className="flex-1">{message}</span>
      {onDismiss && (
        <button
          onClick={onDismiss}
          title="Dismiss"
          className="text-red-400 hover:text-red-700 font-bold leading-none"
        >
          ×
        </button>
      )}
    </div>
  );
}
