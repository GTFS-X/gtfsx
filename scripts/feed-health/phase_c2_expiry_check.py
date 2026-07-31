#!/usr/bin/env python3
"""
GTFS Feed Health pipeline — Phase C2: live expiry check.

Replaces the "trust MDB's last capture" approach to expiry with a direct read of
each agency's OWN currently-registered feed. MDB recrawls smaller agencies on a very
irregular cadence (this audit found captures from days old to 4+ years old), so
mdb_expired can be — and was found to be — wrong for as long as MDB takes to
recrawl a feed that has quietly been republished. See EXPIRY_LIVE_CHECK_DESIGN.md
for the full reasoning, the High Point Transit case that motivated this, and why
calendar.txt is authoritative over feed_info.txt (not the other way around).

Method, per the settled methodology (calendar.txt primary):
  1. Download each agency's reachable feed URL (bounded size + timeout).
  2. Compute the true service-end date from calendar.txt (max end_date) and
     calendar_dates.txt (max date with exception_type=1), whichever is later.
  3. Fall back to feed_info.txt's feed_end_date ONLY when the feed has no
     calendar data to compute from.
  4. Record feed_info_contradicts_calendar when both exist and materially
     disagree (>7 days) — a feed-hygiene signal in its own right, independent
     of which value wins.
  5. On any fetch/parse failure (timeout, oversized, unreachable, corrupt),
     leave own_expired blank — feed-health-publish.py's get_status() falls
     back to MDB's (stale but better-than-nothing) value. A timeout must
     never silently become "expired".

Politeness (these are public agency servers, many small and some on shared
hosting platforms serving dozens of agencies — trilliumtransit, ftis.org,
nationalrtap.org, passio3.com, syncromatics, remix.com, etc.):
  - Bounded global concurrency (default 8).
  - Per-host concurrency cap (default 2) + a short pause between requests to
    the same host, so no single host gets hammered even though it's shared by
    many agencies in our list.
  - Size cap (default 60 MB) — skip (fall back to MDB) rather than pull a
    100+ MB feed (CTA/NJ Transit/WMATA-scale) in full.

Candidate selection: every row where either (a) the registered FTA weblink_url
already passed Phase C's reachability check as a confirmed zip, or (b) the
agency has no working weblink but IS matched in the Mobility Database (use
MDB's own producer_url / hosted_url instead). This intentionally covers more
than just the already-known-stale "expired"/"invalid" agencies — findable but
un-flagged "ok" agencies get a real expiry signal for the first time too. Rows
with neither a working weblink nor an MDB match ("none" status) have no URL to
check and are skipped (own_* columns stay blank).

Resumable: results are cached per (ntd_id, check_url) in
expiry_check_cache.json in --workdir, keyed so a killed/interrupted run can
pick back up instead of re-fetching everything.

Usage:
  python3 scripts/feed-health/phase_c2_expiry_check.py [--workdir DIR]
      [--limit N] [--workers 8] [--per-host-limit 2] [--per-host-delay 0.4]
      [--max-size-mb 60]
"""

import argparse, csv, io, json, os, sys, threading, time, zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime
from urllib.parse import urlparse

try:
    import requests
except ImportError:
    sys.exit("requests not installed — run: pip install requests")

UA = {"User-Agent": "VectorVertex-GTFSx-FeedHealth/1.0 (research; expiry live-check; "
                     "contact via www.gtfsx.com)"}
DEFAULT_WORKDIR = "/tmp/feed-health-work"
CONNECT_TIMEOUT = 10
READ_TIMEOUT = 30
CONTRADICTION_THRESHOLD_DAYS = 7

TODAY8 = date.today().strftime("%Y%m%d")

OUT_COLS = ["own_check_url", "own_check_url_source", "own_service_end",
            "own_expired", "feed_info_contradicts_calendar", "own_fetch_error"]


# ---------- candidate selection ----------

def load_mdb_cache(workdir):
    path = os.path.join(workdir, "mdb_us_feeds.json")
    if not os.path.exists(path):
        print("  [warn] mdb_us_feeds.json not found — MDB-only agencies won't be "
              "checkable", file=sys.stderr)
        return {}
    with open(path) as f:
        feeds = json.load(f)
    return {fd["mdb_id"]: fd for fd in feeds}


def determine_check_url(row, mdb_by_id):
    """Return (url, source) or (None, None) if nothing reachable to test."""
    wl = (row.get("weblink_url") or "").strip()
    if wl and row.get("url_returns_zip") == "True":
        return wl, "weblink"
    if row.get("in_mdb") == "True":
        f = mdb_by_id.get((row.get("mdb_id") or "").strip())
        if f:
            url = (f.get("producer_url") or "").strip() or (f.get("hosted_url") or "").strip()
            if url:
                src = "mdb_producer_url" if f.get("producer_url") else "mdb_hosted_url"
                return url, src
    return None, None


# ---------- zip parsing ----------

def find_entry(names, filename):
    for n in names:
        if n == filename or n.endswith("/" + filename):
            return n
    return None


def parse_calendar_max(z, cal_name):
    max_end = None
    with z.open(cal_name) as fh:
        reader = csv.DictReader(io.TextIOWrapper(fh, encoding="utf-8-sig", errors="replace"))
        for row in reader:
            ed = (row.get("end_date") or "").strip()
            if len(ed) == 8 and ed.isdigit() and (max_end is None or ed > max_end):
                max_end = ed
    return max_end


def parse_calendar_dates_max(z, cd_name):
    max_added = None
    with z.open(cd_name) as fh:
        reader = csv.DictReader(io.TextIOWrapper(fh, encoding="utf-8-sig", errors="replace"))
        for row in reader:
            if (row.get("exception_type") or "").strip() != "1":
                continue
            d = (row.get("date") or "").strip()
            if len(d) == 8 and d.isdigit() and (max_added is None or d > max_added):
                max_added = d
    return max_added


def parse_feed_info_end(z, fi_name):
    with z.open(fi_name) as fh:
        reader = csv.DictReader(io.TextIOWrapper(fh, encoding="utf-8-sig", errors="replace"))
        for row in reader:
            fe = (row.get("feed_end_date") or "").strip()
            if len(fe) == 8 and fe.isdigit():
                return fe
    return None


def fmt_date(yyyymmdd):
    return f"{yyyymmdd[:4]}-{yyyymmdd[4:6]}-{yyyymmdd[6:8]}" if yyyymmdd else None


def days_apart(d1, d2):
    try:
        return abs((datetime.strptime(d1, "%Y%m%d") - datetime.strptime(d2, "%Y%m%d")).days)
    except Exception:
        return None


# ---------- fetch + compute ----------

def check_feed(url, max_size_bytes):
    out = {"own_check_url": url, "own_check_url_source": "", "own_service_end": "",
           "own_expired": "", "feed_info_contradicts_calendar": "", "own_fetch_error": ""}
    try:
        r = requests.get(url, headers=UA, timeout=(CONNECT_TIMEOUT, READ_TIMEOUT), stream=True)
    except requests.exceptions.ConnectTimeout:
        out["own_fetch_error"] = "connect_timeout"; return out
    except requests.exceptions.ReadTimeout:
        out["own_fetch_error"] = "read_timeout"; return out
    except requests.exceptions.SSLError:
        out["own_fetch_error"] = "ssl_error"; return out
    except requests.exceptions.ConnectionError:
        out["own_fetch_error"] = "connection_error"; return out
    except requests.exceptions.TooManyRedirects:
        out["own_fetch_error"] = "too_many_redirects"; return out
    except Exception as e:
        out["own_fetch_error"] = f"error_{type(e).__name__}"; return out

    if not r.ok:
        out["own_fetch_error"] = f"http_{r.status_code}"
        r.close(); return out

    cl = r.headers.get("Content-Length")
    if cl and cl.isdigit() and int(cl) > max_size_bytes:
        out["own_fetch_error"] = "too_large"
        r.close(); return out

    buf = io.BytesIO()
    total = 0
    try:
        for chunk in r.iter_content(65536):
            if not chunk:
                continue
            total += len(chunk)
            if total > max_size_bytes:
                out["own_fetch_error"] = "too_large"
                r.close(); return out
            buf.write(chunk)
    except requests.exceptions.ReadTimeout:
        out["own_fetch_error"] = "read_timeout_mid_download"; return out
    except Exception as e:
        out["own_fetch_error"] = f"download_error_{type(e).__name__}"; return out
    finally:
        r.close()

    buf.seek(0)
    try:
        z = zipfile.ZipFile(buf)
        names = z.namelist()
    except zipfile.BadZipFile:
        out["own_fetch_error"] = "not_a_zip"; return out
    except Exception as e:
        out["own_fetch_error"] = f"zip_error_{type(e).__name__}"; return out

    cal_name = find_entry(names, "calendar.txt")
    cd_name  = find_entry(names, "calendar_dates.txt")
    fi_name  = find_entry(names, "feed_info.txt")

    cal_max = None
    parse_err = None
    try:
        if cal_name:
            cal_max = parse_calendar_max(z, cal_name)
        if cd_name:
            cd_max = parse_calendar_dates_max(z, cd_name)
            if cd_max and (cal_max is None or cd_max > cal_max):
                cal_max = cd_max
    except Exception as e:
        parse_err = f"calendar_parse_error_{type(e).__name__}"

    fi_end = None
    try:
        if fi_name:
            fi_end = parse_feed_info_end(z, fi_name)
    except Exception:
        pass  # feed_info is just a fallback; a parse failure there isn't fatal

    if cal_max:
        service_end, out["own_check_url_source"] = cal_max, "calendar"
    elif fi_end:
        service_end, out["own_check_url_source"] = fi_end, "feed_info"
    else:
        out["own_fetch_error"] = parse_err or "no_calendar_or_feed_info"
        return out

    out["own_service_end"] = fmt_date(service_end)
    out["own_expired"] = "True" if service_end < TODAY8 else "False"

    if cal_max and fi_end and cal_max != fi_end:
        d = days_apart(cal_max, fi_end)
        out["feed_info_contradicts_calendar"] = "True" if (d is not None and d > CONTRADICTION_THRESHOLD_DAYS) else "False"
    else:
        out["feed_info_contradicts_calendar"] = "False"

    return out


# ---------- politeness: per-host gating ----------

_host_semaphores = {}
_host_lock = threading.Lock()


def host_semaphore(host, limit):
    with _host_lock:
        sem = _host_semaphores.get(host)
        if sem is None:
            sem = threading.Semaphore(limit)
            _host_semaphores[host] = sem
        return sem


def worker(ntd_id, url, source, max_size_bytes, per_host_limit, per_host_delay):
    host = urlparse(url).netloc
    sem = host_semaphore(host, per_host_limit)
    sem.acquire()
    try:
        result = check_feed(url, max_size_bytes)
        result["own_check_url_source"] = result["own_check_url_source"] or source
        time.sleep(per_host_delay)  # politeness pause before freeing this host's slot
    finally:
        sem.release()
    return ntd_id, result


# ---------- main ----------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workdir", default=DEFAULT_WORKDIR)
    ap.add_argument("--limit", type=int, default=None, help="only check the first N candidates (testing)")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--per-host-limit", type=int, default=2)
    ap.add_argument("--per-host-delay", type=float, default=0.4)
    ap.add_argument("--max-size-mb", type=float, default=60)
    args = ap.parse_args()

    csv_path = os.path.join(args.workdir, "ntd_feed_health.csv")
    if not os.path.exists(csv_path):
        sys.exit(f"{csv_path} not found — run pipeline.py + phase_d_mdb.py first")

    rows = list(csv.DictReader(open(csv_path)))
    mdb_by_id = load_mdb_cache(args.workdir)

    candidates = []
    for r in rows:
        url, source = determine_check_url(r, mdb_by_id)
        if url:
            candidates.append((r["ntd_id"], url, source))
    print(f"  {len(candidates)} agencies have a reachable URL to check "
          f"({sum(1 for _,_,s in candidates if s=='weblink')} weblink, "
          f"{sum(1 for _,_,s in candidates if s!='weblink')} MDB-only)", file=sys.stderr)

    if args.limit:
        candidates = candidates[:args.limit]

    cache_path = os.path.join(args.workdir, "expiry_check_cache.json")
    cache = {}
    if os.path.exists(cache_path):
        try:
            cache = json.load(open(cache_path))
        except Exception:
            cache = {}

    todo = [(nid, url, src) for nid, url, src in candidates if url not in cache]
    print(f"  {len(candidates) - len(todo)} cached, {len(todo)} to fetch "
          f"(workers={args.workers}, per_host_limit={args.per_host_limit}, "
          f"max_size={args.max_size_mb}MB)", file=sys.stderr)

    max_size_bytes = int(args.max_size_mb * 1024 * 1024)
    t0 = time.time()
    done = 0
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(worker, nid, url, src, max_size_bytes,
                           args.per_host_limit, args.per_host_delay): (nid, url)
                for nid, url, src in todo}
        for fut in as_completed(futs):
            nid, url = futs[fut]
            try:
                _, result = fut.result()
            except Exception as e:
                result = {"own_check_url": url, "own_check_url_source": "",
                          "own_service_end": "", "own_expired": "",
                          "feed_info_contradicts_calendar": "",
                          "own_fetch_error": f"worker_error_{type(e).__name__}"}
            cache[url] = result
            done += 1
            if done % 50 == 0:
                json.dump(cache, open(cache_path, "w"))
                elapsed = time.time() - t0
                print(f"  {done}/{len(todo)} fetched ({elapsed:.0f}s elapsed)", file=sys.stderr)

    json.dump(cache, open(cache_path, "w"))
    print(f"  fetch phase done in {time.time()-t0:.0f}s", file=sys.stderr)

    # Stamp results back onto the CSV rows.
    by_ntd = {}
    for nid, url, src in candidates:
        by_ntd[nid] = cache.get(url, {})

    n_expired_live = n_ok_live = n_error = n_contradicts = 0
    error_counts = {}
    for r in rows:
        res = by_ntd.get(r["ntd_id"])
        if res is None:
            for c in OUT_COLS:
                r[c] = ""
            continue
        for c in OUT_COLS:
            r[c] = res.get(c, "")
        if res.get("own_expired") == "True":
            n_expired_live += 1
        elif res.get("own_expired") == "False":
            n_ok_live += 1
        if res.get("own_fetch_error"):
            n_error += 1
            error_counts[res["own_fetch_error"]] = error_counts.get(res["own_fetch_error"], 0) + 1
        if res.get("feed_info_contradicts_calendar") == "True":
            n_contradicts += 1

    fieldnames = list(rows[0].keys()) if rows else []
    with open(csv_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for r in rows:
            w.writerow(r)

    stats = {
        "generated": date.today().isoformat(),
        "candidates_total": len(candidates),
        "checked_this_run": len(todo),
        "cached_from_prior_run": len(candidates) - len(todo),
        "own_expired_true": n_expired_live,
        "own_expired_false": n_ok_live,
        "feed_info_contradicts_calendar_true": n_contradicts,
        "fetch_errors_total": n_error,
        "fetch_errors_by_type": error_counts,
    }
    with open(os.path.join(args.workdir, "stats_phaseC2.json"), "w") as f:
        json.dump(stats, f, indent=2)
    print(json.dumps(stats, indent=2))


if __name__ == "__main__":
    main()
