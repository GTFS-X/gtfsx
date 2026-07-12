// RTAP feed detection — a best-effort, copy-only heuristic for whether an
// imported feed was likely built with National RTAP's "GTFS Builder" (a free
// Excel-based tool widely used by rural/tribal transit agencies to produce
// their first GTFS feed).
//
// TODO(rtap-fingerprint): CONFIRMED against a real sample (Skyline Bus / Big
// Sky MT, National RTAP GTFS Builder export, pulled 2026-07-12 from
// rapid.nationalrtap.org):
//   - The feed contains NO literal "rtap" string anywhere (agency.txt,
//     feed_info.txt, ids) — it is entirely agency-branded. A pure string
//     match on "rtap"/"National RTAP" MISSES real exports; see below for why
//     the string checks are kept anyway.
//   - shapes.txt is PRESENT with a header row but ZERO data rows (the tool
//     omits geometry by leaving the file empty, not by leaving the file out).
//     trips.txt has a shape_id column with every value blank.
//   - Every .txt file starts with a UTF-8 BOM (EF BB BF) — an Excel-export
//     tell. PapaParse strips this from parsed field names, so it can only be
//     captured from the raw pre-parse text (done in gtfsParse.ts; see
//     BuilderSignals there).
//   - routes/stops/stop_times/trips.txt all carry a fixed, full set of
//     optional columns (route_desc, route_sort_order, stop_desc, zone_id,
//     platform_code, stop_headsign, continuous_pickup/drop_off, timepoint,
//     block_id, wheelchair_accessible, bikes_allowed, …) as headers whether
//     populated or not — consistent with a spreadsheet template.
// STILL OPEN (only one sample in hand — don't over-index on it):
//   - Is the BOM + empty-shapes + full-column-set combination distinctive to
//     THIS tool, or common to Excel-based GTFS builders generally (there are
//     several)? We can't tell from n=1. Treat the structural match as "looks
//     like a spreadsheet/GTFS-Builder-style export," never as "is RTAP."
//   - Column ORDER and any id-naming convention weren't compared against a
//     second sample — don't add an order-sensitive check without one.
//   - Whether feed_publisher_name/url or agency_url ever DOES contain an
//     RTAP self-identification in some other agency's export (the Skyline
//     sample didn't, but a different agency's data-entry habits might).
// Get a second real sample before tightening or loosening any of this.

import type { FeedInfo, Agency } from '../types/gtfs';
import type { BuilderSignals } from './gtfsParse';

export interface RtapSignals {
  isRtap: boolean;
  confidence: 'high' | 'low';
  /** Human-readable reasons, for the UI/debugging. */
  signals: string[];
}

const NO_SIGNALS: RtapSignals = { isRtap: false, confidence: 'low', signals: [] };

/**
 * Best-effort RTAP / "GTFS Builder"-style export detector. Combines two very
 * different kinds of evidence:
 *   1. An explicit textual self-identification ("National RTAP" / a
 *      nationalrtap.org URL) — unambiguous when present, but per the real
 *      sample above, RARELY present. High confidence.
 *   2. The structural signature confirmed on that same real sample (BOM on
 *      every core file + header-only shapes.txt + a fixed full set of
 *      optional columns). This identifies "looks like a spreadsheet/GTFS-
 *      Builder-style export," which is NOT provably unique to National RTAP —
 *      only ever 'low' confidence, and only fires when ALL THREE structural
 *      signals line up together (any one alone is far too common to mean
 *      anything: plenty of ordinary feeds have a BOM, or omit shapes, or
 *      happen to populate a lot of optional columns).
 *
 * This is acceptable specifically BECAUSE detectRtapFeed is copy-only: it
 * never gates whether the shapes-from-stops fix is offered (feedNeedsShapes
 * does that on its own, from actual geometry), only how the offer is worded.
 * Getting the "looks like RTAP" line wrong costs nothing but a slightly-off
 * sentence; it never blocks or mis-fires the actual repair.
 *
 * PURE. Absence of any signal is the overwhelmingly common case and should
 * read as "no basis to say so," not "confirmed not RTAP."
 */
export function detectRtapFeed(
  feedInfo: FeedInfo | null | undefined,
  agencies: Agency[],
  builderSignals?: BuilderSignals | null,
): RtapSignals {
  const signals: string[] = [];
  let high = false;

  // Candidate free-text fields to scan. feed_info.txt is the most likely spot
  // for a tool/publisher stamp; agency.txt is included because a small agency
  // using RTAP's tool may leave the sample agency_url pointed at RTAP's own
  // site if they don't have a website of their own yet.
  const nameFields: Array<{ label: string; value: string | undefined }> = [
    { label: 'feed_publisher_name', value: feedInfo?.feed_publisher_name },
    { label: 'feed_version', value: feedInfo?.feed_version },
    ...agencies.map((a, i) => ({ label: `agency.txt row ${i + 1} agency_name`, value: a.agency_name })),
  ];
  const urlFields: Array<{ label: string; value: string | undefined }> = [
    { label: 'feed_publisher_url', value: feedInfo?.feed_publisher_url },
    ...agencies.map((a, i) => ({ label: `agency.txt row ${i + 1} agency_url`, value: a.agency_url })),
  ];

  // High-confidence: an exact "National RTAP" phrase, or a URL whose host is
  // (or clearly is) RTAP's own domain — these are unambiguous mentions of the
  // organization itself, not just the acronym. Kept even though the one real
  // sample we have doesn't trigger it: it costs nothing, and will fire on
  // feeds from agencies (or a tool version) that DO self-identify.
  for (const { label, value } of nameFields) {
    if (value && /national\s*rtap/i.test(value)) {
      signals.push(`${label} mentions "National RTAP"`);
      high = true;
    }
  }
  for (const { label, value } of urlFields) {
    if (value && /nationalrtap\.org/i.test(value)) {
      signals.push(`${label} points at nationalrtap.org`);
      high = true;
    }
  }

  // Low-confidence: a bare "rtap" or "gtfs builder" mention. Weaker because
  // "rtap" is also a generic acronym (state RTAPs, unrelated orgs) and
  // "gtfs builder" is a generic-sounding tool name.
  if (!high) {
    for (const { label, value } of [...nameFields, ...urlFields]) {
      if (value && /\brtap\b/i.test(value)) {
        signals.push(`${label} mentions "RTAP"`);
      } else if (value && /gtfs\s*builder/i.test(value)) {
        signals.push(`${label} mentions "GTFS Builder"`);
      }
    }
  }

  // Structural fallback — the signature that actually fires on real RTAP
  // exports, since they carry no self-identifying string at all. Requires
  // ALL THREE signals together (see doc comment); never raises confidence
  // above 'low'.
  if (builderSignals) {
    const { hasUtf8Bom, shapesFileHeaderOnly, emitsAllOptionalColumns } = builderSignals;
    if (hasUtf8Bom && shapesFileHeaderOnly && emitsAllOptionalColumns) {
      signals.push(
        'structural match: UTF-8 BOM + header-only shapes.txt + full optional-column set ' +
        '(looks like a spreadsheet/GTFS-Builder-style export; not provably RTAP specifically)',
      );
    }
  }

  if (signals.length === 0) return NO_SIGNALS;
  return { isRtap: true, confidence: high ? 'high' : 'low', signals };
}
