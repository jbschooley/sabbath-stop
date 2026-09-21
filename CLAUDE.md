# Sabbath Stop

Finds wards and branches of The Church of Jesus Christ of Latter-day Saints
along a driving route, filtered by unit type, detour cost, and
how early or late you'd arrive relative to the meeting start.

Public repo, deployed to GitHub Pages. Static site, no backend.

## State

- **Data layer: done and verified.** `harvest.py`, `verify.py`,
  `build_tiles.py`, `test_harvest.py`, monthly Actions refresh. Default
  regions cover the world.
- **App layer: live** at https://sabbathstop.com/ (GitHub
  Pages from `main`). `index.html`, `js/`, `css/`; tests in `test_app.mjs`
  (`node test_app.mjs`). Every deploy must bump the version stamp in
  `index.html` (the `?v=` on the stylesheet, the import map, and the module
  script) or devices keep the old scripts for ten minutes.
- **The locator API requires an `Origin` header for its own site** or it
  returns 401. `harvest.py` and `verify.py` send it. Preflight and the
  `utah-test` harvest were run successfully with it on 2026-09-20.

## Commands

```bash
python3 test_harvest.py                 # pure-logic tests, no network
python3 harvest.py --preflight          # confirm API access. ALWAYS FIRST.
python3 harvest.py --only utah-test     # ~300 calls, ~1 min, 2k buildings
python3 verify.py  --only utah-test     # independent cross-check
python3 build_tiles.py --min-buildings 2000
```

`raw/` and `data/` are gitignored locally; CI publishes `data/`.

## Hard constraints

**Zero cost, no keys.** Every dependency is free and keyless. Do not introduce
Google Directions/Places, Mapbox, the ABRP Planning API, or the Tesla Fleet
API — all were evaluated and rejected on cost. Routing is Valhalla (FOSSGIS)
with OSRM as fallback; autocomplete geocoding is **Photon, never Nominatim**
(Nominatim's policy prohibits type-ahead). If something genuinely needs a key
later, it goes in a GitHub Actions secret and is consumed at build time —
never inlined into the page, because anything Pages serves is world-readable.

**Be a good citizen.** 5 req/s default, descriptive User-Agent, monthly
refresh not nightly, link every result back to the official locator. Routing
and geocoding run on donated community infrastructure: debounce hard, cache in
`localStorage`, and only run per-candidate detour routing on candidates that
already passed the cheap filters. If usage outgrows fair use, the answer is
self-hosting Valhalla/Photon, not paying.

## Invariants that are easy to break

These are load-bearing and each one has already caused or nearly caused a bug:

1. **Associated unit `type` is `WARD__<SUBTYPE>`, not `WARD`.** An exact
   `== "WARD"` comparison silently drops every non-conventional unit — 17% of
   all units and 100% of YSA wards, while still looking like it works. Match
   on the prefix. `test_harvest.py` has a named regression test; do not
   weaken it.

2. **Valhalla encoded polylines are precision 6**, not the usual 5. Decoding
   at 5 puts you in the wrong hemisphere.

3. **Always compare arrival against the *building's* `tz`**, never the user's.
   Utah alone spans four timezones.

4. **The clusters endpoint is a lower bound, not ground truth.** Some clusters
   stay `dispersed` even at zoom 20 and never enumerate members, so it
   legitimately reports fewer units than a good harvest. Only one direction is
   a real failure: something clusters found that the harvest missed.

5. **Data-quality `flags` are annotations, not deletions.** Upstream has real
   errors — a 22:00 sacrament meeting, an end time before its start, missing
   start times, correctional-facility branches. Surface them; don't silently
   drop or silently trust them.

6. **`lang` is independent of `subType`.** A unit can be `CONVENTIONAL` and
   still meet in Navajo.

## Style

Ask before adding a dependency. Prefer stdlib. The harvester intentionally
uses only `urllib` so CI needs no install step.

When something can't be verified, say so plainly rather than asserting it
works. The preflight situation above is the model.
