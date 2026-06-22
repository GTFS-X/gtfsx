// Pure helpers for the staff "Grant plan" control. No JSX so they're unit
// testable under the frontend (node) vitest config.

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ExpiryOption {
  /** Quick-pick label. */
  label: string;
  /** Days from "now" until expiry; null = no expiry. */
  days: number | null;
}

// Quick options offered in the grant dialog. "Custom date…" is handled
// separately by the dialog via a date input.
export const EXPIRY_OPTIONS: ExpiryOption[] = [
  { label: '14 days', days: 14 },
  { label: '30 days', days: 30 },
  { label: '60 days', days: 60 },
  { label: '90 days', days: 90 },
  { label: 'No expiry', days: null },
];

/**
 * Convert a quick-pick day count into an absolute unix-ms expiry.
 * `null` days → `null` (open-ended grant).
 */
export function expiryToTimestamp(days: number | null, now: number = Date.now()): number | null {
  if (days === null) return null;
  return now + days * DAY_MS;
}

/**
 * Parse an `<input type="date">` value (`YYYY-MM-DD`, local) into an
 * end-of-day unix-ms timestamp. Empty / invalid → `null`.
 */
export function customDateToTimestamp(value: string): number | null {
  if (!value) return null;
  // End-of-day local so a same-day grant doesn't immediately lapse.
  const t = new Date(`${value}T23:59:59`).getTime();
  return Number.isNaN(t) ? null : t;
}

/** Human-readable grant expiry for the admin UI. */
export function describeExpiry(expiresAt: number | null | undefined): string {
  if (expiresAt === null || expiresAt === undefined) return 'No expiry';
  return `Expires ${new Date(expiresAt).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })}`;
}
