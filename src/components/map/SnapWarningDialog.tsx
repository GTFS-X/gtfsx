const METERS_PER_MILE = 1609.344;

/** Length in the feed's display units (miles, with a feet fallback under a
 *  tenth of a mile — mirrors StopCoveragePanel's fmtMiles). The editor has no
 *  metric toggle; distances are shown in miles throughout. */
function fmtMiles(meters: number): string {
  const mi = meters / METERS_PER_MILE;
  if (mi < 0.1) return `${(mi * 5280).toFixed(0)} ft`;
  return `${mi.toFixed(2)} mi`;
}

interface SnapWarningButton {
  label: string;
  onClick: () => void;
}

interface SnapWarningDialogProps {
  title: string;
  /** Body text describing why the path couldn't be fully snapped. */
  message: string;
  /**
   * Optional current-vs-snapped length comparison (in metres). Rendered only
   * when present and the two differ by a meaningful amount, so a trivial
   * road-following wobble doesn't get flagged as lost geometry.
   */
  lengths?: { currentMeters: number; snappedMeters: number };
  /** Coral / recommended action (keeps the user's geometry intact). */
  primary: SnapWarningButton;
  /** Sand / secondary action. Omit for a single full-width primary button. */
  secondary?: SnapWarningButton;
  /**
   * Overlay positioning. Defaults to the draw-flow's map-relative overlay;
   * panel callers pass a viewport-fixed class so the modal isn't clipped to the
   * right rail.
   */
  overlayClassName?: string;
}

/**
 * Shared "couldn't fully snap to roads" confirmation, used by both the
 * draw-a-new-shape flow (MapView) and the Routes panel's per-shape Snap button
 * (RouteShapesTab). Both surfaces give the user the same explicit choice rather
 * than silently saving a cut-off shape; the routes-panel caller also passes a
 * length summary so the user can see how much geometry a truncated snap drops.
 */
export function SnapWarningDialog({
  title,
  message,
  lengths,
  primary,
  secondary,
  overlayClassName = 'absolute inset-0 z-20',
}: SnapWarningDialogProps) {
  const deltaMeters = lengths ? lengths.snappedMeters - lengths.currentMeters : 0;
  // Only worth showing the comparison when snapping actually changes the length
  // by something a user would care about (> ~30 m or > 1% of the current shape).
  const showLengths =
    lengths != null &&
    lengths.snappedMeters > 0 &&
    Math.abs(deltaMeters) > Math.max(30, lengths.currentMeters * 0.01);

  return (
    <div className={`${overlayClassName} flex items-center justify-center`}>
      <div className="absolute inset-0 bg-black/20" />
      <div className="relative bg-white rounded-xl shadow-lg p-5 max-w-sm mx-4">
        <h3 className="font-heading font-bold text-base text-dark-brown mb-2">{title}</h3>
        <p className="text-sm text-warm-gray mb-4">{message}</p>

        {showLengths && lengths && (
          <div className="mb-4 rounded-lg bg-cream px-3 py-2 text-xs text-dark-brown">
            <div className="flex items-center justify-between">
              <span className="text-warm-gray">Current shape</span>
              <span className="font-semibold tabular-nums">{fmtMiles(lengths.currentMeters)}</span>
            </div>
            <div className="flex items-center justify-between mt-0.5">
              <span className="text-warm-gray">After snapping</span>
              <span className="font-semibold tabular-nums">{fmtMiles(lengths.snappedMeters)}</span>
            </div>
            <div className="mt-1 flex items-center justify-between border-t border-sand pt-1">
              <span className="text-warm-gray">Difference</span>
              <span className="font-semibold tabular-nums text-coral">
                {deltaMeters < 0 ? '-' : '+'}{fmtMiles(Math.abs(deltaMeters))}
              </span>
            </div>
          </div>
        )}

        <div className="flex gap-2">
          {secondary && (
            <button
              onClick={secondary.onClick}
              className="flex-1 px-3 py-2 bg-sand text-brown rounded-lg font-heading font-bold text-sm hover:bg-coral-light hover:text-coral transition-colors"
            >
              {secondary.label}
            </button>
          )}
          <button
            onClick={primary.onClick}
            className="flex-1 px-3 py-2 bg-coral text-white rounded-lg font-heading font-bold text-sm hover:bg-[#d4603a] transition-colors"
          >
            {primary.label}
          </button>
        </div>
      </div>
    </div>
  );
}
