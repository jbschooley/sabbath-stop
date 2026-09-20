#!/usr/bin/env python3
"""
Self-contained tests for the pure logic in harvest.py and build_tiles.py.
No network. Run with:  python3 test_harvest.py
"""

import json
import sys

from harvest import Cell, haversine_mi, normalize
from build_tiles import flag_unit, tile_key

FAILS: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name} {detail}")
        FAILS.append(name)


# ---------------------------------------------------------------- geometry

def test_geometry() -> None:
    print("geometry")

    # Known reference: SLC -> Boise, great-circle, ~291 mi.
    d = haversine_mi(-111.891, 40.760, -116.203, 43.613)
    check("haversine SLC->Boise ~291mi", 285 < d < 297, f"got {d:.1f}")

    check("zero distance", haversine_mi(-111.0, 40.0, -111.0, 40.0) == 0.0)

    c = Cell(-112.0, 40.0, -111.0, 41.0)
    check("center", c.center == (-111.5, 40.5))

    # Corner radius must be half the diagonal, and must exceed the distance
    # to any edge midpoint -- that's what makes the coverage test sound.
    cx, cy = c.center
    edge_mid = haversine_mi(cx, cy, cx, c.max_lat)
    check("corner radius > edge midpoint", c.corner_radius_mi > edge_mid)

    # The four children must exactly partition the parent: same total area,
    # no overlap, no gap.
    q = c.quarters()
    check("quarters count", len(q) == 4)
    check("quarters depth", all(x.depth == 1 for x in q))
    area = sum((x.max_lng - x.min_lng) * (x.max_lat - x.min_lat) for x in q)
    parent = (c.max_lng - c.min_lng) * (c.max_lat - c.min_lat)
    check("quarters partition parent", abs(area - parent) < 1e-12)
    check("quarters cover corners",
          min(x.min_lng for x in q) == c.min_lng and
          max(x.max_lng for x in q) == c.max_lng and
          min(x.min_lat for x in q) == c.min_lat and
          max(x.max_lat for x in q) == c.max_lat)


# ------------------------------------------------------------- normalize

# Shape taken verbatim from a live API response.
RAW = {
    "id": "5306132-01-01",
    "nameDisplay": "Ephraim YSA 3, 6 &",
    "coordinates": [-111.57358, 39.361855],
    "timeZone": {"id": "America/Denver"},
    "address": {"city": "EPHRAIM", "stateCode": "UT", "countryCode2": "US",
                "formatted": "571 East 100 North, EPHRAIM, Utah"},
    "website": "https://local.churchofjesuschrist.org/l/5306132",
    "associated": [
        {   # conventional: type is exactly "WARD"
            "id": "12688", "type": "WARD", "nameDisplay": "Moroni 1st Ward",
            "typeDisplay": "Ward / Branch",
            "hours": {"primary": {"hour": {"code": "09:00:00"}},
                      "days": [{"hours": {"ranges": [{"finish": {"code": "11:00:00"}}]}}]},
            "language": {"code": "en"},
        },
        {   # YSA: type is "WARD__YSA", NOT "WARD"
            "id": "81086", "type": "WARD__YSA", "subType": "YSA",
            "nameDisplay": "Ephraim YSA 3rd Ward",
            "typeDisplay": "Young Single Adult Ward / Branch",
            "subTypeDisplay": "Young Single Adult",
            "hours": {"primary": {"hour": {"code": "10:30:00"}},
                      "days": [{"hours": {"ranges": [{"finish": {"code": "12:30:00"}}]}}]},
            "language": {"code": "en"},
        },
        {   # subType absent -- must be recovered from the compound type
            "id": "99999", "type": "WARD__SPANISH",
            "nameDisplay": "Animas Branch",
            "typeDisplay": "Spanish Ward / Branch",
            "hours": {"primary": {"hour": {"code": "12:30:00"}}},
            "language": {"code": "es"},
        },
        {   # not a ward at all -- must be excluded
            "id": "77777", "type": "STAKE", "nameDisplay": "Some Stake",
        },
    ],
}


def test_normalize() -> None:
    print("normalize")
    rec = normalize(RAW)
    assert rec is not None

    check("building id", rec["id"] == "5306132-01-01")
    check("coords rounded", rec["lng"] == -111.57358 and rec["lat"] == 39.361855)
    check("timezone kept", rec["tz"] == "America/Denver")

    names = [u["name"] for u in rec["units"]]

    # THE REGRESSION TEST. An exact `type == "WARD"` filter silently dropped
    # every non-conventional unit -- 17% of all units, and 100% of the YSA
    # wards this tool exists to find. It looked like it worked because
    # conventional wards still came through.
    check("keeps 3 ward units, drops the stake", len(rec["units"]) == 3,
          f"got {len(rec['units'])}: {names}")
    check("YSA ward survives WARD__ prefix",
          any(u["subType"] == "YSA" for u in rec["units"]), f"got {names}")
    check("stake excluded", "Some Stake" not in names)

    by_id = {u["id"]: u for u in rec["units"]}
    check("conventional default subType",
          by_id["12688"]["subType"] == "CONVENTIONAL")
    check("subType recovered from compound type when field absent",
          by_id["99999"]["subType"] == "SPANISH")
    check("start truncated to HH:MM", by_id["81086"]["start"] == "10:30")
    check("end truncated to HH:MM", by_id["81086"]["end"] == "12:30")
    check("missing end tolerated", by_id["99999"]["end"] is None)

    # Meeting day: taken from the API when present, SUNDAY when it is not.
    # A few units worldwide meet on Friday or Saturday.
    check("day defaults to SUNDAY when the API omits it", by_id["12688"]["day"] == "SUNDAY")
    friday = normalize({
        "id": "f", "coordinates": [55.27, 25.2],
        "associated": [{"id": "1", "type": "WARD", "nameDisplay": "Dubai Ward",
                        "hours": {"primary": {"hour": {"code": "10:00:00"}, "day": {"code": "FRIDAY"}}}}],
    })
    check("day taken from primary.day", friday["units"][0]["day"] == "FRIDAY")

    check("no coords -> None", normalize({"id": "x", "coordinates": []}) is None)
    check("no ward units -> None",
          normalize({"id": "x", "coordinates": [0, 0],
                     "associated": [{"type": "STAKE"}]}) is None)


# ------------------------------------------------------------------ tiles

def test_tile_key() -> None:
    print("tile_key")
    # Tiles are named for their SOUTH-WEST corner, so a western longitude
    # floors away from zero: -114.19 lives in the tile spanning [-115, -114).
    check("negative lng floors down", tile_key(-114.196785, 41.26) == "w115_n41")
    check("exact boundary", tile_key(-114.0, 41.0) == "w114_n41")
    check("positive lng", tile_key(13.4, 52.5) == "e13_n52")
    check("southern hemisphere", tile_key(151.2, -33.9) == "e151_s34")

    # Round-trip: any point must land in a tile that actually contains it.
    import math
    for lng, lat in [(-111.9, 40.7), (-0.1, 51.5), (139.7, 35.7), (-70.6, -33.4)]:
        k = tile_key(lng, lat)
        check(f"contains {lng},{lat}",
              k == tile_key(math.floor(lng) + 0.5, math.floor(lat) + 0.5))


def test_flags() -> None:
    print("flag_unit")
    ok = {"start": "10:30", "end": "12:30"}
    check("clean unit unflagged", flag_unit(ok, {"name": "Ephraim YSA"}) == [])

    check("missing start flagged",
          "no_start_time" in flag_unit({"start": None}, {"name": "x"}))

    # Real record: a branch listed as starting at 22:00.
    f = flag_unit({"start": "22:00", "end": "00:00"}, {"name": "Jacob Lake"})
    check("22:00 start implausible", "implausible_start" in f)
    check("end wraps past midnight caught", "end_not_after_start" in f)

    # Real record: end time earlier than start time.
    check("end before start flagged",
          "end_not_after_start" in flag_unit({"start": "15:30", "end": "14:20"},
                                             {"name": "Plain City"}))

    check("correctional facility flagged",
          "restricted_access" in flag_unit(ok, {"name": "Price 12 (Correctional Facility)"}))
    check("boundary 06:00 allowed",
          flag_unit({"start": "06:00", "end": "08:00"}, {"name": "x"}) == [])


if __name__ == "__main__":
    for t in (test_geometry, test_normalize, test_tile_key, test_flags):
        t()
    print()
    if FAILS:
        print(f"{len(FAILS)} FAILED: {', '.join(FAILS)}")
        sys.exit(1)
    print("all tests passed")
