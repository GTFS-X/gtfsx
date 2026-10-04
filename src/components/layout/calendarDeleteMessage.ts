import { calendarReferenceCount, type CalendarReferences } from '../../store/calendarSlice';

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** Message shown when removeCalendar refuses because the service is still in
 *  use (S1-14). Returns null when nothing references it. */
export function calendarDeleteBlockedMessage(refs: CalendarReferences): string | null {
  if (calendarReferenceCount(refs) === 0) return null;
  const parts: string[] = [];
  if (refs.trips) parts.push(plural(refs.trips, 'trip', 'trips'));
  if (refs.flexZones) parts.push(plural(refs.flexZones, 'flex zone', 'flex zones'));
  if (refs.bookingRules) {
    parts.push(plural(refs.bookingRules, 'flex booking rule', 'flex booking rules'));
  }
  if (refs.timeframes) parts.push(plural(refs.timeframes, 'fare timeframe', 'fare timeframes'));
  const list = parts.length > 1
    ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
    : parts[0];
  return `Can't delete this calendar: it is used by ${list}. Move them to another calendar or delete them first.`;
}
