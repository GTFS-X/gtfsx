# Expiry live-check — design notes and outcome

**Status: BUILT and run, same day (2026-07-31)**, after Mark authorized it —
`scripts/feed-health/phase_c2_expiry_check.py` implements the design below exactly
as specified (calendar.txt primary, feed_info.txt fallback,
`feed_info_contradicts_calendar` flag, size/timeout caps, per-host politeness). It
ran against all 1,221 agencies with a reachable feed URL (not just the 272 on stale
captures), and `get_status()` in `feed-health-publish.py` now consumes its output as
described in "Recommended design" below. The manual override tables mentioned
throughout this doc as a "stopgap" (`CONFIRMED_NOT_EXPIRED_DESPITE_STALE_MDB`,
`CONFIRMED_SERVICE_END_OVERRIDES`, `STALE_CAPTURE_DISCARD_ERROR_COUNT`) have been
**deleted** — confirmed the live check independently reproduces the same corrected
values for all 5 agencies they covered before removing them. Results: 95
agencies flipped expired→ok, **60 flipped ok→expired** (the invisible-error count —
see chat history / commit message for the full breakdown), 2 flipped invalid→expired,
172 agencies have a `feed_info_contradicts_calendar` flag, and 40 feeds
(3.3% of candidates) failed to fetch and fall back to MDB's value untouched. The
rest of this document is the original design reasoning — still accurate, kept as
the historical record of *why* it was built this way, since a future maintainer
tempted to "simplify" the fallback chain back toward feed_info.txt should find the
argument already made.

---

Written 2026-07-31, during a feed-health dashboard audit triggered by a false-negative
bug found in a sibling outreach pipeline (`gtfsx-marketing/campaign_c_outreach/verify.py` —
a hardcoded Transit.land `adm1_iso` state filter + poor name-matching on garbled NTD
legal names). This dashboard's pipeline was cleared of that specific bug — it never
calls Transit.land — but the audit surfaced a separate, real correctness problem in how
`mdb_expired` is computed, described below. This doc is the reasoning that led to the
build above.

## The problem

`phase_d_mdb.py` sets `mdb_expired` from Mobility Database's `service_date_range_end`,
which MDB computes from **its own last captured dataset** for that feed — not from the
feed's current, live content. MDB recrawls smaller agencies' feeds on a very irregular
cadence (captures found during this audit ranged from days old to over four years old).
An agency can republish a current feed at the same URL and continue showing "expired"
here for as long as MDB takes to recrawl it — which can be a year or more.

## Confirmed case: High Point Transit (NC), NTD 40011 / MDB tld-4135

MDB's Aug-2025 capture reports `service_date_range_end: 2026-07-01T03:59:00Z`. Live
download of the registered feed URL (`highpointnc.gov/DocumentCenter/View/7138/Transit-Feed`)
on 2026-07-31 found:
- `calendar.txt`: service_ids `Effective_2025-0825-Weekday` / `-Sa` run `20250825`–`20261231`.
- `feed_info.txt`: `feed_start_date=20250825, feed_end_date=20260630`.
- MD5 of the live file (`a48cd6ae...`) does **not** match MDB's captured hash
  (`74ce9c85...`) — the file at the URL has genuinely changed since MDB's capture.

So the feed's own two metadata sources disagree with each other: `calendar.txt` says
service continues through the end of 2026; `feed_info.txt` says the export is only
valid through mid-2026. This is not hypothetical — it's the exact shape of case the
live-check design (below) has to handle, and it's why this doc records how we resolved
it rather than leaving a future reader to re-derive the same argument.

### The disagreement, briefly

A first pass overruled the "not expired" fix on the theory that `feed_end_date` was a
deliberate publisher declaration ("we don't stand behind data past this date") and that
the calendar's extension past it was the anomaly. That was wrong, for three reasons,
and the fix was left in place:

1. **The site's own published methodology already defines "expired" via calendar.txt /
   calendar_dates.txt**, not feed_info.txt (see `public/feed-health/fh.js`,
   Methodology → Definitions). Letting feed_info govern would make that copy inaccurate
   for this record.
2. **`feed_end_date` is an OPTIONAL GTFS field** and is a well-known ecosystem pattern
   to go stale — agencies' feed-generation pipelines routinely roll `calendar.txt`
   forward automatically without a human touching `feed_info.txt`. The hash mismatch
   is direct evidence *something* in this zip changed since Aug 2025; "the calendar
   got rolled forward, the metadata wasn't" is the far more parsimonious read than "the
   agency deliberately re-exported the whole zip while carefully preserving a stale
   cutoff declaration."
3. **Real consumers — Google Transit, Transit App, OneBusAway, and the canonical GTFS
   validator's own service-window computation — determine whether a route runs on a
   given day from `calendar.txt`/`calendar_dates.txt`, not `feed_info.txt`.** If a major
   trip planner is showing live High Point predictions past July 2026 (which the
   calendar says it should), calling the feed "expired" here is a visible, real mislabel
   of a working agency — the exact failure mode this audit exists to catch. Trusting
   feed_info's soft, often-neglected metadata over the field that actually drives real
   service is the wrong direction to be confidently wrong in.

**Conclusion: calendar.txt is authoritative. feed_info.txt is a fallback for feeds that
lack calendar data, not an override for feeds that have it.**

## Recommended design — four-step fallback chain

When building the live check (extending Phase C, which already streams every
registered URL to confirm it returns a zip):

1. **Primary: compute the max service date from `calendar.txt` + `calendar_dates.txt`**
   (the feed's actual service window — matches our methodology, matches how real trip
   planners decide if a route runs).
2. **Fallback: `feed_info.txt`'s `feed_end_date`**, used only when the feed has no
   calendar data to compute from (rare, but `feed_info.txt` is itself optional too, so
   both can be absent).
3. **Fallback: MDB's own stale `service_date_range_end`**, used only when the live
   fetch itself fails (unreachable URL, timeout, oversized feed — see risks below).
4. **When calendar.txt and feed_info.txt both exist and materially disagree** (as
   High Point's do), don't silently pick one and move on — **record a
   `feed_info_contradicts_calendar` boolean.** This is genuine feed-hygiene signal in
   its own right (a real data-quality note: "this agency's feed metadata disagrees
   with its own calendar"), independent of whatever status it resolves to. Surfacing
   it costs nothing extra once both dates are already being parsed.

### Known implementation risks (why this is "same-day to one-day," not a one-liner)

- **Feed size.** Most GTFS static feeds are a few hundred KB to a few MB; a handful of
  large agencies (CTA, NJ Transit, WMATA-scale) run 50–150MB. Downloading in full for
  ~1,150 URLs (the current count with a working FTA weblink) needs a size cap and
  timeout, with graceful fallback to step 3 (MDB's value) when a feed is skipped.
- **Zip layout.** Use `zipfile`'s own recursive lookup (find `calendar.txt` wherever it
  lives in the archive) rather than requiring root placement. GoTriangle's feed (see
  below) nests everything inside a subfolder — that's a real *validator/packaging*
  concern (correctly flagged by MDB's canonical validator as an error), but it
  shouldn't also break *our* expiry computation, which is a different question from
  "is this feed spec-conformant packaging."
- **calendar_dates.txt-only feeds.** Some feeds have no `calendar.txt` at all and
  define service purely via `calendar_dates.txt` exceptions (`exception_type=1`
  entries only) — the parser needs to handle this, not just read `calendar.txt` and
  assume absence means "no service."
- **Keep "invalid" MDB-sourced.** Reimplementing the actual canonical GTFS validator
  ourselves would be a much bigger, unwarranted undertaking. During this audit, MDB's
  validator output was confirmed trustworthy when the capture is recent — checked
  against GoTriangle (mdb-3183): its 2026-07-30 capture's MD5 hash matched a live
  download exactly, and the reported errors (`invalid_input_files_in_subfolder`,
  `missing_calendar_and_calendar_date_files`, `missing_required_file` ×5, from
  `report_8.0.1.json`) were real and current — caused by GoTriangle's just-published
  feed nesting all its files inside a `GoTriangle_GTFS_Aug2026/` subfolder instead of
  at the zip root. Since we can already tell how recent a capture is (this same audit),
  "invalid" status can reasonably keep trusting MDB when the capture is fresh, and this
  live check is specifically about the expiry axis, which is the one MDB gets stale
  for even on captures that were accurate the day they were taken.

## Exposure — how big is this, really

Of 809 agencies matched to an MDB feed, **272 (33.6%) have their status derived from a
capture older than 6 months.** Current published status of those 272:

| Status (as currently published) | Count |
|---|---|
| expired | 157 |
| invalid | 24 |
| **ok** | **91** |

**The 91 "ok" rows are the more dangerous half of this number.** A wrong "expired" is
visible and gets caught (as High Point was, twice, during this one audit session). A
wrong "ok" is invisible — we'd be telling a rider or an agency's own staff that a feed
is fine when it may have quietly broken months ago, with no signal anywhere on the
dashboard prompting anyone to check.

**Error rate: a 9-agency stratified sample of the "expired" slice of these 272 found 5
wrong (confirmed current on live download: High Point NC, Santa Barbara Clean Air
Express CA, Okanogan County WA, Casco Bay Lines ME, Marin Transit CA) and 4 genuinely
still expired (Benson Area Transit AZ, Big Bend Transit FL, City of Cleburne TX, Santa
Fe Trails NM).** That is a small sample (n=9) of one slice (expired) of the 272 —
report it as "roughly half wrong in a 9-agency sample," not as a measured ~50% rate
across the whole population. It's a strong enough signal to justify building the live
check; it is not a precise estimate of how many of the 272 are actually wrong.

## Former stopgap — retired, deleted from the code

Before the live check was built, `phase_d_mdb.py` carried two manual override
tables applied as a one-time fix, both keyed by `(ntd_id_normalized, mdb_id)`:

- `CONFIRMED_NOT_EXPIRED_DESPITE_STALE_MDB` — forced `mdb_expired=False` for the 5
  agencies above confirmed current by live download. Paired with
  `CONFIRMED_SERVICE_END_OVERRIDES` in `feed-health-publish.py`, which corrected the
  *displayed* "Service ends &lt;date&gt;" line (a separate code path, reading
  `mdb_us_feeds.json` directly rather than the CSV) to the real date found on each
  agency's live calendar.
- `STALE_CAPTURE_DISCARD_ERROR_COUNT` — cleared `mdb_total_error` for 3 of those 5
  (Okanogan, Casco Bay, Marin) whose nonzero validator-error counts came from that same
  superseded MDB capture and had been silently masked by `get_status()`'s
  `expired > invalid` priority order once the wrong "expired" was cleared.

**Both are now deleted.** They covered only the specific agencies spot-checked during
the audit, not a general fix — hand-curated overrides were never the intended
long-term mechanism, just the fastest way to correct known-wrong public records before
the real fix existed. They're replaced by two things that apply to the whole roster
automatically instead of needing a human to list which agencies were affected:

1. `phase_c2_expiry_check.py` computing `own_expired` directly, superseding
   `CONFIRMED_NOT_EXPIRED_DESPITE_STALE_MDB` and `CONFIRMED_SERVICE_END_OVERRIDES`
   entirely (`get_status()` and `serviceEnd` both prefer the live-computed value).
2. `get_status()`'s "superseded-capture" rule — if `own_expired == "False"` but
   `mdb_expired == "True"`, that disagreement itself proves MDB's capture is stale
   for this agency, so `mdb_total_error` from that same capture is treated as
   equally untrustworthy and the row falls through to "ok" rather than "invalid".
   This generalizes `STALE_CAPTURE_DISCARD_ERROR_COUNT` to every agency where the
   same pattern occurs, not just the 3 found by hand.

Confirmed before deleting: re-running the pipeline with both retired produced the
exact same result for High Point Transit, Santa Barbara Clean Air Express, Okanogan
County, Casco Bay Lines, and Marin Transit as the manual overrides had.

## Cost estimate (as scoped, before building)

Estimated same-day to one-day for a first working version — extend Phase C's existing
per-URL fetch (a partial read to confirm zip magic bytes) to a full, size/timeout-bounded
download + `zipfile` open + the parse logic above, for the ~1,150-1,220 URLs that pass
reachability. **Actual: built and run same day**, ~1 hour including validation against
the known test cases and the full ~1,220-feed crawl (which itself took ~3 minutes at
8-way bounded concurrency with per-host politeness).
