# App layer spec

The data layer is built. This is what gets built on top of it.

---

## Architecture

Three parts with hard seams between them. The point of the split is that the
finder never learns where a route came from, so adding a new import format
later touches exactly one file.

```
  ┌─────────────────┐
  │ Route providers │  google link · apple link · GPX/ABRP · manual A→B · geolocation
  └────────┬────────┘
           │  emits a Route  ← the only contract that matters
           ▼
  ┌─────────────────┐
  │   WardFinder    │  pure: (Route, Filters, Dataset) → Candidate[]
  └────────┬────────┘
           │  emits Candidate[]
           ▼
  ┌─────────────────┐
  │  Map  +  List   │  presentation only, shares one selection state
  └─────────────────┘
```

### The Route contract

Every provider normalizes to this. Nothing downstream may reach past it.

```js
Route = {
  source:        'google' | 'apple' | 'gpx' | 'manual',
  departure:     Date,          // absolute instant
  points:        [{ lng, lat, t, d }],  // t = cumulative SECONDS from departure
                                        // d = cumulative MILES from origin
  bbox:          [minLng, minLat, maxLng, maxLat],
  totalSeconds:  Number,
  totalMiles:    Number,
  places:        [{ name, lng, lat }],  // origin, waypoints, destination
}
```

**`t` on every vertex is the whole design.** It is what makes arrival times
possible, and it is the one thing route sources disagree about:

| Source | How `t` is obtained |
|---|---|
| Manual A→B, Google link, Apple link | Route through Valhalla, then walk `legs[].maneuvers[]` — each has `begin_shape_index`, `end_shape_index` and `time` — distributing each maneuver's time across its vertices by distance. |
| GPX **with** timestamps | Use them directly; this is the highest-fidelity case. |
| GPX **without** timestamps (common from ABRP) | The track has geometry but no timing. Either map-match it with Valhalla `trace_route`, or re-route through its waypoints. Do **not** fake `t` from average speed. |

Because `t` is relative to an absolute `departure`, a route crossing
Mountain into Pacific needs no special handling — arrival is an instant, and
only the comparison to a meeting time is timezone-aware.

### The Candidate contract

```js
Candidate = {
  unit:      { id, name, subType, subTypeDisplay, start, end, lang, flags },
  building:  { id, name, lat, lng, tz, city, state, addr, url },

  milesAlongRoute,    // how far out — sort key 3
  etaAtNearestPoint,  // Date, before detour
  detourMinutes,      // second routing call: origin→building→destination minus baseline
  arrivalAtBuilding,  // Date
  startInstant,       // meeting start on the trip date, resolved in building.tz
  deltaMinutes,       // arrival − start. NEGATIVE = early, positive = late
  score,              // lower is better
  passes,             // bool: survived the time/detour filters
}
```

### Pipeline inside WardFinder

1. Buffer `route.bbox` by the max detour radius; fetch intersecting tiles.
2. Drop units whose `subType` is not selected. **Cheapest filter first** — it
   removes ~85% of everything before any distance math.
3. For each surviving building, find the nearest route vertex. Reject anything
   beyond the detour radius on straight-line distance. This is the coarse pass
   and must stay cheap; use a simple spatial bucket, not a scan.
4. `etaAtNearestPoint = departure + t`. `milesAlongRoute = d`.
5. **Only now** run the per-candidate detour routing. This is the expensive
   call — one route request each — so it must never run on a candidate that
   already failed step 2 or 3.
6. Resolve `startInstant` in `building.tz` for the trip's date, compute
   `deltaMinutes`, apply the time filters, score, sort.

### Sorting

Three modes, all over the same array:

| Mode | Key | Reads as |
|---|---|---|
| **Best fit** | `score` ascending | "just tell me where to stop" |
| **Arrival before start** | `deltaMinutes` ascending, lateness last | "how much slack would I have" |
| **Distance along route** | `milesAlongRoute` ascending | "what are my options, in trip order" |

Scoring for best fit — asymmetric on purpose, because arriving late is much
worse than arriving early, and arriving *very* early is its own cost:

```js
const IDEAL_EARLY = 12;                     // minutes before start
const early = -deltaMinutes;                // positive = early

const latePenalty = deltaMinutes > 0 ? deltaMinutes * 6 : 0;
const waitPenalty = Math.max(0, early - IDEAL_EARLY) * 0.5;
const flagPenalty = unit.flags?.length ? 15 : 0;

score = detourMinutes + latePenalty + waitPenalty + flagPenalty;
```

Two minutes late costs more than twenty minutes of detour. An hour of sitting
in the parking lot costs about 24. Tune the weights, but keep the asymmetry.

### Map and list share one selection

Hovering a list row highlights its pin; clicking a pin scrolls the row into
view. One `selectedId` in state, both views subscribe.

**Show near-misses, greyed out.** Render two visually distinct sets: units
matching the subtype filter but failing the *time* filter get muted pins;
units that actually work get prominent ones. Otherwise an empty stretch of map
is ambiguous — the user cannot tell "no YSA wards near Twin Falls" from "three
of them, all starting before you arrive." The greyed pins turn a dead end into
an argument for shifting departure by twenty minutes.

Each pin's popup carries unit name, subtype, meeting start **with its timezone
abbreviation**, the arrival delta in plain words ("12 min before it starts"),
detour cost, any data-quality flags, and a link to the official locator page.

Use Leaflet with marker clustering — a corridor filter set to "all unit types"
across a cross-country route can return thousands of pins.

**On basemap tiles:** OSM's standard tile servers are donated infrastructure
with a usage policy that a public, popular app can breach. Fine for personal
use with an identifying Referer. If this gets traffic, move to a free-tier
provider or self-host — the same "self-host, don't pay" escape hatch as
routing.

## The output contract

Paste a route. For every unit matching the filters, show two numbers:

> **Overland YSA Ward** — Boise, ID · Sacrament 1:00 PM MT
> `+7 min` added to your route · arrive **12 min before** it starts

1. **Detour cost** — minutes this stop adds to total drive time.
2. **Arrival delta** — minutes early (negative) or late (positive) relative to
   the meeting start, in the *building's* timezone.

Plus the route and all candidates drawn on a map.

## Filters

All persisted to `localStorage`, all live-reapplied without re-routing.

| Filter | Type | Example |
|---|---|---|
| Unit subtypes | multi-select, built from `data/subtypes.json` | `YSA`, `YSA_JR`, `YSA_SR` |
| Language | multi-select, built from `data/languages.json`; empty = any | `es`, `pt` |
| Max detour | minutes | `≤ 10 min` |
| Arrival window | range, relative to meeting start | `-15 min` to `+2 min` |
| Wide mode | single "starts within N of arrival" | `within 2 h` |

**Wide mode** exists for EV trips: rather than a tight arrival window, show
anything starting within 1–2 hours of when you'd get there, so a charging stop
has somewhere to absorb the slack. It replaces the arrival window rather than
narrowing it.

Default the subtype selection to nothing checked and show a prompt — an
unfiltered national result set is meaningless.

## Required input the route link does not provide

**Departure date and time.** Google and Apple Maps share links do not reliably
carry it, and every arrival number depends on it. The app needs its own
picker, defaulting to the next upcoming Sunday morning. Make this prominent —
it is the single input most likely to be silently wrong.

## Route input

Three ways in. All converge on the same internal shape — an ordered list of
places — which then gets routed.

### 1. Enter A and B (primary)

Two text fields with geocode-as-you-type against **Photon**
(`https://photon.komoot.io/api?q=...`, free, keyless, CORS-enabled). Show a
picker when a query is ambiguous rather than silently taking the first hit —
"Springfield" should not quietly choose a state.

Use Photon, **not Nominatim**, for the type-ahead. Nominatim's usage policy
explicitly prohibits autocomplete-style querying and caps you at one request
per second; Photon exists precisely for this. Nominatim is fine for a single
geocode on submit, with a debounce and an identifying User-Agent.

Support optional intermediate waypoints; Valhalla takes any number of
`locations`.

### 2. B only, with A from the device

A **"use my location"** button on the origin field calling
`navigator.geolocation.getCurrentPosition()`. Notes:

- Requires a secure context. GitHub Pages is HTTPS, so this works — but it
  will **not** work if you open `index.html` from `file://` while developing.
  Use a local HTTPS or `localhost` dev server.
- The permission prompt is per-origin and the user can refuse. Always keep the
  manual origin field usable as a fallback; never block on the prompt.
- Pass `enableHighAccuracy: false` and a `timeout` — a road-trip origin does
  not need GPS-grade precision, and high accuracy is slow and battery-hungry.
- Reverse-geocode the fix to a readable name so the user can confirm the app
  understood where they are.

### 3. Paste a Maps link

| Source | Approach |
|---|---|
| Google Maps | Short `maps.app.goo.gl` links **cannot** be expanded from a browser — CORS blocks the redirect. Ask the user to open the link and paste the expanded `/dir/` URL from the address bar, then parse origin, destination and waypoints from the `/dir/` path segments client-side. |
| Apple Maps | `maps.apple.com/?saddr=...&daddr=...` parses directly. |
| GPX / KML upload | Best fidelity, zero network. ABRP exports GPX; Google My Maps exports KML. |

Parsing a link only yields *places*. You still have to route them (step 1 of
the timing math) to get geometry and per-vertex timing — except for GPX/KML,
which already carry geometry and need only the timing pass.

### Handing off to actual navigation

The app plans; it does not do turn-by-turn. Once a ward is chosen, emit deep
links that hand the whole trip to a real nav app:

- Google Maps:
  `https://www.google.com/maps/dir/?api=1&origin=<lat,lng>&destination=<lat,lng>&waypoints=<lat,lng>`
- Apple Maps:
  `https://maps.apple.com/?saddr=<lat,lng>&daddr=<lat,lng>&dirflg=d`

Apple Maps takes a single `daddr`, so for an origin → ward → destination trip
offer two hops, or link only to the ward and let the user resume afterward.

## Timing math

1. **Route** via Valhalla (`https://valhalla1.openstreetmap.de/route`,
   `costing: "auto"`). Verified working from a browser with CORS.
2. **Build a cumulative-time track.** `legs[].maneuvers[]` each carry
   `begin_shape_index`, `end_shape_index` and `time`. Walk the maneuvers,
   distributing each maneuver's time across its shape vertices by distance, to
   get cumulative seconds at every vertex. Valhalla shapes are encoded
   polylines at **precision 6**, not 5 — decoding at precision 5 puts you in
   the wrong hemisphere.
3. **Select candidates.** Compute the route bbox, buffer it by the max detour
   radius, load the intersecting tiles from `data/tiles/`, and keep units
   whose subtype is selected.
4. **Arrival time.** For each candidate building, find the nearest route
   vertex, take its cumulative seconds, add to departure. That instant is
   absolute, so routes crossing timezone lines need no special handling.
5. **Arrival delta.** Convert the arrival instant into the *building's* `tz`
   and compare to `start`. Never use the user's timezone — the Utah harvest
   alone spans four zones.
6. **Detour cost.** Re-route `origin → building → destination` and subtract the
   baseline duration. Exact, and it catches the case where three miles off the
   highway is fourteen minutes because of a river. Only run this on candidates
   that already pass the subtype and rough-proximity filters; it is one routing
   call each.
7. **Rank** by detour ascending, then by how comfortably the arrival sits
   inside the window.

## Respect the data-quality flags

`build_tiles.py` annotates units with a `flags` array. Do not silently show
flagged units as if they were clean:

| Flag | Meaning | Suggested handling |
|---|---|---|
| `no_start_time` | No sacrament start published | Show, but say "time unknown" and never compute a delta |
| `implausible_start` | Start outside 06:00–19:00 | Show with a warning; likely an upstream typo |
| `end_not_after_start` | End ≤ start | Show; ignore the end time |
| `restricted_access` | Correctional facility or similar | Hide by default |

Every result should link to its building's official locator page (`url`), and
the UI should say plainly that meeting times are stake-maintained and drift.

## Cost: zero, and it stays that way

Every dependency is free and **keyless** — nothing here has a billing account
behind it, and there is no key to leak or rotate.

| Need | Service | Cost | Key? |
|---|---|---|---|
| Ward data | Church locator `identify` / `clusters` | free | no |
| Routing | Valhalla, FOSSGIS instance | free | no |
| Routing fallback | OSRM demo server | free | no |
| Autocomplete geocoding | Photon (komoot) | free | no |
| One-shot geocoding | Nominatim | free | no |
| Current location | `navigator.geolocation` | free | n/a |
| Navigation handoff | Google / Apple deep links | free | no |
| Hosting + monthly refresh | GitHub Pages + Actions | free (public repo) | no |

Deliberately **not** used, because all of them meter: Google Directions and
Places, Mapbox, the ABRP Planning API (setup fee plus per-plan charge), and
the Tesla Fleet API.

**The one real risk is not money, it's goodwill.** Valhalla, OSRM, Photon and
Nominatim are community instances run on donated infrastructure under fair-use
policies. They are entirely appropriate for personal use and a modest public
tool. They are not appropriate for something that goes viral, and none of them
owes you uptime. Concretely:

- Debounce autocomplete hard (300 ms plus a 3-character minimum).
- Cache geocode results and routes in `localStorage` — the same trip gets
  planned repeatedly.
- Only run the per-candidate detour routing on candidates that already pass
  the subtype and proximity filters. That is the call that multiplies.
- Send an identifying `Referer`, and link back to each project.

If usage ever outgrows that, the escape hatch is **self-hosting, not paying**:
Valhalla and Photon both run fine on your homelab against a North America
extract, which keeps the bill at zero and removes the fair-use question
entirely. Design the routing and geocoding calls behind a thin adapter now so
swapping the base URL later is a one-line change.

## Hosting

Static files on GitHub Pages. No backend, no keys, no build step required.
The dataset refreshes itself monthly via the Actions workflow.
