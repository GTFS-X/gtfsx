import type { ReactNode } from 'react';
import { AuthButton } from '../auth/AuthButton';

export function StatusPill({ status }: { status: string }) {
  const tone: Record<string, string> = {
    active: 'bg-teal-light text-teal',
    pending_verification: 'bg-gold-light text-amber-700',
    disabled: 'bg-sand text-warm-gray',
    deleted_soft: 'bg-red-100 text-red-700',
  };
  const cls = tone[status] ?? 'bg-sand text-warm-gray';
  return (
    <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide ${cls}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
  danger,
  busy,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
  busy?: boolean;
}) {
  return (
    <div className="fixed inset-0 flex items-center justify-center z-50">
      <div className="absolute inset-0 bg-black/20" onClick={busy ? undefined : onCancel} />
      <div className="relative bg-white rounded-2xl shadow-lg p-6 w-full max-w-sm mx-4">
        <h3 className="font-heading font-bold text-lg text-dark-brown mb-2">{title}</h3>
        <div className="text-sm text-warm-gray mb-5">{body}</div>
        <div className="flex justify-end gap-2">
          <AuthButton variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </AuthButton>
          <AuthButton
            variant={danger ? 'danger' : 'primary'}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Working…' : confirmLabel}
          </AuthButton>
        </div>
      </div>
    </div>
  );
}

export function ErrorBanner({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div className="mb-4 px-4 py-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
      {children}
    </div>
  );
}
