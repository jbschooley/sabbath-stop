# Sabbath Stop

Find LDS units along a driving route — filtered by unit type, detour cost, and
how early or late you'd arrive relative to the meeting start.

Paste a route, pick your filters, get back a ranked list:

> **Overland YSA Ward** — Boise, ID · Sacrament 1:00 PM MT
> `+7 min` added to your route · you'd arrive **12 min before** it starts

This repository holds the **data layer**: a harvester that builds a static,
tiled dataset of every meetinghouse and unit, refreshed monthly by GitHub
Actions and served from GitHub Pages. The web app reads those static tiles.

---

## Why a static dataset instead of live API calls

The Church's Meetinghouse Locator exposes a JSON endpoint:

```
GET https://maps.churchofjesuschrist.org/api/maps-proxy/v2/locations/identify
    ?layers=MEETINGHOUSE&filters=&associated=WARDS
    &coordinates=<lng>,<lat>&nearest=50
```

It returns, per building: coordinates, address, **IANA timezone**, and every
unit meeting there with its **sacrament start time** and a structured
`subType`. No key, no login.

Two constraints shape the architecture:

1. **It is origin-gated.** Unless the request carries an `Origin` header
   for the locator's own site, the endpoint returns `HTTP 401` with an empty
   body — CORS itself is permitted (`response.type` is `"cors"`), the server
   simply refuses the request. A static page on another origin cannot call
   it directly. The harvester sends the locator's origin from the server
   side.
2. **There is no bulk endpoint.** `locations/area`, `locations/bbox` and
   `locations/nearby` all 404. `locations/search?query=` exists but hard-caps
   at 10 results and ignores `size`/`limit`.

So the data is harvested ahead of time, tiled, and served as flat JSON. The app
then needs no backend at all, and lookups are instant.

---

## How the harvest works

The only primitive available is "N nearest buildings to a point," so coverage
comes from an adaptive quadtree.

For a cell, query its center for the N nearest buildings and let:

- `R_corner` = distance from the cell center to its farthest corner
- `r_max` = distance to the farthest building returned

Then:

- fewer than N results returned → the API exhausted its data → **covered**
- `r_max >= R_corner` → we hold every building within a disc that fully
  contains the cell → **covered**
- otherwise → the result set was truncated before reaching the cell edge →
  **split into four and recurse**

Given a truthful nearest-N API this is provably complete, and it self-tunes:
cells stay large over empty terrain and subdivide only where buildings are
dense.

### Measured on Utah, the densest geography in the system

| | |
|---|---|
| Region | `[-114.1, 37.0, -109.0, 42.0]` (5.1° × 5.0°) |
| API calls | 297 |
| Buildings found | 2,116 |
| Units found | 5,503 |
| Max recursion depth | 8 |
| Errors | 0 |
| Wall time | 46 s at ~6.5 req/s |

Utah works out to ~12 calls per square degree. Nearly everywhere else is far
sparser, so a full CONUS sweep should land well under 10,000 calls.

### Verifying it, independently

A sweep that checks itself proves nothing. There is a second, completely
different endpoint that answers a different question:

```
GET /api/maps-proxy/v2/locations/clusters
    ?extent=<minLng,minLat,maxLng,maxLat>&layer=MEETINGHOUSE&zoom=20.0
```

At zoom 20 clusters collapse to individual points and each record lists typed
IDs outright — `["WARD:1031", "WARD__CAMBODIAN:158518",
"MEETINGHOUSE:5079551-01-01"]`. It gives a **bbox-exact enumeration** of
building and unit IDs, and it is startlingly cheap: all of Utah returned in a
single 200 ms call. It has no names, meeting times or timezones, which is why
it verifies the harvest rather than replacing it.

`verify.py` runs that cross-check. Measured on Utah:

| | |
|---|---|
| Buildings via clusters | 2,036 |
| Buildings via harvest, inside bbox | **2,036** — zero missed either direction |
| Ward units clusters enumerated | 2,442 |
| Ward units the harvest missed | **1** |

Treat clusters as a **lower bound**, not ground truth: a few clusters stay
`dispersed` even at zoom 20 and never enumerate their members, so it reports
fewer units than a good harvest finds. Only one direction is a real failure —
anything clusters found that the harvest did not. The comparison is restricted
to `WARD`-prefixed types; clusters also returns `STAKE_OFFICE`, `SEMINARY`,
`INSTITUTE`, `TEMPLE`, `FAMILYSEARCH_CENTER` and others, which are not
congregations.

An earlier, weaker check also passed: 152 random probe points producing 419
in-bbox hits with 0 misses.

---

## Usage

```bash
# 0. Pure-logic tests. No network.
python3 test_harvest.py

# 1. Confirm the API answers a plain server-side client. Always do this first.
python3 harvest.py --preflight

# 2. Try the validation region — about a minute.
python3 harvest.py --only utah-test
python3 verify.py --only utah-test
python3 build_tiles.py --min-buildings 2000

# 3. Full default harvest (CONUS + Alaska + Hawaii).
python3 harvest.py
python3 verify.py --max-missing 5
python3 build_tiles.py --gzip --min-buildings 15000
```

### A note on the Member Tools API

`membertools-api.churchofjesuschrist.org/api/v5/maps/*` offers a similar
surface — including `locations/clusters` and a `WARD` layer — but **every
request carries a `Bearer` JWT tied to a personal member account**, and the
public mirror returns 401 for endpoints like `maps/geocode` that only exist
there. It is not a usable source for this project: it would mean putting
personal credentials into CI, harvesting at scale through one member's
account, and redistributing data that is not published publicly.

It was still worth looking at. The public locator turned out to expose the
same `locations/clusters?extent=` route with no auth at all — which is where
`verify.py` came from.

Long runs checkpoint to `raw/checkpoint.json`; resume with `--resume`.

### Output

```
data/manifest.json           tile index, counts, bbox, build timestamp
data/subtypes.json           every subType seen, with labels and counts
data/tiles/w112_n40.json     one 1° tile
```

The app computes its route bounding box, buffers it by the user's maximum
detour radius, and fetches only intersecting tiles.

---

## Unit subtypes

`subType` is a real structured field, so filtering never depends on grepping
ward names. Utah alone yields 37 distinct values. The most common:

| Code | Label | Utah count |
|---|---|---|
| `CONVENTIONAL` | Conventional | 4,564 |
| `YSA` | Young Single Adult | 231 |
| `YSA_JR` | Young Single Adult 18–25 | 221 |
| `SPANISH` | Spanish | 158 |
| `YSA_SR` | Young Single Adult 26–35 | 75 |
| `STUDENT_MARRIED` | Student Married | 65 |
| `TONGAN` | Tongan | 51 |
| `SAMOAN` | Samoan | 33 |
| `SINGLE_ADULT` | Single Adult | 28 |
| `DEAF` | Sign Language | 6 |

The long tail includes `SPANISH_YSA`, `MANDARIN`, `MARSHALLESE`,
`HAITIAN_CREOLE`, `JUBA_ARABIC`, `NATIVE_AMERICAN`, `SEASONAL` and more. A
national harvest will turn up others — `data/subtypes.json` is generated from
whatever the harvest actually found, so the filter UI should build itself from
that file rather than a hardcoded list.

---

## Data quality notes

Upstream data is stake-maintained and has real errors in it. `build_tiles.py`
annotates each unit with a `flags` array rather than dropping anything — the
app decides what to do. Cases observed in the Utah harvest alone:

| Flag | What it caught |
|---|---|
| `no_start_time` | 14 units with no published sacrament start |
| `implausible_start` | a branch listed as starting at **22:00** |
| `end_not_after_start` | a ward with start 15:30 and end **14:20** |
| `restricted_access` | correctional-facility branches you can't drop in on |

- **Meeting times drift**, especially after January reorganizations. Every
  result should link back to the official locator, and the UI should say
  plainly that times need verifying.
- **`lang` is independent of `subType`.** A unit can be `CONVENTIONAL` and
  still meet in Navajo (`nv`). Filter on both if language matters.
- **Timezones vary within a single state.** The Utah harvest alone spans
  `America/Denver`, `America/Boise`, `America/Phoenix` and
  `America/Los_Angeles`. Always compare arrival to meeting time using the
  *building's* `tz`, never the user's.

---

## Secrets: there are none, by construction

This repo is intended to be public, and **nothing it talks to requires
authentication**. There is no key, token or credential anywhere in the code,
and no `.env` to forget about. The full list of hosts the code contacts:

- `maps.churchofjesuschrist.org` — public locator, unauthenticated
- `local.churchofjesuschrist.org` — public unit pages, link targets only

The only thing to personalize is `USER_AGENT` in `harvest.py`, which carries a
placeholder repo URL. Point it at your own.

If the app ever gains a feature that does need a key — a commercial routing or
geocoding tier, say — it goes in a **GitHub Actions secret** and is consumed
server-side at build time. It must never be inlined into the published page:
anything shipped to `data/` or the site itself is world-readable the moment
Pages serves it, and a key in client-side JavaScript is a published key
regardless of referrer restrictions.

Before the first push, confirm nothing snuck in:

```bash
git log -p | grep -iE 'bearer |authorization:|eyJ[A-Za-z0-9_-]{10,}\.' || echo clean
```

## Being a good citizen

This hits a public service that publishes no API contract, so:

- Default rate limit is a modest 5 req/s. Don't raise it without a reason.
- The `User-Agent` is descriptive and carries a contact URL — **set it to your
  own repository** before running.
- Refresh monthly, not nightly.
- Link every result back to the official locator.

**On the 401:** the endpoint refuses requests that don't carry the locator's
own `Origin`, and the harvester sends that header. If `--preflight` ever
starts failing with 401 anyway, the gate has changed; the harvester aborts
rather than continuing, so look at the response before adjusting anything.

---

## Routing (for the app layer)

Free and keyless, both verified working from a browser with CORS:

- **Valhalla (FOSSGIS)** — `https://valhalla1.openstreetmap.de/route`.
  Preferred: `legs[].maneuvers[]` carry `begin_shape_index`, `end_shape_index`
  and `time`, so cumulative seconds can be interpolated at every shape vertex,
  which is exactly what arrival-time matching needs.
- **OSRM demo** — `https://router.project-osrm.org/route/v1/driving/...`.
  Simpler output, good fallback.

Both are community instances under fair-use policies — fine for personal use,
not for something that goes viral. If it grows, self-host Valhalla.

**Route import:** GPX/KML upload needs no network at all. Google Maps short
links (`maps.app.goo.gl`) cannot be expanded from a browser — CORS blocks the
redirect — so have the user open the link and paste the **expanded** URL from
their address bar, which parses client-side fine.

---

## License and data

Code here is yours to license as you like. The underlying meetinghouse data
belongs to The Church of Jesus Christ of Latter-day Saints and is republished
here only to make its intended public use — helping people find a meeting —
work better on the road.
