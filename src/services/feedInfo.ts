// feed_info.txt helpers: spec validation, the "dates from service calendar"
// and "bump version" helpers, and the feed_end_date-behind-service check.
// Pure (no store import) so the validator, the fix recipe, the editor panel and
// the tsx editor-test harness can all use it.
//
// Spec: https://gtfs.org/documentation/schedule/reference/#feed_infotxt
import type { Calendar, CalendarDate, FeedInfo } from '../types/gtfs';
import { isWellFormedLanguageTag, MULTILINGUAL_FEED_LANG } from './translations';

/** feed_info publisher on every export and publish (gtfsExport
 *  buildFeedInfoRow; product decision 2026-06-22). */
export const GTFSX_PUBLISHER_NAME = 'GTFS·X';
export const GTFSX_PUBLISHER_URL = 'https://gtfsx.com';

export type FeedInfoField =
  | 'feed_lang' | 'default_lang'
  | 'feed_start_date' | 'feed_end_date' | 'feed_version'
  | 'feed_contact_email' | 'feed_contact_url';

export interface FeedInfoIssue {
  field: FeedInfoField;
  message: string;
}

// ─── Value formats ─────────────────────────────────────────────────────────

/** A GTFS Date: YYYYMMDD naming a real calendar day. */
export function isValidGtfsDate(d: string | undefined | null): boolean {
  if (!d || !/^\d{8}$/.test(d)) return false;
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(4, 6));
  const day = Number(d.slice(6, 8));
  const dt = new Date(Date.UTC(y, m - 1, day));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === day;
}

/** YYYYMMDD → YYYY-MM-DD (the value <input type="date"> takes); '' when not a
 *  valid GTFS date, so a malformed import shows as blank-with-error rather
 *  than a garbled picker. */
export function gtfsDateToIso(d: string | undefined): string {
  return d && isValidGtfsDate(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : '';
}

/** YYYY-MM-DD → YYYYMMDD ('' for an empty picker). */
export function isoToGtfsDate(iso: string): string {
  return iso.replace(/-/g, '');
}

/** Today in the browser's local calendar as YYYYMMDD. */
export function todayGtfsDate(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
}

/** GTFS URL: a fully qualified URL including http:// or https://. */
export function isValidFeedUrl(u: string | undefined | null): boolean {
  const s = (u ?? '').trim();
  if (!s) return false;
  try {
    const url = new URL(s);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.includes('.');
  } catch {
    return false;
  }
}

/** GTFS Email: a plain address (no display name, no mailto:). */
export function isValidEmail(e: string | undefined | null): boolean {
  return /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/.test((e ?? '').trim());
}

// ─── Validation ────────────────────────────────────────────────────────────

/**
 * Spec problems with the values a user has entered. Blank optional fields are
 * fine. feed_lang is required by the spec, but the exporter fills it from the
 * agency language when blank, so blank is not an issue here. The publisher
 * pair is not checked: the export always writes GTFS·X there, and the stored
 * (imported) values are display-only.
 *
 * `includeLanguages` = false lets the validator skip feed_lang/default_lang,
 * which the translations rules in validation.ts already report.
 */
export function validateFeedInfo(
  info: FeedInfo | null | undefined,
  opts: { includeLanguages?: boolean } = {},
): FeedInfoIssue[] {
  const out: FeedInfoIssue[] = [];
  if (!info) return out;
  const t = (v: string | undefined) => (v ?? '').trim();

  if (opts.includeLanguages !== false) {
    const fl = t(info.feed_lang);
    if (fl && fl !== MULTILINGUAL_FEED_LANG && !isWellFormedLanguageTag(fl)) {
      out.push({ field: 'feed_lang', message: `"${fl}" isn't a valid BCP 47 language code (e.g. "en", "es", "fr-CA").` });
    }
    const dl = t(info.default_lang);
    if (dl && !isWellFormedLanguageTag(dl)) {
      out.push({ field: 'default_lang', message: `"${dl}" isn't a valid BCP 47 language code (e.g. "en", "es", "fr-CA").` });
    }
  }

  const start = t(info.feed_start_date);
  const end = t(info.feed_end_date);
  const startOk = !start || isValidGtfsDate(start);
  const endOk = !end || isValidGtfsDate(end);
  if (!startOk) out.push({ field: 'feed_start_date', message: `Start date "${start}" isn't a valid date (GTFS dates are YYYYMMDD).` });
  if (!endOk) out.push({ field: 'feed_end_date', message: `End date "${end}" isn't a valid date (GTFS dates are YYYYMMDD).` });
  if (start && end && startOk && endOk && start > end) {
    out.push({ field: 'feed_end_date', message: 'End date is before the start date.' });
  }

  const email = t(info.feed_contact_email);
  if (email && !isValidEmail(email)) {
    out.push({ field: 'feed_contact_email', message: `"${email}" isn't a valid email address.` });
  }
  const curl = t(info.feed_contact_url);
  if (curl && !isValidFeedUrl(curl)) {
    out.push({ field: 'feed_contact_url', message: 'Contact URL must be a full web address starting with http:// or https://.' });
  }
  return out;
}

// ─── Service calendar window ───────────────────────────────────────────────

export interface ServiceDateRange { start: string; end: string; }

/**
 * The span the feed's service calendar covers: the earliest calendar.txt
 * start_date / added calendar_dates.txt date through the latest end_date /
 * added date. Only `exception_type = 1` (service added) calendar_dates rows
 * count: a "no service" row can't extend the window, it only removes a day.
 * Malformed dates are ignored. Null when there is no service at all.
 */
export function serviceDateRange(
  calendars: readonly Calendar[],
  calendarDates: readonly CalendarDate[],
): ServiceDateRange | null {
  let start: string | null = null;
  let end: string | null = null;
  const consider = (d: string | undefined) => {
    if (!d || !isValidGtfsDate(d)) return;
    if (start === null || d < start) start = d;
    if (end === null || d > end) end = d;
  };
  for (const c of calendars) {
    if (!isValidGtfsDate(c.start_date) || !isValidGtfsDate(c.end_date) || c.start_date > c.end_date) continue;
    consider(c.start_date);
    consider(c.end_date);
  }
  for (const cd of calendarDates) {
    if (Number(cd.exception_type) === 1) consider(cd.date);
  }
  return start !== null && end !== null ? { start, end } : null;
}

/**
 * feed_end_date ends before the service calendar does — the stale-import case
 * (an exported feed_info window from years ago over calendars that have since
 * been extended). Apps and validators read feed_end_date as the feed's expiry,
 * so this makes a live feed look expired. Null when there's nothing to fix.
 */
export function feedEndBehindService(
  info: FeedInfo | null | undefined,
  range: ServiceDateRange | null,
): { feedEnd: string; serviceEnd: string } | null {
  const feedEnd = info?.feed_end_date?.trim();
  if (!range || !feedEnd || !isValidGtfsDate(feedEnd)) return null;
  return feedEnd < range.end ? { feedEnd, serviceEnd: range.end } : null;
}

// ─── Version ───────────────────────────────────────────────────────────────

/**
 * A date-based feed_version for today: `YYYYMMDD`, or `YYYYMMDD-2`, `-3`, … when
 * the current version is already today's, so two releases on one day still
 * get distinct versions.
 */
export function nextFeedVersion(current: string | undefined, now: Date = new Date()): string {
  const today = todayGtfsDate(now);
  const cur = (current ?? '').trim();
  if (cur === today) return `${today}-2`;
  const m = cur.match(/^(\d{8})-(\d+)$/);
  if (m && m[1] === today) return `${today}-${Number(m[2]) + 1}`;
  return today;
}
