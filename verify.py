#!/usr/bin/env python3
"""
Independently verify a harvest against the locator's clusters endpoint.

Why this exists
---------------
harvest.py sweeps a nearest-N endpoint with a quadtree. That is provably
complete *if* the API returns true nearest-N, but "provably complete given an
assumption" is worth exactly as much as the assumption. This checks the result
against a completely different endpoint that answers a different question.

    GET /api/maps-proxy/v2/locations/clusters
        ?extent=<minLng,minLat,maxLng,maxLat>&layer=MEETINGHOUSE&zoom=20.0

At zoom 20 the clusters collapse to individual points, and each record carries
an explicit `locations` list of typed IDs:

    ["WARD:1031", "WARD__CAMBODIAN:158518", "MEETINGHOUSE:5079551-01-01"]

So it gives a bbox-exact enumeration of building and unit IDs -- everything
except names, meeting times and timezones, which is why it verifies the
harvest rather than replacing it.

It is also remarkably cheap: all of Utah (5 deg x 5 deg) came back in a single
200 ms call.

Interpreting the result
-----------------------
Clusters is a LOWER BOUND, not ground truth. A few clusters stay `dispersed`
even at zoom 20 and do not enumerate their members, so clusters legitimately
reports FEWER units than a good harvest finds. The check that matters is
one-directional:

    anything clusters found that the harvest did not = a candidate gap

The reverse -- harvest finding more -- is expected and fine.

Each candidate gap is then re-probed with identify at its own cluster
coordinates, because two upstream inconsistencies look like gaps but are
not the sweep's fault: identify returns a building with no ward units at
all (the harvester drops those by design), and clusters lists a unit that
identify never returns anywhere (seasonal wards with no meetinghouse). Both
are printed as `upstream`. A miss is a real `GAP` only when identify returns
the item right there and the sweep still didn't collect it.

Only WARD-prefixed types are compared. Clusters also returns STAKE_OFFICE,
SEMINARY, INSTITUTE, TEMPLE, FAMILYSEARCH_CENTER, BISHOPS_STOREHOUSE and
others, none of which are congregations and all of which harvest.py correctly
excludes.

Measured result on Utah (2026-09-20): clusters enumerated 2,036 buildings and
2,443 ward units. The harvest lacked 2 buildings and 1 unit, all three
upstream: both buildings come back from identify with no ward units, and the
unit is a WARD__SEASONAL that identify never returns. Zero real gaps.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.parse

from harvest import ORIGIN, RateLimiter, USER_AGENT, Unauthorized, fetch_nearest
import urllib.error
import urllib.request

CLUSTERS = "https://maps.churchofjesuschrist.org/api/maps-proxy/v2/locations/clusters"

# At this zoom the server stops aggregating and lists individual locations.
RESOLVE_ZOOM = 20.0

# Keep each request's response to a sane size. Utah (5x5) returned ~735 KB in
# one call, so 4 degrees is comfortable for the Americas. Sparse continents
# set a larger "verifyStep" in regions.json so the sweep stays cheap.
STEP_DEG = 4.0


def fetch_clusters(extent: tuple[float, float, float, float],
                   limiter: RateLimiter, timeout: float = 45.0) -> list[dict]:
    params = urllib.parse.urlencode(
        {
            "extent": ",".join(f"{v:.5f}" for v in extent),
            "layer": "MEETINGHOUSE",
            "zoom": f"{RESOLVE_ZOOM}",
        }
    )
    limiter.acquire()
    req = urllib.request.Request(
        f"{CLUSTERS}?{params}",
        headers={"User-Agent": USER_AGENT, "Accept": "application/json", "Origin": ORIGIN},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8") or "[]")
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise Unauthorized("HTTP 401 from the clusters endpoint.") from e
        raise


# A dense cell (the Philippines, central Mexico, São Paulo) can take the
# server longer than the timeout at zoom 20. Split it and try the quarters
# rather than fail the whole run; retry transient errors before splitting.
MIN_SPLIT_DEG = 0.5


def fetch_clusters_robust(extent: tuple[float, float, float, float],
                          limiter: RateLimiter) -> tuple[list[dict], int]:
    """Returns (records, calls). Splits on timeout / 5xx down to MIN_SPLIT_DEG."""
    min_lng, min_lat, max_lng, max_lat = extent
    last: Exception | None = None
    for attempt in range(2):
        try:
            return fetch_clusters(extent, limiter), attempt + 1
        except Unauthorized:
            raise
        except (TimeoutError, OSError, urllib.error.URLError, json.JSONDecodeError) as e:
            last = e
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504):
                last = e
            else:
                raise
    if max(max_lng - min_lng, max_lat - min_lat) <= MIN_SPLIT_DEG:
        raise RuntimeError(f"clusters failed for {extent}: {last}")
    print(f"  ~ {extent} too slow ({last}); splitting", flush=True)
    mid_lng = (min_lng + max_lng) / 2
    mid_lat = (min_lat + max_lat) / 2
    recs: list[dict] = []
    calls = 2
    for q in (
        (min_lng, min_lat, mid_lng, mid_lat), (mid_lng, min_lat, max_lng, mid_lat),
        (min_lng, mid_lat, mid_lng, max_lat), (mid_lng, mid_lat, max_lng, max_lat),
    ):
        r, c = fetch_clusters_robust(q, limiter)
        recs.extend(r)
        calls += c
    return recs, calls


def collect(regions: list[dict], names: list[str], limiter: RateLimiter):
    buildings: set[str] = set()
    units: dict[str, str] = {}
    where: dict[str, tuple[float, float]] = {}   # location id -> cluster coords
    unresolved = 0
    calls = 0

    for r in regions:
        if r["name"] not in names:
            continue
        min_lng, min_lat, max_lng, max_lat = r["bbox"]
        step = float(r.get("verifyStep", STEP_DEG))
        lng = min_lng
        while lng < max_lng:
            lat = min_lat
            while lat < max_lat:
                ext = (lng, lat, min(lng + step, max_lng), min(lat + step, max_lat))
                recs, n = fetch_clusters_robust(ext, limiter)
                calls += n
                for c in recs:
                    if c.get("dispersed"):
                        unresolved += 1
                    cc = c.get("coordinates") or []
                    for loc in c.get("locations") or []:
                        kind, _, ident = loc.partition(":")
                        if kind == "MEETINGHOUSE":
                            buildings.add(ident)
                        elif kind.startswith("WARD"):
                            units[ident] = kind
                        else:
                            continue
                        if len(cc) == 2:
                            where[ident] = (float(cc[0]), float(cc[1]))
                print(f"  {ext} -> {len(recs)} recs (buildings {len(buildings)}, units {len(units)})",
                      flush=True)
                lat += step
            lng += step

    return buildings, units, where, unresolved, calls


MAX_PROBES = 50


def explain(missing_b: list[str], missing_u: list[str], where: dict, cu: dict,
            limiter: RateLimiter) -> tuple[list[str], list[str], int]:
    """Re-probe each missing item with identify at its own cluster coordinates.

    Only one outcome is the sweep's fault: identify returns the item right
    there and the sweep still didn't collect it. Everything else is an
    upstream inconsistency the sweep cannot fix -- a building identify lists
    with no ward units (the harvester drops those by design), or a unit that
    clusters knows about but identify never returns (seasonal wards with no
    meetinghouse do this).

    Returns (real_missing_b, real_missing_u, probes).
    """
    real_b: list[str] = []
    real_u: list[str] = []
    probes = 0

    for ident in missing_b:
        if ident not in where or probes >= MAX_PROBES:
            real_b.append(ident)
            continue
        probes += 1
        res = fetch_nearest(*where[ident], limiter)
        hit = next((r for r in res if r.get("id") == ident), None)
        if hit is None:
            print(f"   GAP      building {ident}: identify does not return it at its own coordinates")
            real_b.append(ident)
            continue
        wards = [a for a in hit.get("associated") or [] if (a.get("type") or "").startswith("WARD")]
        if wards:
            print(f"   GAP      building {ident}: identify returns it with {len(wards)} ward(s); sweep missed it")
            real_b.append(ident)
        else:
            print(f"   upstream building {ident}: identify returns it with no ward units (dropped by design)")

    for ident in missing_u:
        if ident not in where or probes >= MAX_PROBES:
            real_u.append(ident)
            continue
        probes += 1
        res = fetch_nearest(*where[ident], limiter)
        host = next(
            (r for r in res
             if any(str(a.get("id")) == ident for a in r.get("associated") or [])),
            None,
        )
        if host is None:
            print(f"   upstream unit     {ident} ({cu[ident]}): identify never returns it at its own coordinates")
        else:
            print(f"   GAP      unit     {ident} ({cu[ident]}): identify lists it under building {host.get('id')}; sweep missed it")
            real_u.append(ident)

    return real_b, real_u, probes


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", default="raw/buildings.jsonl")
    ap.add_argument("--regions", default="regions.json")
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--rate", type=float, default=2.0)
    ap.add_argument("--max-missing", type=int, default=0,
                    help="fail if more than this many ward units are missing")
    args = ap.parse_args()

    if not os.path.exists(args.src):
        print(f"missing {args.src} -- run harvest.py first", file=sys.stderr)
        return 1

    harvested_b: set[str] = set()
    harvested_u: set[str] = set()
    coords: dict[str, tuple[float, float]] = {}
    with open(args.src) as f:
        for line in f:
            if not line.strip():
                continue
            b = json.loads(line)
            harvested_b.add(b["id"])
            coords[b["id"]] = (b["lng"], b["lat"])
            for u in b["units"]:
                harvested_u.add(str(u["id"]))

    with open(args.regions) as f:
        regions = json.load(f)
    names = args.only or [r["name"] for r in regions if r.get("default", True)]

    limiter = RateLimiter(args.rate)
    print(f"Verifying against clusters endpoint: {', '.join(names)}")
    try:
        cb, cu, where, unresolved, calls = collect(regions, names, limiter)
    except Unauthorized as e:
        print(f"ABORTED: {e}", file=sys.stderr)
        return 2

    # Only one direction is a real failure. Clusters under-reports because some
    # clusters stay aggregated; the harvest finding extra is expected.
    missing_b = sorted(cb - harvested_b)
    missing_u = sorted(set(cu) - harvested_u)

    # Of the misses, separate the sweep's fault from upstream inconsistencies.
    print()
    if missing_b or missing_u:
        print("Re-probing each miss with identify at its own coordinates:")
    try:
        real_b, real_u, probes = explain(missing_b, missing_u, where, cu, limiter)
    except Unauthorized as e:
        print(f"ABORTED: {e}", file=sys.stderr)
        return 2

    print()
    print(f"clusters calls            {calls:>8,}")
    print(f"unresolved clusters       {unresolved:>8,}   (members not enumerated; lowers the bound)")
    print(f"buildings via clusters    {len(cb):>8,}")
    print(f"buildings via harvest     {len(harvested_b):>8,}   (includes out-of-bbox spillover)")
    print(f"ward units via clusters   {len(cu):>8,}")
    print(f"ward units via harvest    {len(harvested_u):>8,}")
    print()
    print(f"buildings clusters found but harvest lacks : {len(missing_b)}   (real gaps: {len(real_b)})")
    print(f"ward units clusters found but harvest lacks: {len(missing_u)}   (real gaps: {len(real_u)})")
    print(f"identify probes           {probes:>8,}")

    if len(real_u) > args.max_missing or real_b:
        print("\nFAIL: harvest has gaps.", file=sys.stderr)
        return 1
    print("\nOK: harvest covers everything identify can reach that the clusters endpoint enumerates.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
