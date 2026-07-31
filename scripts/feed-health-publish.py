#!/usr/bin/env python3
"""
GTFS Feed Health publish script — canonical export → public assets.

Fetches the canonical, versioned Feed Health export published by
https://github.com/GTFS-X/gtfs-feed-health (exports/feed_health.json, schema
documented in that repo's docs/SCHEMA.md, current schemaVersion "1.0.0") and
transforms it into this site's dashboard assets:
  1. public/feed-health/data/agencies/<ABBR>.json  (51 files: 50 states + DC)
  2. public/feed-health/fh-data.js                 (aggregated national/state stats)

This script no longer runs any NTD/FTA-Weblinks/Mobility-Database pipeline
itself — that pipeline (formerly scripts/feed-health/*.py in this repo) has
been extracted into GTFS-X/gtfs-feed-health, which now owns it and refreshes
its export automatically on the 5th of each month. This script is
presentation-layer only: fetch the export, map field names, aggregate, write.
Every row already carries a fully computed `status` (see SCHEMA.md) — this
script does not reimplement that logic, it just reads the field.

Fetch design — pinned + verifiable, but still tracks upstream automatically:
  1. Resolve a ref (default "main") to a commit SHA via the GitHub API
     (`gh api` when available — dodges the low unauthenticated rate limit,
     and GitHub Actions has `gh`/GITHUB_TOKEN pre-wired; falls back to an
     unauthenticated api.github.com call otherwise).
  2. Fetch exports/feed_health.json from the CONTENT-ADDRESSED raw URL at
     that resolved SHA (raw.githubusercontent.com/.../<sha>/exports/...),
     never from a mutable branch-name URL directly. This is what makes the
     fetch "pinned and verifiable" (immutable content) while still
     auto-tracking upstream's latest each run, since main->SHA is re-resolved
     fresh every run.
  3. The resolved SHA, the export's schemaVersion, and its generatedAt are
     recorded in the header comment of the regenerated fh-data.js (and in
     public/feed-health/data/provenance.json) — not as new keys on the
     existing JS objects, to keep the emitted artifacts' *structure*
     unchanged from before this rewiring.

Usage:
  python3 scripts/feed-health-publish.py                        # fetch live export, resolve main fresh
  python3 scripts/feed-health-publish.py --ref <sha-or-branch>   # pin to a specific commit/branch
  python3 scripts/feed-health-publish.py --export-json path.json # offline/local file, no network fetch
  uv run scripts/feed-health-publish.py [same flags]
"""

import argparse, json, os, re, shutil, subprocess, sys
import urllib.error, urllib.request
from datetime import date, datetime, timezone

SOURCE_REPO = "GTFS-X/gtfs-feed-health"
SUPPORTED_SCHEMA_MAJOR = 1  # this script is written against schemaVersion "1.x"

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_AGENCIES   = os.path.join(REPO_ROOT, "public", "feed-health", "data", "agencies")
OUT_FHDATA     = os.path.join(REPO_ROOT, "public", "feed-health", "fh-data.js")
OUT_PROVENANCE = os.path.join(REPO_ROOT, "public", "feed-health", "data", "provenance.json")

# ── State metadata: abbr → (fips, full_name, region) ──────────────────────────
STATES_META = {
    "AL": ("01", "Alabama",               "South"),
    "AK": ("02", "Alaska",                "West"),
    "AZ": ("04", "Arizona",               "West"),
    "AR": ("05", "Arkansas",              "South"),
    "CA": ("06", "California",            "West"),
    "CO": ("08", "Colorado",              "West"),
    "CT": ("09", "Connecticut",           "Northeast"),
    "DE": ("10", "Delaware",              "Northeast"),
    "DC": ("11", "District of Columbia",  "Northeast"),
    "FL": ("12", "Florida",               "South"),
    "GA": ("13", "Georgia",               "South"),
    "HI": ("15", "Hawaii",                "West"),
    "ID": ("16", "Idaho",                 "West"),
    "IL": ("17", "Illinois",              "Midwest"),
    "IN": ("18", "Indiana",               "Midwest"),
    "IA": ("19", "Iowa",                  "Midwest"),
    "KS": ("20", "Kansas",                "Midwest"),
    "KY": ("21", "Kentucky",              "South"),
    "LA": ("22", "Louisiana",             "South"),
    "ME": ("23", "Maine",                 "Northeast"),
    "MD": ("24", "Maryland",              "Northeast"),
    "MA": ("25", "Massachusetts",         "Northeast"),
    "MI": ("26", "Michigan",              "Midwest"),
    "MN": ("27", "Minnesota",             "Midwest"),
    "MS": ("28", "Mississippi",           "South"),
    "MO": ("29", "Missouri",              "Midwest"),
    "MT": ("30", "Montana",               "West"),
    "NE": ("31", "Nebraska",              "Midwest"),
    "NV": ("32", "Nevada",                "West"),
    "NH": ("33", "New Hampshire",         "Northeast"),
    "NJ": ("34", "New Jersey",            "Northeast"),
    "NM": ("35", "New Mexico",            "West"),
    "NY": ("36", "New York",              "Northeast"),
    "NC": ("37", "North Carolina",        "South"),
    "ND": ("38", "North Dakota",          "Midwest"),
    "OH": ("39", "Ohio",                  "Midwest"),
    "OK": ("40", "Oklahoma",              "South"),
    "OR": ("41", "Oregon",                "West"),
    "PA": ("42", "Pennsylvania",          "Northeast"),
    "RI": ("44", "Rhode Island",          "Northeast"),
    "SC": ("45", "South Carolina",        "South"),
    "SD": ("46", "South Dakota",          "Midwest"),
    "TN": ("47", "Tennessee",             "South"),
    "TX": ("48", "Texas",                 "South"),
    "UT": ("49", "Utah",                  "West"),
    "VT": ("50", "Vermont",               "Northeast"),
    "VA": ("51", "Virginia",              "South"),
    "WA": ("53", "Washington",            "West"),
    "WV": ("54", "West Virginia",         "South"),
    "WI": ("55", "Wisconsin",             "Midwest"),
    "WY": ("56", "Wyoming",               "West"),
}
# FIPS order (used to order STATES in fh-data.js)
STATES_FIPS_ORDER = sorted(STATES_META.keys(), key=lambda a: STATES_META[a][0])

# Territories present in the export that are excluded from state outputs
TERRITORIES = {"AS", "GU", "MP", "PR", "VI"}

# ── Canonical validation targets ───────────────────────────────────────────────
# Checked against the FETCHED EXPORT'S OWN `nationalAggregates` envelope (it already
# ran its own equivalent drift guard before publishing, in gtfs-feed-health's
# scripts/export.py — see that repo's docs/SCHEMA.md "Drift guard"). We are no
# longer recomputing these from raw MDB fields ourselves: the new export doesn't
# expose the pre-live-check raw `mdb_expired` field the old CSV pipeline used for
# this same check (only the final, live-check-overlaid `status` per row) — see
# "Retired: recompute-from-raw-CSV validation" below for why that's fine.
#
# Updated 2026-06-12: removed four confirmed-false MDB matches (Ludington MTA/mdb-926
# was the only pair with no FTA weblink; no_feed count 1017 -> 1018, pct 45.4 -> 45.5).
# Updated 2026-06-12 (fuzzy-fix): three-tier fuzzy policy added. 11 audit-reviewed correct
# pairs in the 90-94 band restored via CONFIRMED_GOOD_MATCHES allowlist in phase_d_mdb.py,
# including 80227 (SCCOG CO) and 80299 (Silver Key CO) which had no FTA weblink.
# Updated 2026-06-12 (dark-Full-Reporter join fixes), all against the June 7 inputs:
#   - norm_url now keeps identity-bearing query strings (drive.google.com/uc?...id=X),
#     un-joining Mission Hill Link 10182 from Long Beach Transit's mdb-1198 and freeing
#     mdb-1198 (-> 90023 via fuzzy 100) and tld-319 (-> 40094 ATI Puerto Rico).
#   - CONFIRMED_GOOD_MATCHES now applies at ANY fuzzy score (Pass 2.5 direct pass);
#     added 20098/mdb-517 (PATH, expired), 40043/tld-6773 (Wave Transit, ok),
#     60033/mdb-2264 (Rock Region METRO, expired).
#   - MANUAL_WEBLINKS supplement: 60038 Lafayette Transit System (lts.syncromatics.com).
#   Net: no_feed 1018 -> 1013/2238 = 45.26% -> still renders 45 (matches fh.js hero);
#   matched 788 (denominator unchanged: -10182 +90023 +3 manual), fail 100/788 = 12.7%,
#   expired 172/788 = 21.8% (PATH, Rock Region, ATI all expired).
# Updated 2026-06-17 ("no findable feed" audit): 11 agencies previously status=none
# confirmed as the SAME agency as a real MDB feed and added to CONFIRMED_GOOD_MATCHES
# (phase_d_mdb.py). They join the findable + matched populations:
#   no_feed   1013 -> 1002 / 2238 = 44.77% -> still renders 45 (matches fh.js hero).
#   matched   788  -> 799  (all 11 carry an MDB validation report).
#   expired   172  -> 175  (20958/40038/40208 have stale service_end) -> 175/799 = 21.9%.
#   fail      100  -> 104  (40038/40208 expired-with-errors + 91018/91041 invalid) ->
#             104/799 = 13.0%.
# Updated 2026-07-31 (feed-health dashboard audit + refresh): the scheduled 2026-07-05
# monthly run aborted here (expired_pct computed=22.6% vs canonical=21.9%, delta 0.71pp >
# 0.5pp limit), which is why the live site was still serving 2026-06-07-vintage data for
# nearly two months. A full fresh Phase A-D run that day found NO methodology regression;
# baseline bumped to that day's validated numbers (N=2238, no_feed=44.7%, expired=21.7%,
# fail_validation=12.9%) — see git history for the full account of that in-repo pipeline
# run, since retired (below).
# Updated 2026-07-31 (dashboard rewiring — SAME DAY, follow-up): this repo's own copy of
# the pipeline (scripts/feed-health/*) is retired. The dashboard now consumes the
# canonical export published by GTFS-X/gtfs-feed-health, which runs the equivalent Phase
# A-D + live-expiry-check logic (including the fuzzy-match/CONFIRMED_GOOD_MATCHES/
# live-check work summarized above) and already ran its own drift guard before
# publishing. Fetched exports/manifest.json today: schemaVersion "1.0.0",
# nationalAggregates {noFeedAnywherePct: 44.7, expiredPctOfMatched: 21.7,
# failValidationPct: 12.9}, rowCount 2238 — IDENTICAL to the baseline below (both
# repos' baselines were refreshed the same day during the extraction), so CANONICAL's
# *values* did not need to change, only what this guard compares them against: the
# fetched export's own `nationalAggregates` envelope, not a local recomputation from
# raw CSV columns (see validate_national() below).
CANONICAL = {
    "N_roster":              2238,    # full NTD 2024 universe incl. territories
    "no_feed_anywhere_pct":  44.7,    # export nationalAggregates.noFeedAnywherePct
    "fail_validation_pct":   12.9,    # export nationalAggregates.failValidationPct
    "expired_pct_of_matched": 21.7,   # export nationalAggregates.expiredPctOfMatched
}

# Retired: recompute-from-raw-CSV validation (validate_national() used to independently
# recompute no_feed/expired/fail percentages from raw ntd_feed_health.csv columns,
# including the pre-live-check raw `mdb_expired` field, as a sanity check on the
# PIPELINE's raw output). The new export doesn't expose that raw pre-live-check field
# at all (only the final, already-live-check-corrected `status` per SCHEMA.md) — nor
# does it need to, since the pipeline itself (now upstream) already runs this exact
# guard before publishing. We instead check the fetched export's own precomputed
# `nationalAggregates` against CANONICAL — same tolerance, same spirit, different
# data source. See validate_national().
#
# Note this also means the rendered "% expired" shown in HEADLINE and per-state STATES
# below is now computed from `status == "expired"` (the live-check-corrected, badge-
# consistent field) rather than the old raw `mdb_expired` (pre-live-check, MDB-capture-
# only) field the CSV pipeline used for that same rendered number. This is a real,
# expected DROP in the displayed expired percentage (roughly 22% -> ~10%) — not a bug.
# This repo's own prior audit (see git history, June-July 2026) already found MDB's raw
# captures overstate "expired" for infrequently-recrawled agencies; the new number is
# the more accurate one and is now consistent with what each individual agency's own
# badge shows (previously the two could silently disagree). See EXPIRY_LIVE_CHECK_DESIGN.md
# in GTFS-X/gtfs-feed-health for the full methodology.

# GTFS-Flex per-state/national counts — RETIRED as of the 2026-07-31 rewiring, degraded
# to 0 (see write_fhdata_js / compute_state_stats). The old flex_coverage.csv (loaded by
# this script pre-rewiring) counted DISTINCT GTFS-Flex FEEDS per state (feed-centric,
# multi-state feeds counted in every state they cover: CO=41, VA=16, national=77
# distinct feeds) via a separate Mobility Database catalog query the old in-repo
# pipeline made. The new export instead carries `is_flex` — a per-AGENCY boolean, no
# equivalent feed-centric catalog data. Empirically aggregating `is_flex==true` NTD-
# agency rows by state from the 2026-07-31 export gives CO=12, VA=0, national=14 total
# — nowhere close to a proxy for the old feed-centric counts (VA in particular drops
# from 16 to 0), so per this rewiring's instructions we do NOT fabricate a flex number:
# per-state `flex` is set to 0 for every state, the FLEX leaderboard and `flexStates`
# count both come out empty/0 (both derived from the per-state field), and the
# HEADLINE.flexFeeds count is also zeroed for internal consistency (rather than show a
# "14 US feeds" headline stat next to a leaderboard with nothing in it). The per-agency
# `isFlex` badge (sourced directly from the export's `is_flex` field) is UNAFFECTED and
# still accurate — only the aggregate/leaderboard reporting is degraded. Follow-up
# needed: GTFS-X/gtfs-feed-health should publish a proper per-state GTFS-Flex feed
# breakdown in a future export if this section is to be restored.


# ── Fetch ───────────────────────────────────────────────────────────────────────

def resolve_sha(ref):
    """Resolve a git ref (branch name or SHA) on SOURCE_REPO to a full commit SHA via
    the GitHub API. Always re-resolved fresh — never trust a cached SHA — so that the
    default ref ("main") tracks upstream's latest each run; the fetch itself still
    goes through the resulting content-addressed SHA (see fetch_export())."""
    gh = shutil.which("gh")
    if gh:
        try:
            proc = subprocess.run(
                [gh, "api", f"repos/{SOURCE_REPO}/commits/{ref}", "--jq", ".sha"],
                capture_output=True, text=True, timeout=30, check=True,
            )
            sha = proc.stdout.strip()
            if sha:
                return sha
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as e:
            print(f"  [warn] `gh api` ref resolution failed ({e}); "
                  f"falling back to unauthenticated GitHub REST API", file=sys.stderr)

    url = f"https://api.github.com/repos/{SOURCE_REPO}/commits/{ref}"
    req = urllib.request.Request(
        url, headers={"Accept": "application/vnd.github+json",
                      "User-Agent": "gtfsx-feed-health-publish"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.load(resp)
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError) as e:
        sys.exit(f"FETCH FAILED: could not resolve ref '{ref}' on {SOURCE_REPO} "
                  f"via the GitHub API: {e}")
    sha = data.get("sha")
    if not sha:
        sys.exit(f"FETCH FAILED: GitHub API response for ref '{ref}' on {SOURCE_REPO} "
                  f"had no 'sha' field: {data!r}")
    return sha


def fetch_export(sha):
    """Fetch exports/feed_health.json from the content-addressed raw URL at `sha` —
    immutable, never a mutable branch-name URL (see module docstring)."""
    url = f"https://raw.githubusercontent.com/{SOURCE_REPO}/{sha}/exports/feed_health.json"
    req = urllib.request.Request(url, headers={"User-Agent": "gtfsx-feed-health-publish"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            if resp.status != 200:
                sys.exit(f"FETCH FAILED: {url} returned HTTP {resp.status}")
            raw = resp.read()
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
        sys.exit(f"FETCH FAILED: could not fetch export from {url}: {e}")
    try:
        export = json.loads(raw)
    except json.JSONDecodeError as e:
        sys.exit(f"FETCH FAILED: export at {url} is not valid JSON: {e}")
    return export


def check_schema_version(export):
    """Abort loudly on a major-version mismatch rather than guessing field mappings
    on an unknown-shape payload (see docs/SCHEMA.md 'What counts as a breaking
    change' in GTFS-X/gtfs-feed-health)."""
    ver = str(export.get("schemaVersion", ""))
    m = re.match(r"^(\d+)\.", ver)
    if not m:
        sys.exit(f"SCHEMA CHECK FAILED: export has missing/malformed schemaVersion: {ver!r}")
    major = int(m.group(1))
    if major != SUPPORTED_SCHEMA_MAJOR:
        sys.exit(
            f"SCHEMA MISMATCH: fetched export schemaVersion={ver!r} (major {major}), "
            f"this script is written against major {SUPPORTED_SCHEMA_MAJOR}. Update the "
            f"field mapping in scripts/feed-health-publish.py against the new "
            f"docs/SCHEMA.md in GTFS-X/gtfs-feed-health, then bump SUPPORTED_SCHEMA_MAJOR."
        )
    return ver


def check_row_count(export):
    """Implausible row-count guard. NTD's annual roster changes rarely, so an exact
    match against CANONICAL['N_roster'] (in the same spirit as the old CSV pipeline's
    equivalent check) is intentional here rather than a tolerance band — a roster-year
    bump is a deliberate, infrequent, human-noticed event, not routine month-to-month
    noise like the percentage metrics above."""
    n = export.get("rowCount")
    rows = export.get("rows") or []
    if n is None or n != len(rows):
        sys.exit(f"FETCH FAILED: export rowCount ({n!r}) does not match len(rows) "
                  f"({len(rows)}) — malformed export")
    if n != CANONICAL["N_roster"]:
        sys.exit(
            f"ROW COUNT DRIFT: fetched export has {n} rows, CANONICAL['N_roster'] "
            f"expects {CANONICAL['N_roster']}. If this is a legitimate NTD roster-year "
            f"update, verify against NTD's published agency count and bump "
            f"CANONICAL['N_roster'] (with a dated comment, per the convention above)."
        )
    return n


def validate_national(export):
    """Check the FETCHED EXPORT'S OWN precomputed `nationalAggregates` envelope
    against CANONICAL, +/-0.5pp tolerance. This is a guard on the export we just
    fetched (did upstream's data drift more than expected?), not a from-scratch
    recomputation — see the CANONICAL comment block for why the old raw-CSV-based
    recomputation is retired. Calls sys.exit on any breach."""
    na = export.get("nationalAggregates")
    if not na:
        sys.exit(
            "FETCH FAILED: export has no 'nationalAggregates' envelope — cannot run "
            "the drift guard. (Per docs/SCHEMA.md, this key is present 'when the drift "
            "guard ran', i.e. absent only if upstream published with --skip-drift-guard; "
            "refusing to publish downstream from an unverified upstream build.)"
        )

    LIMIT = 0.5
    checks = [
        ("no_feed_anywhere_pct",   "noFeedAnywherePct"),
        ("expired_pct_of_matched", "expiredPctOfMatched"),
        ("fail_validation_pct",    "failValidationPct"),
    ]
    errors = []
    for local_key, remote_key in checks:
        remote_val = na.get(remote_key)
        if remote_val is None:
            errors.append(f"{remote_key} missing from nationalAggregates")
            continue
        delta = abs(remote_val - CANONICAL[local_key])
        if delta > LIMIT:
            errors.append(
                f"{remote_key}  fetched={remote_val}%  canonical={CANONICAL[local_key]}%  "
                f"delta={delta:.2f}pp  (limit {LIMIT}pp)"
            )

    if errors:
        print("VALIDATION FAILED:", file=sys.stderr)
        for e in errors:
            print(f"  {e}", file=sys.stderr)
        sys.exit(
            "Aborting: fetched export's nationalAggregates drifted more than 0.5pp from "
            "CANONICAL — see docs/SCHEMA.md 'Re-baselining after a guard trip' in "
            "GTFS-X/gtfs-feed-health before touching this script's CANONICAL baseline."
        )
    print(f"  Validation passed against fetched nationalAggregates: {na}", file=sys.stderr)


# ── Local aggregation (from the export's per-agency rows) ─────────────────────

def is_matched(r):
    """'Matched' = has an MDB/NTD-crosswalk id AND carries a validator error count.
    Same population definition the old CSV pipeline used (in_mdb AND mdb_total_error
    present) — used as the denominator for expired/validator-failure rates."""
    return r["mdb_id"] is not None and r["mdb_total_error"] is not None


def compute_state_stats(rows_by_state):
    """Per-state metrics for the 50 states + DC, in FIPS order."""
    states = []
    for abbr in STATES_FIPS_ORDER:
        fips, name, region = STATES_META[abbr]
        rows = rows_by_state.get(abbr, [])
        total = len(rows)
        if total == 0:
            continue  # state appears in meta but has no NTD agencies — skip

        none_n = sum(1 for r in rows if r["status"] == "none")
        cov = round(100 * (total - none_n) / total)

        matched = [r for r in rows if is_matched(r)]
        M = len(matched)
        expired_n = sum(1 for r in matched if r["status"] == "expired")
        fail_n    = sum(1 for r in matched if (r["mdb_total_error"] or 0) > 0)
        exp = round(100 * expired_n / M) if M else 0
        val = round(100 * fail_n    / M) if M else 0

        states.append({
            "fips": fips, "abbr": abbr, "name": name, "region": region,
            "agencies": total,
            "cov": cov, "noFeed": 100 - cov,
            "exp": exp, "val": val,
            "flex": 0,  # GTFS-Flex per-state accounting retired — see CANONICAL comment block
        })
    return states


def compute_gradient(rows):
    """Per-reporter-type no-feed-anywhere rate. reporter_type is already the target
    lowercase enum ('full'/'reduced'/'rural') straight from the export — no mapping
    needed."""
    rt_order = [
        ("full",    "Full Reporters",         "Urbanized, full NTD reporting"),
        ("reduced", "Reduced Reporters",      "Smaller urbanized + tribal"),
        ("rural",   "Rural (5311) Agencies",  "Non-urbanized rural service"),
    ]
    gradient = []
    for rt_key, label, sub in rt_order:
        rt_rows = [r for r in rows if r["reporter_type"] == rt_key]
        n = len(rt_rows)
        none_n = sum(1 for r in rt_rows if r["status"] == "none")
        no_feed_pct = round(100 * none_n / n) if n else 0
        gradient.append({"key": rt_key, "label": label, "sub": sub,
                          "noFeedPct": no_feed_pct, "agencies": n})
    return gradient


def compute_national(rows):
    """National rollup used to populate fh-data.js HEADLINE (distinct from — and, per
    the CANONICAL comment block, now numerically different from — the drift-guard
    check above, which reads the export's own precomputed envelope instead)."""
    N = len(rows)
    none_n = sum(1 for r in rows if r["status"] == "none")
    matched = [r for r in rows if is_matched(r)]
    M = len(matched)
    expired_n = sum(1 for r in matched if r["status"] == "expired")
    fail_n    = sum(1 for r in matched if (r["mdb_total_error"] or 0) > 0)
    return {
        "N": N, "none_n": none_n,
        "no_feed_pct": round(100 * none_n / N, 1) if N else 0,
        "M": M, "expired_n": expired_n,
        "exp_pct": round(100 * expired_n / M, 1) if M else 0,
        "fail_n": fail_n,
        "val_pct": round(100 * fail_n / M, 1) if M else 0,
    }


# ── Agency JSON output ────────────────────────────────────────────────────────

def write_agency_jsons(rows_by_state, as_of_iso):
    """Write public/feed-health/data/agencies/<ABBR>.json for all 50 states + DC.
    Field-for-field mapping from the export row, per docs/SCHEMA.md in
    GTFS-X/gtfs-feed-health (all fields already fully computed upstream — no
    reimplementation of status/feed-URL/expiry logic here)."""
    os.makedirs(OUT_AGENCIES, exist_ok=True)
    written = []
    for abbr in STATES_FIPS_ORDER:
        rows = rows_by_state.get(abbr, [])
        agencies = []
        for r in sorted(rows, key=lambda x: x["agency_name"]):
            agencies.append({
                "name":         r["agency_name"],
                "ntdId":        r["ntd_id"],       # string — leading zeros matter, never coerce
                "mdbId":        r["mdb_id"],        # already nullable string
                "city":         r["city"],
                "reporterType": r["reporter_type"], # already the target enum, no mapping needed
                "status":       r["status"],        # already the final computed status
                "feedUrl":      r["feed_url"],      # already the best-known URL
                "lastValidated": None,   # not in the export schema either — unchanged
                "orgType":      r["organization_type"],
                # modes: the export has no free-text mode-description field (only the
                # fixed_route/demand_response booleans below). Confirmed public/feed-health/fh.js
                # never reads ag.modes (grepped — zero hits); kept as a null key for output
                # shape-stability only.
                "modes":        None,
                "fixedRoute":     r["fixed_route"],
                "demandResponse": r["demand_response"],
                "isFlex":       r["is_flex"],
                "serviceEnd":   r["service_end"],
                "lastFeedUpdate": r["last_feed_update"],
                # expired ← derived from the SAME status above (not a separate field), so the
                # "Service ended"/"Service ends" phrasing in fh.js can never disagree with the
                # status badge.
                "expired":      r["status"] == "expired",
                # Passthrough, including genuine `null` now (the export can report this as
                # unknown when the live check couldn't run at all — see own_fetch_error in
                # SCHEMA.md); JS treats null as falsy same as false, no behavior change.
                "feedInfoContradictsCalendar": r["feed_info_contradicts_calendar"],
            })
        payload = {"asOf": as_of_iso, "agencies": agencies}
        out_path = os.path.join(OUT_AGENCIES, f"{abbr}.json")
        with open(out_path, "w") as f:
            json.dump(payload, f, separators=(",", ":"))
        written.append((abbr, len(agencies)))
    return written


# ── fh-data.js generation ─────────────────────────────────────────────────────

def fmt_state_row(s):
    return (
        f'    S("{s["fips"]}","{s["abbr"]}","{s["name"]}","{s["region"]}",'
        f'{s["agencies"]},{s["cov"]},{s["exp"]},{s["val"]},{s["flex"]})'
    )


def write_fhdata_js(state_stats, gradient, nat, as_of_iso, dr_agencies, provenance):
    """Regenerate public/feed-health/fh-data.js wholesale. Same window.FH_DATA =
    {HEADLINE, GRADIENT, STATES, FLEX, CTAS} shape as before this rewiring — only
    the header comment gains provenance (resolved SHA / schemaVersion / export
    generatedAt), which is not a structural/object-shape change."""
    draft_date_str = date.fromisoformat(as_of_iso).strftime(f"%B {date.fromisoformat(as_of_iso).day}, %Y")

    no_feed_pct = round(100 * nat["none_n"]    / nat["N"]) if nat["N"] else 0
    expired_pct = round(100 * nat["expired_n"] / nat["M"]) if nat["M"] else 0
    val_pct     = nat["val_pct"]  # keep 1dp

    gradient_js = ",\n".join(
        f'    {{ key: "{g["key"]}",  label: "{g["label"]}", '
        f'sub: "{g["sub"]}",  noFeedPct: {g["noFeedPct"]}, agencies: {g["agencies"]} }}'
        for g in gradient
    )
    states_js = ",\n".join(fmt_state_row(s) for s in state_stats)

    src_line = (
        f'// Source ref: {provenance["ref"]} -> {provenance["sha"]}   '
        f'Export schemaVersion: {provenance["schema_version"]}   '
        f'Export generatedAt: {provenance["generated_at"]}'
        if provenance.get("sha") else
        f'// Source: local export file ({provenance.get("local_path")})   '
        f'Export schemaVersion: {provenance["schema_version"]}   '
        f'Export generatedAt: {provenance["generated_at"]}'
    )

    js = f"""// GENERATED by scripts/feed-health-publish.py — do not hand-edit.
// Source: GTFS-X/gtfs-feed-health canonical export (exports/feed_health.json).
{src_line}
// Run date: {as_of_iso}.  Re-run scripts/feed-health-publish.py to refresh (fetches
// upstream's current main fresh each run by default; --ref <sha> pins, --export-json
// <path> uses a local file offline).
(function () {{
  // ---- Headline findings — recomputed from the fetched export's per-agency rows ----
  const HEADLINE = {{
    noFeedPct: {no_feed_pct},         // % of US federally funded agencies w/ no findable GTFS feed
    agencies: {nat["N"]},          // NTD agency roster (full universe incl. territories)
    expiredPct: {expired_pct},           // % of MDB-matched feeds describing service that already ended
    validatorFailPct: {val_pct}, // % of MDB-matched feeds failing the canonical validator
    // GTFS-Flex aggregate reporting retired 2026-07-31 — see CANONICAL comment block in
    // scripts/feed-health-publish.py for why (feed-centric vs. agency-centric data, not
    // a reasonable proxy). flexAvailable is the explicit gate fh.js reads to HIDE the
    // aggregate Flex band/leaderboard/stat-card/closing-plank entirely (rather than
    // show a "0" a visitor could see visibly contradicted by real per-agency Flex
    // badges on the same page) — flip back to true once a real per-state breakdown
    // exists upstream. flexFeeds/flexStates are kept at 0 only for any code that reads
    // them before checking the flag; fh.js is expected to check flexAvailable first.
    flexAvailable: false,
    flexFeeds: 0,
    flexStates: 0,
    // Agencies reporting Demand Response (mode DR; DT absorbed since report_year 2019),
    // computed live from the fetched export's per-agency demand_response booleans
    // (previously a hardcoded constant from a separate NTD Service-by-Mode extract).
    drAgencies: {dr_agencies},
    refresh: "Monthly",
    asOf: "{as_of_iso}",
    draftDate: "{draft_date_str}",
    owner: "Mark Egge",
  }};

  // Size-gradient cut — % of agencies in each NTD reporting class w/ no feed anywhere
  const GRADIENT = [
{gradient_js},
  ];

  // ---- Per-state rows (REAL values computed from the fetched export) ----
  // cov  = % of the state's NTD agencies with a findable GTFS feed (FTA weblink OR Mobility Database)
  // exp  = % of MDB-matched feeds in that state whose service period has already ended
  // val  = % of MDB-matched feeds in that state with at least one ERROR-severity validator notice
  // flex = RETIRED, always 0 — see HEADLINE.flexFeeds comment above
  const S = (fips, abbr, name, region, agencies, cov, exp, val, flex) =>
    ({{ fips, abbr, name, region, agencies, cov, noFeed: 100 - cov, exp, val, flex }});

  const STATES = [
{states_js},
  ];

  // Flex leaderboard — states publishing GTFS-Flex, ranked. Naturally empty while
  // every state's flex=0 (see above); the render code already degrades cleanly when
  // this is [].
  const FLEX = STATES.filter((s) => s.flex > 0).sort((a, b) => b.flex - a.flex);

  // CTA variants keyed to feed condition — RESERVED for per-agency drill-down phase.
  // Not rendered on the public dashboard; kept here for future use.
  const CTAS = [
    {{ key: "edit",  verb: "Edit this feed",  label: "Edit this feed in GTFS·X",
      cond: "Clean feed", desc: "Feed validates and describes current service. Open it to refine stops, trips, and timetables.",
      tone: "teal" }},
    {{ key: "fix",   verb: "Fix this feed",   label: "Fix this feed in GTFS·X",
      cond: "Broken or expired", desc: "Feed fails the canonical validator or describes service that has already ended. Open it to repair and re-export.",
      tone: "gold" }},
    {{ key: "build", verb: "Build a feed",    label: "Build a feed for this agency in GTFS·X",
      cond: "No feed found", desc: "No GTFS feed any trip planner can find. Draw routes, place stops, and publish a validated gtfs.zip.",
      tone: "coral" }},
  ];

  window.FH_DATA = {{ HEADLINE, GRADIENT, STATES, FLEX, CTAS }};
}})();
"""
    with open(OUT_FHDATA, "w") as f:
        f.write(js)


def write_provenance_json(provenance):
    """Additive sidecar file (new, not a changed shape of an existing artifact) with
    the full fetch provenance for future tooling / debugging."""
    with open(OUT_PROVENANCE, "w") as f:
        json.dump(provenance, f, indent=2)
        f.write("\n")


# ── Summary diff ─────────────────────────────────────────────────────────────

# Illustrative baseline from the original fh-data.js (pre-real-data), kept only for
# the top-movers diff printout below — unrelated to the 2026-07-31 export rewiring.
ILLUSTRATIVE_STATES = {
    "AL": (27, 38, 24, 16, 0), "AK": (34, 31, 27, 18, 1), "AZ": (41, 57, 19, 11, 0),
    "AR": (30, 33, 26, 17, 0), "CA": (214, 71, 16, 9, 2),  "CO": (58, 74, 14, 8, 41),
    "CT": (27, 69, 18, 10, 0), "DE": (6, 72, 15, 9, 0),    "DC": (4, 88, 9, 5, 0),
    "FL": (96, 61, 20, 12, 5), "GA": (55, 46, 23, 14, 1),  "HI": (9, 64, 17, 10, 0),
    "ID": (24, 35, 25, 16, 0), "IL": (72, 67, 18, 11, 1),  "IN": (43, 49, 22, 13, 0),
    "IA": (35, 44, 23, 14, 0), "KS": (33, 37, 25, 15, 0),  "KY": (34, 41, 24, 15, 0),
    "LA": (31, 40, 24, 15, 0), "ME": (20, 52, 21, 12, 2),  "MD": (24, 73, 15, 9, 0),
    "MA": (36, 78, 13, 7, 1),  "MI": (62, 58, 19, 11, 6),  "MN": (47, 66, 17, 10, 9),
    "MS": (26, 29, 28, 18, 0), "MO": (42, 47, 22, 13, 0),  "MT": (30, 30, 27, 17, 1),
    "NE": (24, 39, 24, 15, 0), "NV": (18, 60, 19, 11, 0),  "NH": (17, 55, 20, 12, 0),
    "NJ": (32, 76, 14, 8, 0),  "NM": (27, 34, 26, 16, 1),  "NY": (78, 80, 12, 7, 2),
    "NC": (58, 53, 21, 13, 1), "ND": (20, 28, 28, 18, 0),  "OH": (64, 56, 20, 12, 0),
    "OK": (31, 36, 25, 16, 0), "OR": (40, 72, 15, 9, 3),   "PA": (58, 68, 17, 10, 1),
    "RI": (7, 79, 13, 7, 0),   "SC": (30, 43, 23, 14, 0),  "SD": (19, 30, 27, 17, 0),
    "TN": (37, 48, 22, 13, 0), "TX": (105, 54, 20, 12, 4), "UT": (22, 70, 16, 9, 1),
    "VT": (14, 58, 19, 11, 2), "VA": (44, 62, 18, 11, 0),  "WA": (52, 75, 14, 8, 3),
    "WV": (28, 32, 27, 17, 0), "WI": (45, 59, 19, 11, 1),  "WY": (16, 27, 29, 18, 0),
}


def print_diff(state_stats):
    """Print top movers: states whose cov changed most vs. the illustrative baseline."""
    print("\n── State-value diff (illustrative vs real) ──────────────────────────────")
    print(f"{'Abbr':<5} {'Old agencies':>12} {'New agencies':>12}  {'Old cov':>8} {'New cov':>8}  {'Delta cov':>10}  {'Old flex':>8} {'New flex':>8}")
    movers = []
    for s in state_stats:
        abbr = s["abbr"]
        old = ILLUSTRATIVE_STATES.get(abbr)
        if not old:
            continue
        old_ag, old_cov, old_exp, old_val, old_flex = old
        delta = s["cov"] - old_cov
        movers.append((abbr, old_ag, s["agencies"], old_cov, s["cov"], delta, old_flex, s["flex"]))
    movers.sort(key=lambda x: abs(x[5]), reverse=True)
    for row in movers[:15]:
        abbr, old_ag, new_ag, old_cov, new_cov, delta, old_flex, new_flex = row
        marker = " <<" if abs(delta) > 10 else ""
        print(f"{abbr:<5} {old_ag:>12} {new_ag:>12}  {old_cov:>7}% {new_cov:>7}%  {delta:>+9}pp{marker}  {old_flex:>8} {new_flex:>8}")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="GTFS Feed Health publish script")
    parser.add_argument("--ref", default="main",
                        help="Git ref (branch or SHA) to resolve+fetch from "
                             f"{SOURCE_REPO}. Re-resolved to a commit SHA fresh on "
                             "every run. Default: main.")
    parser.add_argument("--export-json", dest="export_json", default=None,
                        help="Path to a local feed_health.json — skips the network "
                             "fetch entirely (offline/dev use).")
    parser.add_argument("--data-date", dest="data_date", default=None,
                        help="ISO date (YYYY-MM-DD) to stamp into HEADLINE.asOf / "
                             "draftDate. Defaults to the export's generatedAt date.")
    args = parser.parse_args()

    if args.export_json:
        if not os.path.exists(args.export_json):
            sys.exit(f"--export-json path not found: {args.export_json}")
        print(f"Reading local export: {args.export_json}", file=sys.stderr)
        with open(args.export_json) as f:
            export = json.load(f)
        provenance = {"ref": None, "sha": None, "local_path": os.path.abspath(args.export_json)}
    else:
        print(f"Resolving ref '{args.ref}' on {SOURCE_REPO}...", file=sys.stderr)
        sha = resolve_sha(args.ref)
        print(f"  Resolved to {sha}", file=sys.stderr)
        print(f"Fetching exports/feed_health.json at {sha}...", file=sys.stderr)
        export = fetch_export(sha)
        provenance = {"ref": args.ref, "sha": sha}

    schema_version = check_schema_version(export)
    check_row_count(export)
    print("Validating fetched export's national aggregates...", file=sys.stderr)
    validate_national(export)

    provenance["schema_version"] = schema_version
    provenance["generated_at"] = export.get("generatedAt")
    provenance["source_repo"] = SOURCE_REPO
    provenance["published_at"] = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

    all_rows = export["rows"]
    print(f"  {len(all_rows)} rows loaded", file=sys.stderr)

    if args.data_date:
        as_of_iso = args.data_date
    else:
        generated_at = export.get("generatedAt") or ""
        as_of_iso = generated_at[:10] if generated_at else datetime.now(timezone.utc).date().isoformat()
        print(f"  Auto-detected data date (export generatedAt): {as_of_iso}", file=sys.stderr)

    rows_by_state = {}
    for r in all_rows:
        st = r["state"]
        if st in STATES_META:
            rows_by_state.setdefault(st, []).append(r)

    print("Computing per-state stats...", file=sys.stderr)
    state_stats = compute_state_stats(rows_by_state)
    gradient    = compute_gradient(all_rows)
    nat         = compute_national(all_rows)
    dr_agencies = sum(1 for r in all_rows if r["demand_response"])

    print("Writing agency JSON files...", file=sys.stderr)
    written = write_agency_jsons(rows_by_state, as_of_iso)
    total_agencies = sum(n for _, n in written)
    print(f"  Wrote {len(written)} state files, {total_agencies} agencies total", file=sys.stderr)

    territory_n = sum(1 for r in all_rows if r["state"] in TERRITORIES)
    expected_50dc = len(all_rows) - territory_n
    if total_agencies != expected_50dc:
        print(f"  [warn] agency count mismatch: wrote {total_agencies}, expected {expected_50dc}",
              file=sys.stderr)

    print("Regenerating fh-data.js...", file=sys.stderr)
    write_fhdata_js(state_stats, gradient, nat, as_of_iso, dr_agencies, provenance)
    print(f"  Written: {OUT_FHDATA}", file=sys.stderr)

    write_provenance_json(provenance)
    print(f"  Written: {OUT_PROVENANCE}", file=sys.stderr)

    # Sanity checks
    total_all = sum(r["agencies"] for r in state_stats)
    assert total_all == expected_50dc, f"State total mismatch: {total_all} vs {expected_50dc}"
    assert all(s["flex"] == 0 for s in state_stats), (
        "GTFS-Flex per-state accounting was intentionally retired 2026-07-31 pending an "
        "upstream per-state breakdown (see CANONICAL comment block) — a nonzero value "
        "here means someone re-wired flex without updating that decision; revisit the "
        "comment before removing this assert."
    )
    print("  Sanity checks passed (agency sum matches, flex intentionally all-zero)", file=sys.stderr)

    print_diff(state_stats)

    print("\n── Summary ──────────────────────────────────────────────────────────────")
    print(f"  As of:        {as_of_iso}")
    print(f"  Source:       {SOURCE_REPO} @ {provenance.get('sha') or provenance.get('local_path')}")
    print(f"  States+DC:    {len(state_stats)} jurisdictions, {total_agencies} agencies")
    print(f"  National:     {nat['none_n']}/{nat['N']} no-feed ({nat['no_feed_pct']}%), "
          f"exp {nat['exp_pct']}%, val_fail {nat['val_pct']}%")
    print(f"  Output:       {len(written)} agency JSON files + fh-data.js + provenance.json")


if __name__ == "__main__":
    main()
