export interface ToastState {
  message: string;
  /** When present, an Undo affordance is shown that calls this on click. */
  onUndo?: () => void;
}

/** Bottom-left toast used to confirm bulk/destructive edits, with an optional
 *  Undo. Presentational — the owner holds the state + auto-dismiss timer and
 *  renders this when a toast is active. */
export function Toast({ toast }: { toast: ToastState }) {
  return (
    <div
      role="status"
      className="fixed bottom-[18px] left-[18px] z-[200] flex items-center gap-3.5 px-4 py-2.5 rounded-lg shadow-lg bg-dark-brown text-cream font-heading font-bold text-[13px]"
    >
      <span>{toast.message}</span>
      {toast.onUndo && (
        <button
          type="button"
          onClick={toast.onUndo}
          className="font-heading font-extrabold text-[13px] text-gold underline underline-offset-2 hover:text-white"
        >
          Undo
        </button>
      )}
    </div>
  );
}
