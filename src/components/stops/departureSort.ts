import { gtfsTimeToSeconds } from '../../utils/time';

/**
 * Order two GTFS times chronologically. Imported feeds keep times verbatim, and
 * GTFS allows an unpadded hour ("9:00:00"), so a string compare puts 10:00
 * before 9:00. Compare seconds instead (overnight 25:30:00 sorts last).
 */
export function compareGtfsTimes(a: string, b: string): number {
  return gtfsTimeToSeconds(a) - gtfsTimeToSeconds(b);
}
