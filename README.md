# Sabbath Stop

Find a ward to stop at on a Sunday drive.

Give Sabbath Stop your route and it finds Latter-day Saint wards and branches
along the way, filtered by the kind of unit you want, how much time the stop
adds to your drive, and how early or late you would walk in relative to the
sacrament meeting start. It exists because finding a YSA ward that starts
forty minutes after you pass Twin Falls is a real pain on the road.

For every match it shows two numbers:

> **Overland YSA Ward** — Boise, ID · Sacrament 1:00 PM MT
> `+7 min` added to your route · you'd arrive **12 min before** it starts

Everything runs in your browser. There is no account, no backend and nothing
to install.

## A note to the Church's technology team

I built this because there is no way to answer "which ward could I make on
the way?" in the Meetinghouse Locator today, and the data to answer it is
already in the locator. If you would like to merge this capability into the
locator itself, or would rather point me at a better-sanctioned way to use the
API, I am open to either and would appreciate it. The harvester that feeds
this project is deliberately gentle: a few requests per second, once a month,
with a User-Agent that links back here. If any of it is a problem, tell me
and I will change or stop it.

---

## Using it

The app is live at <https://sabbathstop.com/>. It follows
the design in [`APP_SPEC.md`](APP_SPEC.md).

1. **Give it a route.** Type a start and a destination, add stops if you
   like, or paste an Apple Maps link or an expanded Google Maps directions
   URL. A GPX or KML file also works and needs no network at all.
2. **Set when you are leaving.** Maps links do not carry a departure time,
   and every arrival number depends on it. The picker defaults to the next
   Sunday morning. Check it.
3. **Pick the unit types you want.** Conventional, YSA, Spanish, and so on.
   Nothing is selected by default, because an unfiltered list of every ward
   in the country is not useful.
4. **Read the results.** Each one shows how many minutes the stop adds to
   your drive and how early or late you would arrive, in the building's own
   time zone. Sort by best fit, by slack before the meeting, or by distance
   along the route. Hand the chosen stop off to Google or Apple Maps for
   turn-by-turn.

Wards that match your unit type but not your timing show up greyed out. That
is on purpose. Three wards that all start before you arrive is a reason to
leave twenty minutes earlier, not a dead end.

**It works offline once you have a plan.** Add it to your home screen and
the app opens without a connection, showing the last plan you made. Move
the departure to when you are actually leaving and every arrival moves with
it, with the meeting-day check redone for the new day, so "I'm running
forty minutes late" has an answer in a dead zone. Changing stops or planning
a new route needs a connection. The base map only shows the areas you have
already looked at.

**Before you rely on a time, check it.** Every result links to its page on
the official [Meetinghouse Locator](https://maps.churchofjesuschrist.org/).
Meeting times are maintained by local stakes and drift, especially after
January reorganizations, and the dataset here is refreshed monthly rather
than live.

---

## For power users

### Running the data pipeline yourself

The dataset is built by a few Python scripts that need nothing beyond the
standard library.

```bash
python3 test_harvest.py                 # pure-logic tests, no network
python3 harvest.py --preflight          # confirm API access; always first
python3 harvest.py --only utah-test     # ~300 calls, ~1 min, 2k buildings
python3 verify.py  --only utah-test     # independent cross-check
python3 build_tiles.py --min-buildings 2000
```

Output lands in `data/` as a manifest, a catalogue of unit subtypes, and one
JSON tile per degree of latitude and longitude. The app fetches only the
tiles your route touches.

### The monthly refresh

A GitHub Actions workflow re-harvests on the first of each month and commits
the new `data/` if anything changed. You can also start it by hand from the
Actions tab. The `regions` input takes space-separated names from
`regions.json`; leave it blank for the defaults, which cover the whole world
in continent-sized boxes, or pass `utah-test` for a quick validation run.

### If it grows

Routing and geocoding use community-run Valhalla and Photon instances under
fair-use terms. They are fine for personal use and a modest public tool. If
usage ever outgrows that, the answer is to self-host both against a North
America extract, not to pay for a metered API. The calls sit behind a thin
adapter so the base URL is a one-line change.

---

## Data source and etiquette

All meetinghouse and unit data comes from the Church's public
[Meetinghouse Locator](https://maps.churchofjesuschrist.org/). Its API
answers only requests that carry the locator's own `Origin` header and
returns 401 to everything else, so the harvester sends that header.

The harvester is built to be a good guest: 5 requests per second, a monthly
cadence rather than nightly, a descriptive User-Agent that links back to this
repository, and a link from every result to the official locator page. Zero
cost, no API keys, nothing to leak.

The endpoints, the coverage argument, the independent verification, the data
quality flags and the tile layout are all documented in
[`docs/DATA_LAYER.md`](docs/DATA_LAYER.md).

---

## License and data

Code here is yours to license as you like. The underlying meetinghouse data
belongs to The Church of Jesus Christ of Latter-day Saints and is republished
here only to make its intended public use — helping people find a meeting —
work better on the road.
