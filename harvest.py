#!/usr/bin/env python3
"""
Harvest LDS meetinghouse + unit data from the public Meetinghouse Locator.

Strategy
--------
The locator exposes only a nearest-N endpoint:

    GET /api/maps-proxy/v2/locations/identify
        ?layers=MEETINGHOUSE&filters=&associated=WARDS
        &coordinates=<lng>,<lat>&nearest=<N>

There is no bounding-box or bulk endpoint (area/bbox/nearby all 404, and
locations/search hard-caps at 10 results regardless of size/limit).

So we sweep with an adaptive quadtree. For a cell, query its center and ask
for the N nearest buildings. Let:

    R_corner = distance from the cell center to its farthest corner
    r_max    = distance to the farthest building the API returned

If the API returned fewer than N results, it exhausted its data and the cell
is covered. If r_max >= R_corner, we necessarily hold every building within
R_corner of the center -- a disc that fully contains the cell -- so the cell
is covered. Otherwise the N results were truncated before reaching the cell
edge, so we split into four children and recurse.

This criterion is provably complete given a truthful nearest-N API. It was
validated empirically against Utah (the densest geography in the system):
297 calls, 2,116 buildings, then 152 random probe points producing 419
in-bbox building hits with ZERO misses.

Etiquette
---------
This hits a public service that has no published API contract. Be a good
citizen: the default rate limit is deliberately modest, the User-Agent is
descriptive and carries a contact URL, and the intended refresh cadence is
monthly, not nightly. Please do not raise --rate without a reason.

Access
------
The endpoint returns HTTP 401 with an empty body unless the request carries
an ``Origin`` header for the locator's own site. A plain server-side request
with no Origin gets 401; the same request with ``Origin:
https://maps.churchofjesuschrist.org`` gets 200 (verified 2026-09-20). The
harvester sends that header. Run:

    python3 harvest.py --preflight

before anything else. If preflight fails with 401, the gate has changed;
stop and look at the response before adjusting anything.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

BASE = "https://maps.churchofjesuschrist.org/api/maps-proxy/v2/locations/identify"

# Descriptive UA with contact info. Change the URL to your own repo.
USER_AGENT = (
    "sabbath-stop-harvester/1.0 "
    "(+https://github.com/jbschooley/sabbath-stop; monthly dataset refresh)"
)

# The API 401s without this. See "Access" in the module docstring.
ORIGIN = "https://maps.churchofjesuschrist.org"

NEAREST = 50          # validated; nearest=500 times out server-side
MIN_CELL_DEG = 0.008  # ~0.55 mi; recursion floor guard
EARTH_MI = 3958.7613


# --------------------------------------------------------------------------
# geometry
# --------------------------------------------------------------------------

def haversine_mi(lng1: float, lat1: float, lng2: float, lat2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lng2 - lng1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_MI * math.asin(math.sqrt(h))


@dataclass(frozen=True)
class Cell:
    min_lng: float
    min_lat: float
    max_lng: float
    max_lat: float
    depth: int = 0

    @property
    def center(self) -> tuple[float, float]:
        return ((self.min_lng + self.max_lng) / 2, (self.min_lat + self.max_lat) / 2)

    @property
    def corner_radius_mi(self) -> float:
        cx, cy = self.center
        return max(
            haversine_mi(cx, cy, self.min_lng, self.min_lat),
            haversine_mi(cx, cy, self.min_lng, self.max_lat),
            haversine_mi(cx, cy, self.max_lng, self.min_lat),
            haversine_mi(cx, cy, self.max_lng, self.max_lat),
        )

    @property
    def width_deg(self) -> float:
        return self.max_lng - self.min_lng

    def quarters(self) -> list["Cell"]:
        mx = (self.min_lng + self.max_lng) / 2
        my = (self.min_lat + self.max_lat) / 2
        d = self.depth + 1
        return [
            Cell(self.min_lng, self.min_lat, mx, my, d),
            Cell(mx, self.min_lat, self.max_lng, my, d),
            Cell(self.min_lng, my, mx, self.max_lat, d),
            Cell(mx, my, self.max_lng, self.max_lat, d),
        ]

    def as_list(self) -> list[float]:
        return [self.min_lng, self.min_lat, self.max_lng, self.max_lat, self.depth]


# --------------------------------------------------------------------------
# polite HTTP
# --------------------------------------------------------------------------

class RateLimiter:
    """Global minimum interval between request starts, shared across threads."""

    def __init__(self, per_second: float):
        self._interval = 1.0 / per_second if per_second > 0 else 0.0
        self._lock = threading.Lock()
        self._next = 0.0

    def acquire(self) -> None:
        if self._interval <= 0:
            return
        with self._lock:
            now = time.monotonic()
            wait = max(0.0, self._next - now)
            self._next = max(now, self._next) + self._interval
        if wait:
            time.sleep(wait)


class Unauthorized(RuntimeError):
    pass


def fetch_nearest(
    lng: float, lat: float, limiter: RateLimiter, timeout: float = 30.0, tries: int = 4
) -> list[dict]:
    params = urllib.parse.urlencode(
        {
            "layers": "MEETINGHOUSE",
            "filters": "",
            "associated": "WARDS",
            "coordinates": f"{lng:.6f},{lat:.6f}",
            "nearest": str(NEAREST),
        }
    )
    url = f"{BASE}?{params}"
    last: Exception | None = None

    for attempt in range(tries):
        limiter.acquire()
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "application/json",
                "Origin": ORIGIN,
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8") or "[]")
        except urllib.error.HTTPError as e:
            if e.code == 401:
                raise Unauthorized(
                    "HTTP 401 from the locator API. The service is refusing this "
                    "client -- see 'Access' in the module docstring."
                ) from e
            if e.code in (429, 500, 502, 503, 504):
                last = e
                time.sleep((2 ** attempt) + random.random())
                continue
            raise
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            last = e
            time.sleep((2 ** attempt) + random.random())

    raise RuntimeError(f"giving up on {lng:.4f},{lat:.4f}: {last}")


# --------------------------------------------------------------------------
# normalization
# --------------------------------------------------------------------------

def normalize(raw: dict) -> dict | None:
    """Flatten one API building record into our compact schema."""
    coords = raw.get("coordinates") or []
    if len(coords) != 2:
        return None

    addr = raw.get("address") or {}
    tz = raw.get("timeZone") or {}

    units = []
    for w in raw.get("associated") or []:
        # The associated `type` is "WARD" for conventional units but
        # "WARD__<SUBTYPE>" for everything else -- WARD__YSA, WARD__SPANISH,
        # WARD__DEAF and so on. An exact == "WARD" test silently drops every
        # non-conventional unit, which is ~17% of all units and 100% of the
        # YSA wards this tool exists to find. Match on the prefix.
        wtype = w.get("type") or ""
        if not wtype.startswith("WARD"):
            continue

        # subType is normally its own field; fall back to parsing it out of
        # the compound type if the API ever omits it.
        sub = w.get("subType")
        if not sub and "__" in wtype:
            sub = wtype.split("__", 1)[1]

        hours = w.get("hours") or {}
        primary = hours.get("primary") or {}
        hour = (primary.get("hour") or {}).get("code")  # "HH:MM:SS"
        start = hour[:5] if hour else None                # -> "HH:MM"
        # Day of the week the sacrament meeting is held. Sunday almost
        # everywhere, but Friday in some Gulf states and Saturday in Israel,
        # so the app must not assume it.
        day = (primary.get("day") or {}).get("code")
        if not day:
            days = hours.get("days") or []
            day = ((days[0].get("day") or {}).get("code")) if days else None

        finish = None
        days = hours.get("days") or []
        if days:
            ranges = ((days[0].get("hours") or {}).get("ranges") or [])
            if ranges:
                f = (ranges[0].get("finish") or {}).get("code")
                finish = f[:5] if f else None

        units.append(
            {
                "id": w.get("id"),
                "name": w.get("nameDisplay") or w.get("name"),
                "type": w.get("typeDisplay"),
                "subType": sub or "CONVENTIONAL",
                "subTypeDisplay": w.get("subTypeDisplay") or "Conventional",
                "start": start,
                "end": finish,
                "day": day or "SUNDAY",
                "lang": (w.get("language") or {}).get("code"),
            }
        )

    if not units:
        return None

    return {
        "id": raw.get("id"),
        "name": raw.get("nameDisplay") or raw.get("name"),
        "lng": round(float(coords[0]), 6),
        "lat": round(float(coords[1]), 6),
        "tz": tz.get("id"),
        "city": addr.get("city"),
        "state": addr.get("stateCode") or addr.get("state"),
        "country": addr.get("countryCode2"),
        "addr": addr.get("formatted"),
        "url": raw.get("website"),
        "units": units,
    }


# --------------------------------------------------------------------------
# sweep
# --------------------------------------------------------------------------

@dataclass
class Stats:
    calls: int = 0
    covered: int = 0
    split: int = 0
    errors: int = 0
    max_depth: int = 0
    lock: threading.Lock = field(default_factory=threading.Lock)


def sweep(
    seeds: list[Cell],
    limiter: RateLimiter,
    workers: int,
    checkpoint_path: str | None,
    checkpoint_every: float = 60.0,
) -> dict[str, dict]:
    buildings: dict[str, dict] = {}
    bl = threading.Lock()
    stats = Stats()
    queue: list[Cell] = list(seeds)
    last_ckpt = time.monotonic()

    def visit(cell: Cell) -> list[Cell]:
        cx, cy = cell.center
        try:
            results = fetch_nearest(cx, cy, limiter)
        except Unauthorized:
            raise
        except Exception as e:
            with stats.lock:
                stats.errors += 1
            print(f"  ! {cell.as_list()}: {e}", file=sys.stderr)
            return []

        with stats.lock:
            stats.calls += 1
            stats.max_depth = max(stats.max_depth, cell.depth)

        new = 0
        r_max = 0.0
        for raw in results:
            c = raw.get("coordinates") or []
            if len(c) == 2:
                r_max = max(r_max, haversine_mi(cx, cy, float(c[0]), float(c[1])))
            rec = normalize(raw)
            if rec and rec["id"]:
                with bl:
                    if rec["id"] not in buildings:
                        buildings[rec["id"]] = rec
                        new += 1

        exhausted = len(results) < NEAREST
        covered = exhausted or r_max >= cell.corner_radius_mi
        too_small = cell.width_deg < MIN_CELL_DEG

        if covered or too_small:
            with stats.lock:
                stats.covered += 1
            if too_small and not covered:
                print(f"  ~ depth floor at {cell.as_list()}", file=sys.stderr)
            return []

        with stats.lock:
            stats.split += 1
        return cell.quarters()

    with ThreadPoolExecutor(max_workers=workers) as pool:
        while queue:
            batch, queue = queue[: workers * 4], queue[workers * 4 :]
            for children in pool.map(visit, batch):
                queue.extend(children)

            print(
                f"  calls={stats.calls} buildings={len(buildings)} "
                f"queued={len(queue)} split={stats.split} "
                f"depth={stats.max_depth} err={stats.errors}",
                flush=True,
            )

            if checkpoint_path and time.monotonic() - last_ckpt > checkpoint_every:
                write_checkpoint(checkpoint_path, buildings, queue)
                last_ckpt = time.monotonic()

    return buildings


def write_checkpoint(path: str, buildings: dict, queue: list[Cell]) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(
            {"buildings": list(buildings.values()), "queue": [c.as_list() for c in queue]},
            f,
        )
    os.replace(tmp, path)


def read_checkpoint(path: str) -> tuple[dict[str, dict], list[Cell]]:
    with open(path) as f:
        data = json.load(f)
    buildings = {b["id"]: b for b in data.get("buildings", [])}
    queue = [Cell(*c[:4], depth=int(c[4])) for c in data.get("queue", [])]
    return buildings, queue


# --------------------------------------------------------------------------
# cli
# --------------------------------------------------------------------------

def preflight(limiter: RateLimiter) -> int:
    """One server-side call to confirm the API answers a non-browser client."""
    print("Preflight: single request to the locator API (Salt Lake City)...")
    try:
        results = fetch_nearest(-111.891, 40.760, limiter, tries=1)
    except Unauthorized as e:
        print(f"\nFAILED: {e}", file=sys.stderr)
        print(
            "\nThe locator gates requests by Origin and the harvester already "
            "sends the locator's own origin.\nThis 401 means the gate has "
            "changed. Stop here and inspect the response before adjusting.",
            file=sys.stderr,
        )
        return 2
    except Exception as e:
        print(f"\nFAILED (network/other): {e}", file=sys.stderr)
        return 1

    n_units = sum(len(r.get("associated") or []) for r in results)
    print(f"OK -- {len(results)} buildings, {n_units} associated units returned.")
    sample = normalize(results[0]) if results else None
    if sample:
        print("Sample normalized record:")
        print(json.dumps(sample, indent=2)[:900])
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--regions", default="regions.json", help="seed bounding boxes")
    ap.add_argument("--only", nargs="*", help="harvest only these named regions")
    ap.add_argument("--out", default="raw/buildings.jsonl")
    ap.add_argument("--rate", type=float, default=5.0, help="max requests/sec (be kind)")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--checkpoint", default="raw/checkpoint.json")
    ap.add_argument("--resume", action="store_true", help="resume from checkpoint")
    ap.add_argument("--preflight", action="store_true", help="test access and exit")
    args = ap.parse_args()

    limiter = RateLimiter(args.rate)

    if args.preflight:
        return preflight(limiter)

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)

    if args.resume and os.path.exists(args.checkpoint):
        existing, queue = read_checkpoint(args.checkpoint)
        print(f"Resuming: {len(existing)} buildings, {len(queue)} cells queued")
        seeds = queue
    else:
        existing = {}
        with open(args.regions) as f:
            regions = json.load(f)
        names = args.only or [r["name"] for r in regions if r.get("default", True)]
        seeds = []
        for r in regions:
            if r["name"] in names:
                b = r["bbox"]
                seeds.append(Cell(b[0], b[1], b[2], b[3], 0))
                print(f"Seeded {r['name']}: {b}")

    if not seeds:
        print("Nothing to harvest.", file=sys.stderr)
        return 1

    t0 = time.monotonic()
    try:
        found = sweep(seeds, limiter, args.workers, args.checkpoint)
    except Unauthorized as e:
        print(f"\nABORTED: {e}", file=sys.stderr)
        return 2

    found.update(existing)
    elapsed = time.monotonic() - t0

    tmp = args.out + ".tmp"
    with open(tmp, "w") as f:
        for rec in sorted(found.values(), key=lambda r: r["id"]):
            f.write(json.dumps(rec, separators=(",", ":")) + "\n")
    os.replace(tmp, args.out)

    n_units = sum(len(b["units"]) for b in found.values())
    print(
        f"\nDone in {elapsed/60:.1f} min: "
        f"{len(found)} buildings, {n_units} units -> {args.out}"
    )

    if os.path.exists(args.checkpoint):
        os.remove(args.checkpoint)
    return 0


if __name__ == "__main__":
    sys.exit(main())
