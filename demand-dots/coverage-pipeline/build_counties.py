"""
Build the self-hosted county-boundary layer GTFS·X uses for point → county
FIPS lookups (`src/services/countyLookup.ts`). Replaces the FCC Area API
(geo.fcc.gov/api/census/area), which the app used to call once per stop.

Output: ONE FlatGeobuf with a spatial (packed Hilbert R-tree) index, polygon /
multipolygon per county or county-equivalent, EPSG:4326, attributes:

    geoid     5-char state+county FIPS        e.g. "30031"
    statefp   2-char state FIPS               e.g. "30"
    countyfp  3-char county FIPS              e.g. "031"
    name      county name                     e.g. "Gallatin"

Served from R2 `gtfs-builder-tiles/coverage/<key>.fgb` by the worker's
`/_coverage/:region.fgb` route (worker/legacy/coverage.ts, HTTP Range), and
read client-side with `flatgeobuf`'s `geojson.deserialize(url, rect)` exactly
like the block layer.

SOURCE CHOICE — TIGER/Line, not the cartographic-boundary (cb_*) file
─────────────────────────────────────────────────────────────────────
The cb_* files are clipped to the shoreline. TIGER/Line counties are not: they
run out to the legal boundary (territorial waters, the middle of lakes and
bays), which is what the FCC API answered against (2020 census blocks, water
blocks included). A ferry terminal or pier stop sits in the water as far as a
shoreline-clipped polygon is concerned and would resolve to nothing. TIGER is
larger, so it is simplified here (see --tolerance); the client also falls back
to the nearest county within a few hundred metres for the slivers that
per-polygon simplification opens between neighbours.

VINTAGE — must match the ACS vintage the app queries
───────────────────────────────────────────────────
The county FIPS this layer returns is fed straight into an ACS 5-year
block-group query (`fetchCensusData`, ACS_YEAR in src/generated/acsVintage.ts).
Use the TIGER year that matches ACS_YEAR. This matters for Connecticut: from
ACS 2022 on, CT's county-equivalents are the 9 planning regions (county codes
110-190). The FCC API answered with the OLD 8 counties (001-015), which current
ACS no longer has. A 2022+ TIGER vintage returns planning regions, which is
what the ACS query needs.

Usage (from demand-dots/coverage-pipeline, Python 3.12, deps pinned in
requirements.txt):

    python build_counties.py --year 2024 --out ../../tiles/coverage/counties-2024.fgb

Then upload (~25 MB at the default tolerance, well under wrangler's 300 MiB
limit; clients never download it whole, only the header, index nodes and the
one to four counties around the point, ~25-330 KB per lookup):

    unset CLOUDFLARE_API_TOKEN
    npx wrangler r2 object put gtfs-builder-tiles/coverage/counties-2024.fgb \\
      --file ../../tiles/coverage/counties-2024.fgb \\
      --content-type application/octet-stream --remote

The R2 key carries the vintage because the route serves `immutable` cache
headers: a rebuild ships under a NEW key and `COUNTY_LAYER` in
src/services/countyLookup.ts is bumped to match. Never overwrite in place.
"""
from __future__ import annotations

import argparse
import os
import sys
import tempfile
from pathlib import Path

import geopandas as gpd
import requests

TIGER_URL = "https://www2.census.gov/geo/tiger/TIGER{year}/COUNTY/tl_{year}_us_county.zip"

# ~0.0001° ≈ 11 m north-south. TIGER county lines are surveyed to well under
# that, so this only removes redundant vertices along long, wiggly boundaries
# (rivers, coastlines); interior points are unaffected.
DEFAULT_TOLERANCE = 0.0001


def download(url: str, cache_dir: Path) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    dest = cache_dir / url.rsplit("/", 1)[-1]
    if dest.exists() and dest.stat().st_size > 0:
        print(f"cached  {dest}")
        return dest
    print(f"fetch   {url}")
    with requests.get(url, stream=True, timeout=300) as r:
        r.raise_for_status()
        tmp = dest.with_suffix(".part")
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
        tmp.rename(dest)
    return dest


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--year", type=int, default=2024, help="TIGER/Line vintage (match ACS_YEAR)")
    ap.add_argument("--out", required=True, help="output .fgb path")
    ap.add_argument("--tolerance", type=float, default=DEFAULT_TOLERANCE,
                    help="simplify tolerance in degrees (topology-preserving, per polygon)")
    ap.add_argument("--cache-dir", default=os.path.join(tempfile.gettempdir(), "gtfsx-counties-cache"))
    args = ap.parse_args()

    zip_path = download(TIGER_URL.format(year=args.year), Path(args.cache_dir))
    gdf = gpd.read_file(f"zip://{zip_path}", engine="pyogrio",
                        columns=["GEOID", "STATEFP", "COUNTYFP", "NAME"])
    print(f"read    {len(gdf)} counties, crs={gdf.crs}")

    gdf = gdf.to_crs(4326)
    gdf = gdf.rename(columns={"GEOID": "geoid", "STATEFP": "statefp",
                              "COUNTYFP": "countyfp", "NAME": "name"})

    # Sanity: a malformed GEOID would silently produce an unqueryable ACS call.
    bad = gdf[(gdf.geoid.str.len() != 5) | (gdf.geoid != gdf.statefp + gdf.countyfp)]
    if len(bad):
        print(f"ERROR   {len(bad)} rows with inconsistent GEOID", file=sys.stderr)
        return 1

    before = int(gdf.geometry.count_coordinates().sum())
    if args.tolerance > 0:
        gdf["geometry"] = gdf.geometry.simplify(args.tolerance, preserve_topology=True)
    after = int(gdf.geometry.count_coordinates().sum())
    invalid = int((~gdf.geometry.is_valid).sum())
    if invalid:
        gdf["geometry"] = gdf.geometry.make_valid()
    print(f"simplify tol={args.tolerance}: {before:,} → {after:,} vertices ({invalid} repaired)")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()
    gdf = gdf[["geoid", "statefp", "countyfp", "name", "geometry"]]
    gdf.to_file(out, driver="FlatGeobuf", engine="pyogrio",
                layer_options={"SPATIAL_INDEX": "YES"}, promote_to_multi=True)
    print(f"wrote   {out}  {out.stat().st_size / 1e6:.1f} MB  ({len(gdf)} features)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
