/** Parse GTFS time string (HH:MM:SS, can exceed 24h) to total seconds */
export function gtfsTimeToSeconds(time: string): number {
  if (!time) return 0;
  const parts = time.split(':').map(Number);
  return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
}

/** Format total seconds to GTFS time string HH:MM:SS */
export function secondsToGtfsTime(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Format for display: 6:46 AM or 14:30 */
export function formatTimeShort(time: string): string {
  if (!time) return '';
  const parts = time.split(':').map(Number);
  const h = parts[0] || 0;
  const m = parts[1] || 0;
  return `${h}:${String(m).padStart(2, '0')}`;
}

/** Validate GTFS time format */
export function isValidGtfsTime(time: string): boolean {
  return /^\d{1,2}:\d{2}:\d{2}$/.test(time);
}
