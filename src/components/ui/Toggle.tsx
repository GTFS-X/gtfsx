interface ToggleProps {
  /** Whether the switch is on. */
  on: boolean;
  className?: string;
}

/** Presentational iOS-style switch (`.tgl`). The clickable target is the caller's
 *  wrapper (e.g. a menu row) — this renders the track + knob only, so it's marked
 *  aria-hidden and the wrapper carries the role/label. */
export function Toggle({ on, className = '' }: ToggleProps) {
  return (
    <span
      aria-hidden="true"
      className={`relative inline-block w-[30px] h-[17px] rounded-full shrink-0 transition-colors ${
        on ? 'bg-coral' : 'bg-sand'
      } ${className}`}
    >
      <span
        className={`absolute top-0.5 w-[13px] h-[13px] rounded-full bg-white shadow-sm transition-[left] ${
          on ? 'left-[15px]' : 'left-0.5'
        }`}
      />
    </span>
  );
}
