#!/usr/bin/env node
// Pure-logic tests for the app modules. No network, no DOM.
//   node test_app.mjs

import assert from "node:assert/strict";
import { decodePolyline, haversineMi, tileKey, tilesForBbox, bufferBbox, VertexBuckets } from "./js/geo.js";
import { meetingStartInstant, zonedToInstant, tzOffsetMinutes, defaultDepartureLocal } from "./js/tz.js";
import { score, inWindow, sortCandidates, detourRadiusMiles, findCandidates, exitVertices, batchAlongRoute, DEFAULT_FILTERS } from "./js/finder.js";
import { dwellBefore, applyDwell } from "./js/routing.js";
import { parseAbrpXlsx, parseAbrpRows, parseSheetRows, parseAbrpDuration, parseClock, cleanStopName, isUnresolvableName, readZipEntry } from "./js/abrp.js";
import { deflateRawSync } from "node:zlib";
import { parseGoogleUrl, parseAppleUrl, parseGoogleDeparture, parseLink, defaultDwellMinutes } from "./js/providers.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
async function atest(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

console.log("geo");
// Reference encoder so the decoder can be checked by round trip at precision 6.
function encodePolyline(coords, precision) {
  const factor = 10 ** precision;
  let out = "", lastLat = 0, lastLng = 0;
  const enc = (v) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    let s = "";
    while (n >= 0x20) { s += String.fromCharCode((0x20 | (n & 0x1f)) + 63); n >>= 5; }
    return s + String.fromCharCode(n + 63);
  };
  for (const [lng, lat] of coords) {
    const la = Math.round(lat * factor), lo = Math.round(lng * factor);
    out += enc(la - lastLat) + enc(lo - lastLng);
    lastLat = la; lastLng = lo;
  }
  return out;
}
test("polyline decoder matches Google's documented precision-5 vector", () => {
  const pts = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@", 5);
  assert.deepEqual(pts, [[-120.2, 38.5], [-120.95, 40.7], [-126.453, 43.252]]);
});
test("polyline6 round-trips Utah coordinates at precision 6", () => {
  const coords = [[-111.891, 40.76], [-111.88, 40.77], [-113.5813, 37.0965]];
  const pts = decodePolyline(encodePolyline(coords, 6), 6);
  coords.forEach(([lng, lat], i) => {
    assert.ok(Math.abs(pts[i][0] - lng) < 1e-6 && Math.abs(pts[i][1] - lat) < 1e-6, JSON.stringify(pts[i]));
  });
});
test("decoding a precision-6 string at precision 5 lands in the wrong hemisphere", () => {
  const pts = decodePolyline(encodePolyline([[-111.891, 40.76]], 6), 5);
  assert.ok(Math.abs(pts[0][1]) > 90 || Math.abs(pts[0][0]) > 180, JSON.stringify(pts[0]));
});
test("haversine SLC to Provo is about 38 miles", () => {
  const mi = haversineMi(-111.891, 40.760, -111.658, 40.234);
  assert.ok(mi > 36 && mi < 40, String(mi));
});
test("tileKey matches build_tiles.py", () => {
  assert.equal(tileKey(-111.9, 40.7), "w112_n40");
  assert.equal(tileKey(-0.1, 51.5), "w1_n51");
  assert.equal(tileKey(139.7, 35.7), "e139_n35");
  assert.equal(tileKey(-70.6, -33.4), "w71_s34");
  assert.equal(tileKey(-112, 40), "w112_n40");
});
test("tilesForBbox enumerates every degree cell", () => {
  const keys = tilesForBbox([-112.5, 40.2, -111.1, 41.1]);
  assert.deepEqual(keys.sort(), ["w112_n40", "w112_n41", "w113_n40", "w113_n41"].sort());
});
test("bufferBbox grows in every direction", () => {
  const [a, b, c, d] = bufferBbox([-112, 40, -111, 41], 10);
  assert.ok(a < -112 && b < 40 && c > -111 && d > 41);
});
test("VertexBuckets finds the nearest vertex within radius and nothing outside", () => {
  const pts = [];
  for (let i = 0; i <= 100; i++) pts.push({ lng: -112 + i * 0.01, lat: 40, t: i, d: i });
  const vb = new VertexBuckets(pts);
  const hit = vb.nearest(-111.5, 40.02, 5);
  assert.equal(hit.index, 50);
  assert.ok(hit.miles < 2);
  assert.equal(vb.nearest(-111.5, 41, 5).index, -1);
});

console.log("tz");
test("noon in Denver on a DST day is 18:00Z", () => {
  const inst = zonedToInstant(2026, 9, 27, 12, 0, "America/Denver");
  assert.equal(inst.toISOString(), "2026-09-27T18:00:00.000Z");
});
test("noon in Denver in January is 19:00Z", () => {
  assert.equal(zonedToInstant(2026, 1, 11, 12, 0, "America/Denver").toISOString(), "2026-01-11T19:00:00.000Z");
});
test("offset is -360 in September and -420 in January for Denver", () => {
  assert.equal(tzOffsetMinutes(new Date("2026-09-27T18:00:00Z"), "America/Denver"), -360);
  assert.equal(tzOffsetMinutes(new Date("2026-01-11T19:00:00Z"), "America/Denver"), -420);
});
test("meeting start resolves on the arrival's calendar day in the building's zone", () => {
  // Arrival 2026-09-27T05:30Z is still Saturday evening in Denver (23:30 MDT).
  const arrival = new Date("2026-09-27T05:30:00Z");
  const start = meetingStartInstant(arrival, "09:00", "America/Denver");
  assert.equal(start.toISOString(), "2026-09-26T15:00:00.000Z");
});
test("Arizona has no DST", () => {
  assert.equal(zonedToInstant(2026, 7, 5, 9, 0, "America/Phoenix").toISOString(), "2026-07-05T16:00:00.000Z");
});
test("dwellBefore sums stops passed before a leg; origin and destination carry none", () => {
  const places = [{ name: "A" }, { name: "S1", dwellSeconds: 600 }, { name: "S2", dwellSeconds: 1800 }, { name: "B", dwellSeconds: 9999 }];
  assert.equal(dwellBefore(places, 0), 0);
  assert.equal(dwellBefore(places, 1), 600);
  assert.equal(dwellBefore(places, 2), 2400);
  assert.equal(dwellBefore(places, 3), 2400, "destination dwell never counts");
});
test("applyDwell shifts later legs and keeps drive so a scale can be reapplied", () => {
  const places = [{ name: "A" }, { name: "S", dwellSeconds: 1200 }, { name: "B" }];
  const pts = [{ t: 0, leg: 0 }, { t: 100, leg: 0 }, { t: 100, leg: 1 }, { t: 300, leg: 1 }];
  applyDwell(pts, places);
  assert.deepEqual(pts.map((p) => p.t), [0, 100, 1300, 1500]);
  applyDwell(pts, places, 2);
  assert.deepEqual(pts.map((p) => p.t), [0, 200, 1400, 1800], "dwell is not scaled, driving is");
});
test("default departure is now, rounded up to five minutes", () => {
  assert.equal(defaultDepartureLocal(new Date(2026, 8, 20, 15, 3, 40)), "2026-09-20T15:05");
  assert.equal(defaultDepartureLocal(new Date(2026, 8, 20, 15, 0, 0)), "2026-09-20T15:00");
  assert.equal(defaultDepartureLocal(new Date(2026, 8, 20, 23, 58, 0)), "2026-09-21T00:00");
});

console.log("finder");
test("score: a minute late costs as much as six minutes of detour, early is cheap", () => {
  const late = { unit: {}, detourMinutes: 0, deltaMinutes: 1 };
  const detour = { unit: {}, detourMinutes: 6, deltaMinutes: -12 };
  assert.equal(score(late), score(detour));
  const early = { unit: {}, detourMinutes: 0, deltaMinutes: -12 };
  assert.equal(score(early), 0, "twelve minutes early is the ideal and costs nothing");
  assert.ok(score({ unit: {}, detourMinutes: 0, deltaMinutes: 2 }) > score({ unit: {}, detourMinutes: 0, deltaMinutes: -30 }));
});
test("score: an hour early costs about 24", () => {
  const s = score({ unit: {}, detourMinutes: 0, deltaMinutes: -60 });
  assert.ok(Math.abs(s - 24) < 0.01, String(s));
});
test("score: flags add 15, unknown time is Infinity", () => {
  assert.equal(score({ unit: { flags: ["end_not_after_start"] }, detourMinutes: 3, deltaMinutes: -12 }), 18);
  assert.equal(score({ unit: {}, detourMinutes: 3, deltaMinutes: null }), Infinity);
});
test("inWindow: normal window and wide mode", () => {
  const f = { windowMin: -15, windowMax: 2, wide: false, wideHours: 2 };
  assert.ok(inWindow(-15, f) && inWindow(2, f) && !inWindow(3, f) && !inWindow(-16, f) && !inWindow(null, f));
  const w = { ...f, wide: true };
  assert.ok(inWindow(-119, w) && inWindow(119, w) && !inWindow(121, w));
});
test("sortCandidates: arrival mode puts late and unknown last", () => {
  const list = [
    { deltaMinutes: 5, milesAlongRoute: 1, score: 1 },
    { deltaMinutes: -20, milesAlongRoute: 2, score: 2 },
    { deltaMinutes: null, milesAlongRoute: 3, score: 3 },
    { deltaMinutes: -3, milesAlongRoute: 4, score: 4 },
  ];
  assert.deepEqual(sortCandidates(list, "arrival").map((c) => c.deltaMinutes), [-20, -3, 5, null]);
  assert.deepEqual(sortCandidates(list, "distance").map((c) => c.milesAlongRoute), [1, 2, 3, 4]);
});
test("sortCandidates: earliest mode orders by meeting start, then off-route distance, unknown last", () => {
  const at = (h) => new Date(Date.UTC(2026, 8, 27, h));
  const list = [
    { id: "noon-far", startInstant: at(18), offRouteMiles: 3 },
    { id: "unknown", startInstant: null, offRouteMiles: 0 },
    { id: "nine", startInstant: at(15), offRouteMiles: 2 },
    { id: "noon-near", startInstant: at(18), offRouteMiles: 1 },
  ];
  assert.deepEqual(sortCandidates(list, "earliest").map((c) => c.id), ["nine", "noon-near", "noon-far", "unknown"]);
});
test("defaults: 30 min detour, arrive 60 early to 10 late", () => {
  assert.equal(DEFAULT_FILTERS.maxDetourMin, 30);
  assert.equal(DEFAULT_FILTERS.windowMin, -60);
  assert.equal(DEFAULT_FILTERS.windowMax, 10);
});
test("detour radius has a floor and grows with the budget", () => {
  assert.equal(detourRadiusMiles(1), 3);
  assert.ok(detourRadiusMiles(60) > detourRadiusMiles(10));
});

test("exitVertices picks vertices about EXIT_SPAN_MI before and after", () => {
  const pts = [];
  for (let i = 0; i <= 100; i++) pts.push({ d: i, t: i * 60 });
  assert.deepEqual(exitVertices(pts, 50, 4), [46, 50, 54]);
  assert.deepEqual(exitVertices(pts, 1, 4), [0, 1, 5]);
  assert.deepEqual(exitVertices(pts, 100, 4), [96, 100]);
});
test("batchAlongRoute respects the size and span limits", () => {
  const jobs = [];
  for (let i = 0; i < 50; i++) jobs.push({ milesAlongRoute: i * 5 }); // 0..245 mi
  const b = batchAlongRoute(jobs);
  assert.ok(b.every((x) => x.length <= 20));
  assert.ok(b.every((x) => x[x.length - 1].milesAlongRoute - x[0].milesAlongRoute <= 60));
  assert.equal(b.flat().length, 50);
});

// Shared fixture: a straight east-west route along lat 40, one hour long.
function fixture() {
  const points = [];
  for (let i = 0; i <= 100; i++) points.push({ lng: -112 + i * 0.01, lat: 40, t: i * 36, d: i * 0.53, leg: 0 });
  const departure = new Date("2026-09-27T14:00:00Z"); // 08:00 MDT
  const route = {
    departure, points, bbox: [-112, 40, -111, 40], driveSeconds: 3600, dwellSeconds: 0, totalSeconds: 3600, timeScale: 1, totalMiles: 53,
    places: [{ name: "A", lng: -112, lat: 40 }, { name: "B", lng: -111, lat: 40 }], legSeconds: [3600],
  };
  const building = (id, lng, lat, units) => ({ id, name: id, lng, lat, tz: "America/Denver", city: "X", state: "UT", units });
  const tile = [
    // Halfway along (t = 1800s -> 08:30). A 08:45 YSA start: 15 min early before detour.
    building("mid", -111.5, 40.01, [{ id: "u1", name: "Mid YSA", subType: "YSA", start: "08:45" }]),
    // Same spot, wrong subtype: filtered before any distance math.
    building("wrongtype", -111.5, 40.01, [{ id: "u2", name: "Mid Spanish", subType: "SPANISH", start: "08:45" }]),
    // Far off the route: never reaches routing.
    building("far", -111.5, 41.5, [{ id: "u3", name: "Far YSA", subType: "YSA", start: "08:45" }]),
    // Near, but starts at 08:00: already 30 min late at the nearest point, never timed.
    building("late", -111.5, 40.01, [{ id: "u4", name: "Late YSA", subType: "YSA", start: "08:00" }]),
    // No published time: flagged, hidden unless showFlagged.
    building("notime", -111.5, 40.01, [{ id: "u5", name: "Unknown YSA", subType: "YSA", start: null, flags: ["no_start_time"] }]),
  ];
  const filters = { subtypes: ["YSA"], maxDetourMin: 10, windowMin: -15, windowMax: 2, wide: false, wideHours: 2, showFlagged: false, sort: "best" };
  return { route, tile, filters };
}
// Fake matrix: straight-line time at 30 mph.
const fakeMatrix = async (sources, targets) =>
  sources.map((s) => targets.map((t) => (haversineMi(s.lng, s.lat, t.lng, t.lat) / 30) * 3600));

await atest("findCandidates: matrix pipeline times only promising candidates", async () => {
  const { route, tile, filters } = fixture();
  const matrixCalls = [];
  const deps = {
    loadTile: async (key) => (key === "w112_n40" ? tile : null),
    matrix: async (s, t) => { matrixCalls.push([s.length, t.length]); return fakeMatrix(s, t); },
    routeDetour: async () => { throw new Error("should not be called"); },
    concurrency: 1,
  };
  const out = await findCandidates(route, filters, deps);
  assert.equal(matrixCalls.length, 2, "one batch = two matrix calls");
  const ids = out.map((c) => c.unit.id);
  assert.ok(ids.includes("u1") && ids.includes("u4") && !ids.includes("u2") && !ids.includes("u3") && !ids.includes("u5"), ids.join(","));
  const mid = out.find((c) => c.unit.id === "u1");
  assert.equal(mid.passes, true);
  // Nearest vertex is directly south (0.69 mi); best exit is that vertex both ways.
  const leg = (haversineMi(-111.5, 40, -111.5, 40.01) / 30) * 60; // minutes
  assert.ok(Math.abs(mid.detourMinutes - 2 * leg) < 0.05, `${mid.detourMinutes} vs ${2 * leg}`);
  // arrival = 08:30 + leg; start 08:45
  assert.ok(Math.abs(mid.deltaMinutes - (leg - 15)) < 0.05, String(mid.deltaMinutes));
  assert.equal(out[0].unit.id, "u1", "best fit sorts first");
  assert.equal(out.find((c) => c.unit.id === "u4").passes, false);
});

await atest("findCandidates: showFlagged surfaces flagged units with no delta", async () => {
  const { route, tile, filters } = fixture();
  const deps = { loadTile: async () => tile, matrix: fakeMatrix, concurrency: 1 };
  const out = await findCandidates(route, { ...filters, showFlagged: true }, deps);
  const u5 = out.find((c) => c.unit.id === "u5");
  assert.ok(u5, "flagged unit present");
  assert.equal(u5.deltaMinutes, null);
  assert.equal(u5.passes, false);
});

await atest("findCandidates: a failing matrix batch falls back to a full re-route", async () => {
  const { route, tile, filters } = fixture();
  const routed = [];
  const deps = {
    loadTile: async () => tile,
    matrix: async () => { throw new Error("Path distance exceeds the max distance limit"); },
    routeDetour: async (places) => { routed.push(places[1].name); return { legSeconds: [1830, 1830], totalSeconds: 3660 }; },
    concurrency: 1,
  };
  const out = await findCandidates(route, filters, deps);
  assert.deepEqual(routed, ["mid"]);
  const mid = out.find((c) => c.unit.id === "u1");
  assert.equal(mid.routed, true);
  assert.equal(Math.round(mid.detourMinutes), 1);
  assert.ok(Math.abs(mid.deltaMinutes + 14.5) < 0.01, String(mid.deltaMinutes));
});

await atest("findCandidates: dwell at an earlier stop delays arrival in both timing paths", async () => {
  // Same route, but a stop at the 25% mark with a 30-minute dwell.
  const { route, tile, filters } = fixture();
  route.places = [route.places[0], { name: "S", lng: -111.75, lat: 40, dwellSeconds: 1800 }, route.places[1]];
  route.points.forEach((p, i) => { p.leg = i < 25 ? 0 : 1; });
  applyDwell(route.points, route.places);
  route.dwellSeconds = 1800; route.totalSeconds = 5400; route.legSeconds = [900, 2700];
  const wide = { ...filters, windowMin: -120, windowMax: 120 };
  const leg = (haversineMi(-111.5, 40, -111.5, 40.01) / 30) * 60;

  const viaMatrix = await findCandidates(route, wide, { loadTile: async () => tile, matrix: fakeMatrix, concurrency: 1 });
  const m = viaMatrix.find((c) => c.unit.id === "u1");
  // arrival = 08:00 + 1800 s drive + 1800 s dwell + leg -> 09:00 + leg; start 08:45
  assert.ok(Math.abs(m.deltaMinutes - (15 + leg)) < 0.05, `matrix: ${m.deltaMinutes}`);

  const viaRoute = await findCandidates(route, wide, {
    loadTile: async () => tile,
    matrix: async () => { throw new Error("no"); },
    routeDetour: async () => ({ legSeconds: [900, 930, 1830], totalSeconds: 3660 }),
    concurrency: 1,
  });
  const r = viaRoute.find((c) => c.unit.id === "u1");
  // arrival = 08:00 + (900 + 930) s drive + 1800 s dwell = 09:00:30; detour 60 s
  assert.ok(Math.abs(r.deltaMinutes - 15.5) < 0.01, `route: ${r.deltaMinutes}`);
  assert.equal(Math.round(r.detourMinutes), 1);
});

await atest("findCandidates: traffic scale applies to matrix legs too", async () => {
  const { route, tile, filters } = fixture();
  route.timeScale = 2; route.totalSeconds *= 2; applyDwell(route.points, route.places, 2);
  const deps = { loadTile: async () => tile, matrix: fakeMatrix, concurrency: 1 };
  const out = await findCandidates(route, { ...filters, windowMin: -120, windowMax: 120 }, deps);
  const mid = out.find((c) => c.unit.id === "u1");
  const leg = (haversineMi(-111.5, 40, -111.5, 40.01) / 30) * 60;
  assert.ok(Math.abs(mid.detourMinutes - 4 * leg) < 0.05, String(mid.detourMinutes));
  // arrival = 08:00 + 2*1800 s + 2*leg -> 09:00 + 2*leg; start 08:45
  assert.ok(Math.abs(mid.deltaMinutes - (15 + 2 * leg)) < 0.05, String(mid.deltaMinutes));
});

console.log("providers");
test("Google /dir/ URL yields places in order and stops at @", () => {
  const p = parseGoogleUrl("https://www.google.com/maps/dir/Salt+Lake+City,+UT/Cedar+City,+UT/St.+George,+UT/@38.5,-112.3,8z/data=!4m2!4m1!3e0");
  assert.deepEqual(p.map((x) => x.query), ["Salt Lake City, UT", "Cedar City, UT", "St. George, UT"]);
});
test("Google URL with coordinates yields lat/lng places", () => {
  const p = parseGoogleUrl("https://www.google.com/maps/dir/40.76,-111.89/37.1,-113.58/");
  assert.ok(Math.abs(p[0].lat - 40.76) < 1e-9 && Math.abs(p[0].lng + 111.89) < 1e-9);
  assert.equal(p.length, 2);
});
test("short Google links are refused with a helpful message", () => {
  assert.throws(() => parseGoogleUrl("https://maps.app.goo.gl/abc123"), /paste the full/);
});
test("Google depart-at time is read from the data blob, arrive-by is not", () => {
  const base = "https://www.google.com/maps/dir/Salt+Lake+City,+UT/St.+George,+UT/@38.5,-112.3,8z/data=!4m8!4m7!1m1!4e1!1m1!4e1!2m3!6e0!7e2!8j1790330400";
  assert.equal(parseGoogleDeparture(base).getTime(), 1790330400 * 1000);
  assert.equal(parseGoogleDeparture(base.replace("!6e0", "!6e1")), null);
  assert.equal(parseGoogleDeparture("https://www.google.com/maps/dir/A/B/"), null);
  assert.equal(parseGoogleDeparture("https://www.google.com/maps/dir/A/B/data=!8j12"), null);
});
test("Apple Maps link parses saddr and daddr", () => {
  const p = parseAppleUrl("https://maps.apple.com/?saddr=Salt+Lake+City&daddr=37.1,-113.58&dirflg=d");
  assert.equal(p[0].query, "Salt Lake City");
  assert.ok(Math.abs(p[1].lat - 37.1) < 1e-9);
});
test("links without a start yield a null origin (use the device location)", () => {
  const g = parseGoogleUrl("https://www.google.com/maps/dir//Cedar+City,+UT/St.+George,+UT/@38.5,-112.3,8z/");
  assert.equal(g[0], null);
  assert.deepEqual(g.slice(1).map((x) => x.query), ["Cedar City, UT", "St. George, UT"]);
  const a = parseAppleUrl("https://maps.apple.com/?daddr=St.+George,+UT&dirflg=d");
  assert.equal(a[0], null);
  assert.equal(a[1].query, "St. George, UT");
});
test("Apple daddr chains stops with ' to:'", () => {
  const a = parseAppleUrl("https://maps.apple.com/?saddr=Boise&daddr=Twin+Falls+Supercharger+to:Provo,+UT");
  assert.deepEqual(a.map((x) => x && x.query), ["Boise", "Twin Falls Supercharger", "Provo, UT"]);
});
test("parseLink routes to the right parser and carries the Google departure", () => {
  const g = parseLink("https://www.google.com/maps/dir/A/B/data=!2m3!6e0!7e2!8j1790330400");
  assert.equal(g.source, "google");
  assert.equal(g.departure.getTime(), 1790330400 * 1000);
  const a = parseLink("https://maps.apple.com/?daddr=B");
  assert.equal(a.source, "apple");
  assert.equal(a.departure, null);
  assert.throws(() => parseLink("https://example.com/"), /doesn't look like/);
});
test("Google ?saddr/daddr form (what ABRP emits) parses with chained stops", () => {
  const p = parseGoogleUrl("https://www.google.com/maps?daddr=40.5884056,-111.9092865+to:40.2969000,-111.6946000&saddr=41.0081160,-111.9342200&dirflg=d&geocode=x;y;z");
  assert.equal(p.length, 3);
  assert.ok(Math.abs(p[0].lat - 41.008116) < 1e-9 && Math.abs(p[0].lng + 111.93422) < 1e-9, "origin from saddr");
  assert.ok(Math.abs(p[1].lat - 40.5884056) < 1e-9, "first stop");
  assert.ok(Math.abs(p[2].lat - 40.2969) < 1e-9, "destination");
  const noStart = parseGoogleUrl("https://www.google.com/maps?daddr=40.5,-111.9&dirflg=d");
  assert.equal(noStart[0], null);
});
test("defaultDwellMinutes: Superchargers get 15, everything else 0", () => {
  assert.equal(defaultDwellMinutes({ query: "Tesla Supercharger, Beaver, UT" }), 15);
  assert.equal(defaultDwellMinutes({ name: "Beaver Supercharger" }), 15);
  assert.equal(defaultDwellMinutes({ query: "Beaver, UT" }), 0);
  assert.equal(defaultDwellMinutes(null), 0);
});

console.log("abrp");
test("parseAbrpDuration and parseClock read ABRP's text formats", () => {
  assert.equal(parseAbrpDuration("1 h 7 min"), 4020);
  assert.equal(parseAbrpDuration("36 min"), 2160);
  assert.equal(parseAbrpDuration("2 h"), 7200);
  assert.equal(parseAbrpDuration("58 mi"), null);
  assert.equal(parseAbrpDuration(""), null);
  assert.equal(parseClock("4:09 PM"), 16 * 60 + 9);
  assert.equal(parseClock("12:05 AM"), 5);
  assert.equal(parseClock("12:30 PM"), 12 * 60 + 30);
  assert.equal(parseClock("31 mi"), null);
});
test("cleanStopName strips bracketed tags; isUnresolvableName spots placeholders", () => {
  assert.equal(cleanStopName("Tesla Supercharger [Saini Charge] Sandy, UT [Tesla]"), "Tesla Supercharger Sandy, UT");
  assert.ok(isUnresolvableName("Home") && isUnresolvableName("Point on map") && !isUnresolvableName("Provo, UT"));
});

// A sheet shaped exactly like ABRP's export, as inline-string cells.
const cell = (ref, v, t = "inlineStr") => (t === "n" ? `<c r="${ref}" t="n"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`);
const SHEET_XML = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1">${cell("A1", "ABRP Plan")}</row>
<row r="2">${cell("A2", "https://abetterrouteplanner.com/?plan_uuid=2-abc")}</row>
<row r="4">${["Waypoint", "Arrival SoC", "Depart SoC", "Cost", "Charge Card", "Charge duration", "Distance", "Drive duration", "Arrival", "Departure"].map((h, i) => cell(String.fromCharCode(65 + i) + "4", h)).join("")}</row>
<row r="5">${cell("A5", "Point on map")}${cell("C5", "0.26", "n")}${cell("G5", "31 mi")}${cell("H5", "31 min")}${cell("J5", "4:09 PM")}</row>
<row r="6">${cell("A6", "Tesla Supercharger [Saini Charge] Sandy, UT [Tesla]")}${cell("B6", "0.14", "n")}${cell("F6", "5 min")}${cell("G6", "26 mi")}${cell("H6", "36 min")}${cell("I6", "4:40 PM")}${cell("J6", "4:50 PM")}</row>
<row r="7">${cell("A7", "Provo, UT &amp; Orem")}${cell("B7", "0.21", "n")}${cell("G7", "0 ft")}${cell("I7", "5:26 PM")}</row>
<row r="8">${cell("A8", "1 h 16 min")}${cell("D8", "$0.00")}${cell("F8", "5 min")}${cell("G8", "58 mi")}${cell("H8", "1 h 7 min")}</row>
</sheetData></worksheet>`;

test("parseSheetRows reads inline strings, numbers and entities", () => {
  const rows = parseSheetRows(SHEET_XML);
  assert.equal(rows[0].A, "ABRP Plan");
  assert.equal(rows[3].C, "0.26");
  assert.equal(rows[5].A, "Provo, UT & Orem");
});
test("parseAbrpRows extracts stops, charge time, per-leg drive time and clock times", () => {
  const plan = parseAbrpRows(parseSheetRows(SHEET_XML));
  assert.equal(plan.planUrl, "https://abetterrouteplanner.com/?plan_uuid=2-abc");
  assert.equal(plan.stops.length, 3);
  assert.deepEqual(plan.stops.map((s) => s.name), ["Point on map", "Tesla Supercharger Sandy, UT", "Provo, UT & Orem"]);
  assert.deepEqual(plan.stops.map((s) => s.chargeSeconds), [0, 300, 0]);
  assert.deepEqual(plan.stops.map((s) => s.driveSecondsToNext), [1860, 2160, null]);
  assert.equal(plan.stops[0].departureMin, 16 * 60 + 9);
  assert.equal(plan.stops[2].arrivalMin, 17 * 60 + 26);
  assert.equal(plan.totalDriveSeconds, 4020);
  assert.equal(plan.totalSeconds, 4560);
});

// Minimal zip writer for the test: one deflated entry, CRC left zero because
// the reader does not check it.
function zipWith(entries) {
  const parts = [];
  for (const [name, text] of entries) {
    const nameBytes = new TextEncoder().encode(name);
    const raw = new TextEncoder().encode(text);
    const comp = deflateRawSync(raw);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0, true); h.setUint16(8, 8, true);
    h.setUint32(18, comp.length, true); h.setUint32(22, raw.length, true); h.setUint16(26, nameBytes.length, true); h.setUint16(28, 0, true);
    parts.push(new Uint8Array(h.buffer), nameBytes, new Uint8Array(comp));
  }
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total + 22);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  new DataView(out.buffer).setUint32(o, 0x06054b50, true); // end of central directory marker
  return out.buffer;
}

await atest("readZipEntry inflates a deflated entry and parseAbrpXlsx reads the whole file", async () => {
  const buf = zipWith([["docProps/app.xml", "<x/>"], ["xl/worksheets/sheet1.xml", SHEET_XML]]);
  const xml = await readZipEntry(buf, "xl/worksheets/sheet1.xml");
  assert.ok(xml.includes("ABRP Plan"));
  const plan = await parseAbrpXlsx(buf);
  assert.equal(plan.stops[1].chargeSeconds, 300);
  await assert.rejects(() => readZipEntry(buf, "nope.xml"), /not found/);
});

test("applyDwell with per-leg scales stretches each leg by its own factor", () => {
  const places = [{ name: "A" }, { name: "S", dwellSeconds: 600 }, { name: "B" }];
  // leg 0: drive 0..100 over two segments; leg 1: 100..300 over two segments
  const pts = [{ t: 0, leg: 0 }, { t: 50, leg: 0 }, { t: 100, leg: 0 }, { t: 200, leg: 1 }, { t: 300, leg: 1 }];
  applyDwell(pts, places, [2, 0.5]);
  assert.deepEqual(pts.map((p) => p.t), [0, 100, 200, 200 + 50 + 600, 200 + 100 + 600]);
});

console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nall ${passed} tests passed`);
process.exit(failed ? 1 : 0);
