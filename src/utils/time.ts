/** Parse GTFS time string (HH:MM:SS, can exceed 24h) to total seconds */
export function gtfsTimeToSeconds(time: string): number {
  if (!time) return 0;
  const parts = time.split(':').map(Number);
  return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
}

/** Format total seconds to GTFS time string HH:MM:SS. Fractional seconds are
 *  rounded and negatives clamp to 00:00:00, so the output is always a valid
 *  GTFS time (a fractional run-time input used to produce "08:01:7.5"). */
export function secondsToGtfsTime(totalSeconds: number): string {
  const t = Math.max(0, Math.round(Number.isFinite(totalSeconds) ? totalSeconds : 0));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Format for display in 24-hour format: 06:31, 14:30.
 *  For overnight GTFS times (>= 24h), wraps to the next day and appends a
 *  small "+1d" / "+2d" suffix so users can see at a glance that the trip
 *  crosses midnight. Used by table cells. The display form round-trips
 *  through normalizeTimeInput ("01:30 +1d" → "25:30:00"); seconds are not
 *  shown, so they are not preserved by that round trip. */
export function formatTimeShort(time: string): string {
  if (!time) return '';
  const parts = time.split(':').map(Number);
  const h = parts[0] || 0;
  const m = parts[1] || 0;
  if (h >= 24) {
    const days = Math.floor(h / 24);
    const wrappedH = h % 24;
    return `${String(wrappedH).padStart(2, '0')}:${String(m).padStart(2, '0')} +${days}d`;
  }
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** True if a GTFS time is past midnight (>= 24:00:00). */
export function isOvernightTime(time: string): boolean {
  if (!time) return false;
  const h = Number(time.split(':')[0]);
  return Number.isFinite(h) && h >= 24;
}

/** Validate GTFS time format */
export function isValidGtfsTime(time: string): boolean {
  return /^\d{1,2}:\d{2}:\d{2}$/.test(time);
}

/** Normalize a user-entered time to HH:MM:SS format.
 *  Accepts: "7:30" → "07:30:00", "730" → "07:30:00", "07:30:00" → "07:30:00",
 *  "1430" → "14:30:00", "14:30" → "14:30:00"
 *  Returns empty string if input cannot be parsed.
 */
export function normalizeTimeInput(raw: string): string {
  let trimmed = raw.trim();
  if (!trimmed) return '';

  // Overnight prefix: "+1 04:30", "+1d 04:30", "1d 04:30" → add N*24 hours.
  // This is the recommended way for users to enter post-midnight times
  // without having to compute 28:30 by hand.
  let extraDays = 0;
  const dayMatch = trimmed.match(/^\+?(\d+)d?\s+(.+)$/);
  // Overnight SUFFIX, as formatTimeShort displays it: "01:30 +1d" → 25:30:00,
  // so a cell shown that way can be edited in place.
  const suffixMatch = dayMatch ? null : trimmed.match(/^(.+?)\s*\+(\d+)d?$/);
  if (dayMatch) {
    extraDays = parseInt(dayMatch[1], 10);
    trimmed = dayMatch[2];
  } else if (suffixMatch) {
    extraDays = parseInt(suffixMatch[2], 10);
    trimmed = suffixMatch[1].trim();
  }

  let base = '';
  // Already full format: H:MM:SS or HH:MM:SS
  if (/^\d{1,3}:\d{2}:\d{2}$/.test(trimmed)) {
    const [h, m, s] = trimmed.split(':').map(Number);
    if (m > 59 || s > 59) return '';
    base = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  // Partial format: H:MM or HH:MM
  else if (/^\d{1,3}:\d{2}$/.test(trimmed)) {
    const [h, m] = trimmed.split(':').map(Number);
    if (m > 59) return '';
    base = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
  }
  // Digits only: 3-4 digits like "730" or "1430"
  else if (/^\d{3,4}$/.test(trimmed)) {
    const digits = trimmed.padStart(4, '0');
    const h = parseInt(digits.slice(0, 2), 10);
    const m = parseInt(digits.slice(2, 4), 10);
    if (m > 59) return '';
    base = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
  }

  if (!base) return '';
  if (extraDays > 0) {
    const sec = gtfsTimeToSeconds(base) + extraDays * 86400;
    return secondsToGtfsTime(sec);
  }
  return base;
}
