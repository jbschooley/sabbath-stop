#!/usr/bin/env python3
"""
Turn raw/buildings.jsonl into the static dataset the web app consumes.

Output layout (all under --out, default: data/):

    data/manifest.json          index: tile list, counts, bbox, build time
    data/subtypes.json          catalog of every unit subType seen, with counts
    data/languages.json         catalog of every meeting language seen, with counts
    data/tiles/<lng>_<lat>.json one 1-degree tile, only where units exist

The app computes its route's bounding box, buffers it by the user's maximum
detour radius, and fetches only the intersecting tiles. A cross-country route
touches on the order of 50-70 tiles; a typical regional trip, a handful.

Tile naming uses the floor of the tile's SW corner, with 'n'/'s' and 'e'/'w'
prefixes instead of minus signs so the filenames stay shell- and URL-clean:

    -112, 40  ->  tiles/w112_n40.json
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import os
import shutil
import time
from collections import Counter, defaultdict

TILE_DEG = 1.0

# Plausible window for a sacrament meeting start, local time. Anything outside
# this is almost certainly a data-entry error upstream rather than a real
# meeting -- the Utah harvest contains a branch listed as starting at 22:00.
PLAUSIBLE_START_MIN = "06:00"
PLAUSIBLE_START_MAX = "19:00"

# Buildings whose name marks them as not open to a visitor dropping in.
RESTRICTED_MARKERS = ("correctional facility", "detention", "jail", "prison")


def flag_unit(unit: dict, building: dict) -> list[str]:
    """Annotate data-quality problems. We flag, never drop -- the app decides.

    Upstream data is stake-maintained and has real errors in it. Observed in
    the Utah harvest alone: a unit with no start time, a unit with neither
    start nor end, an end time earlier than its start, and a branch listed as
    starting at 22:00.
    """
    flags: list[str] = []
    start, end = unit.get("start"), unit.get("end")

    if not start:
        flags.append("no_start_time")
    else:
        if not (PLAUSIBLE_START_MIN <= start <= PLAUSIBLE_START_MAX):
            flags.append("implausible_start")
        if end and end <= start:
            # Includes the end-before-start case and zero-length meetings.
            flags.append("end_not_after_start")

    name = (building.get("name") or "").lower()
    if any(m in name for m in RESTRICTED_MARKERS):
        flags.append("restricted_access")

    return flags


def tile_key(lng: float, lat: float) -> str:
    x = math.floor(lng / TILE_DEG) * int(TILE_DEG)
    y = math.floor(lat / TILE_DEG) * int(TILE_DEG)
    ew = "w" if x < 0 else "e"
    ns = "s" if y < 0 else "n"
    return f"{ew}{abs(x)}_{ns}{abs(y)}"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", default="raw/buildings.jsonl")
    ap.add_argument("--out", default="data")
    ap.add_argument("--gzip", action="store_true", help="also emit .json.gz next to each tile")
    ap.add_argument(
        "--min-buildings",
        type=int,
        default=1,
        help="refuse to publish if the harvest found fewer than this (guards against "
             "a partial run clobbering a good dataset)",
    )
    args = ap.parse_args()

    if not os.path.exists(args.src):
        print(f"missing {args.src} -- run harvest.py first")
        return 1

    buildings = []
    with open(args.src) as f:
        for line in f:
            line = line.strip()
            if line:
                buildings.append(json.loads(line))

    if len(buildings) < args.min_buildings:
        print(
            f"REFUSING TO PUBLISH: only {len(buildings)} buildings, "
            f"threshold is {args.min_buildings}. Harvest likely incomplete."
        )
        return 2

    tiles: dict[str, list] = defaultdict(list)
    flags: Counter = Counter()
    subtypes: Counter = Counter()
    subtype_labels: dict[str, str] = {}
    languages: Counter = Counter()
    language_labels: dict[str, str] = {}
    missing_start = 0
    missing_tz = 0
    n_units = 0

    min_lng = min_lat = 1e9
    max_lng = max_lat = -1e9

    for b in buildings:
        lng, lat = b["lng"], b["lat"]
        min_lng, max_lng = min(min_lng, lng), max(max_lng, lng)
        min_lat, max_lat = min(min_lat, lat), max(max_lat, lat)

        if not b.get("tz"):
            missing_tz += 1

        for u in b["units"]:
            n_units += 1
            subtypes[u["subType"]] += 1
            subtype_labels[u["subType"]] = u["subTypeDisplay"]
            if u.get("lang"):
                languages[u["lang"]] += 1
                if u.get("langName"):
                    language_labels[u["lang"]] = u["langName"]
            # The name lives in the catalog; the tile keeps only the code.
            u.pop("langName", None)
            if not u.get("start"):
                missing_start += 1

            f = flag_unit(u, b)
            if f:
                u["flags"] = f
                for name in f:
                    flags[name] += 1
            else:
                u.pop("flags", None)

        tiles[tile_key(lng, lat)].append(b)

    # write tiles
    tiles_dir = os.path.join(args.out, "tiles")
    if os.path.isdir(tiles_dir):
        shutil.rmtree(tiles_dir)
    os.makedirs(tiles_dir, exist_ok=True)

    tile_index = {}
    total_bytes = 0
    for key, recs in sorted(tiles.items()):
        recs.sort(key=lambda r: r["id"])
        path = os.path.join(tiles_dir, f"{key}.json")
        payload = json.dumps(recs, separators=(",", ":"))
        with open(path, "w") as f:
            f.write(payload)
        total_bytes += len(payload)
        if args.gzip:
            with open(path, "rb") as fin, gzip.open(path + ".gz", "wb", compresslevel=9) as fout:
                shutil.copyfileobj(fin, fout)
        tile_index[key] = {
            "buildings": len(recs),
            "units": sum(len(r["units"]) for r in recs),
        }

    manifest = {
        "version": 1,
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "tileDegrees": TILE_DEG,
        "bbox": [round(min_lng, 4), round(min_lat, 4), round(max_lng, 4), round(max_lat, 4)],
        "counts": {
            "buildings": len(buildings),
            "units": n_units,
            "tiles": len(tile_index),
            "unitsMissingStartTime": missing_start,
            "buildingsMissingTimezone": missing_tz,
        },
        "flags": dict(flags.most_common()),
        "tiles": tile_index,
        "source": "https://maps.churchofjesuschrist.org/",
        "note": (
            "Meeting times are maintained by local stakes and can be out of date. "
            "Always verify against the official locator before relying on one."
        ),
    }
    with open(os.path.join(args.out, "manifest.json"), "w") as f:
        json.dump(manifest, f, separators=(",", ":"))

    catalog = [
        {"code": code, "label": subtype_labels[code], "count": n}
        for code, n in subtypes.most_common()
    ]
    with open(os.path.join(args.out, "subtypes.json"), "w") as f:
        json.dump(catalog, f, indent=2)

    # Older harvests carry no display names; the app then names the code itself.
    langs = [
        {"code": code, "label": language_labels.get(code, code), "count": n}
        for code, n in languages.most_common()
    ]
    with open(os.path.join(args.out, "languages.json"), "w") as f:
        json.dump(langs, f, indent=2, ensure_ascii=False)

    print(f"buildings      {len(buildings):>8,}")
    print(f"units          {n_units:>8,}")
    print(f"tiles          {len(tile_index):>8,}")
    print(f"subtypes       {len(catalog):>8,}")
    print(f"languages      {len(langs):>8,}")
    print(f"no start time  {missing_start:>8,}  ({missing_start/max(n_units,1)*100:.2f}%)")
    print(f"no timezone    {missing_tz:>8,}")
    print(f"total tile KB  {total_bytes/1024:>8,.0f}")
    print(f"largest tile   {max(tile_index.items(), key=lambda kv: kv[1]['units'])}")
    if flags:
        print("\ndata-quality flags (annotated, not dropped):")
        for name, n in flags.most_common():
            print(f"  {name:<22} {n:>7,}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
