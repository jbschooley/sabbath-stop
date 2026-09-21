#!/usr/bin/env node
// Pure-logic tests for the app modules. No network, no DOM.
//   node test_app.mjs

import assert from "node:assert/strict";
import { decodePolyline, haversineMi, tileKey, tilesForBbox, bufferBbox, VertexBuckets } from "./js/geo.js";
import { meetingStartInstant, zonedToInstant, tzOffsetMinutes, defaultDepartureLocal, weekdayIn, wallClockValue, instantFromWallClock, tzAbbrev, generalConferenceDays, isGeneralConference } from "./js/tz.js";
import { score, inWindow, sortCandidates, detourRadiusMiles, findCandidates, exitVertices, batchAlongRoute, DEFAULT_FILTERS, leaveBy, reapply } from "./js/finder.js";
import { dwellBefore, applyDwell } from "./js/routing.js";
import { parseAbrpXlsx, parseAbrpRows, parseSheetRows, parseAbrpDuration, parseClock, cleanStopName, stopNameDetail, isUnresolvableName, readZipEntry } from "./js/abrp.js";
import { deflateRawSync } from "node:zlib";
import { inputsKey, serializePlan, revivePlan, shiftPlan, savePlan, loadPlan, planStore } from "./js/plan.js";
import { encodeShare, decodeShare, sharePayloadFrom, shareUrl } from "./js/share.js";
import { rankSuggestions, label, pickByAddress } from "./js/geocode.js";
import { parseGoogleUrl, parseAppleUrl, parseGoogleDeparture, parseLink, defaultDwellMinutes, googleWaypointCoords } from "./js/providers.js";

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
test("weekdayIn: the weekday depends on the zone near midnight", () => {
  const inst = new Date("2026-09-27T05:30:00Z"); // Sunday 05:30Z
  assert.equal(weekdayIn(inst, "UTC"), "SUNDAY");
  assert.equal(weekdayIn(inst, "America/Denver"), "SATURDAY"); // 23:30 MDT the night before
  assert.equal(weekdayIn(inst, "Asia/Dubai"), "SUNDAY");
});
test("a picker value is read in the origin's zone: 8:00 in California is 15:00Z", () => {
  assert.equal(instantFromWallClock("2026-09-27T08:00", "America/Los_Angeles").toISOString(), "2026-09-27T15:00:00.000Z");
  assert.equal(instantFromWallClock("2026-09-27T08:00", "America/Denver").toISOString(), "2026-09-27T14:00:00.000Z");
  assert.equal(instantFromWallClock("nonsense", "America/Denver"), null);
  assert.equal(wallClockValue(new Date("2026-09-27T15:00:00Z"), "America/Los_Angeles"), "2026-09-27T08:00");
});
test("tzAbbrev prefers a real abbreviation over a bare offset where one exists", () => {
  const d = new Date("2026-09-27T12:00:00Z");
  assert.equal(tzAbbrev(d, "America/Denver"), "MDT");
  assert.equal(tzAbbrev(d, "Europe/Berlin"), "CEST");
  assert.equal(tzAbbrev(d, "Australia/Sydney"), "AEST");
  assert.match(tzAbbrev(d, "Pacific/Tongatapu"), /^GMT\+13$/); // no English abbreviation exists
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
test("default departure: on a Sunday it is the current minute, not rounded", () => {
  // 2026-09-20 is a Sunday.
  assert.equal(defaultDepartureLocal(new Date(2026, 8, 20, 15, 3, 40)), "2026-09-20T15:03");
  assert.equal(defaultDepartureLocal(new Date(2026, 8, 20, 15, 0, 0)), "2026-09-20T15:00");
  assert.equal(defaultDepartureLocal(new Date(2026, 8, 20, 23, 58, 0)), "2026-09-20T23:58");
});
test("default departure: on any other day it is 8:00 AM next Sunday", () => {
  assert.equal(defaultDepartureLocal(new Date(2026, 8, 21, 9, 0)), "2026-09-27T08:00");  // Monday
  assert.equal(defaultDepartureLocal(new Date(2026, 8, 26, 23, 30)), "2026-09-27T08:00"); // Saturday night
  assert.equal(defaultDepartureLocal(new Date(2026, 8, 23, 0, 0)), "2026-09-27T08:00");  // Wednesday
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

test("leaveBy: departure that lands aimMin before the start, using the routed arrival", () => {
  const departure = new Date("2026-09-27T14:00:00Z");
  const c = {
    routed: true, etaAtNearestPoint: new Date("2026-09-27T14:30:00Z"), arrivalAtBuilding: new Date("2026-09-27T14:34:00Z"),
    startInstant: new Date("2026-09-27T14:45:00Z"),
  };
  const lb = leaveBy(c, departure, 5);
  // travel is 34 min; start 08:45 MDT; aim 08:40 -> leave 08:06 MDT = 14:06Z
  assert.equal(lb.toISOString(), "2026-09-27T14:06:00.000Z");
  assert.equal(new Date(lb.getTime() + 34 * 60000 + 5 * 60000).getTime(), c.startInstant.getTime(), "leave + travel + aim = start");
  // unrouted: the nearest-point time stands in
  assert.equal(leaveBy({ ...c, routed: false }, departure, 0).toISOString(), "2026-09-27T14:15:00.000Z");
  assert.equal(leaveBy({ ...c, startInstant: null }, departure, 5), null);
  assert.equal(leaveBy(c, null, 5), null);
});

test("reapply fills leaveBy and the 'leave' sort puts the latest departure first", () => {
  const departure = new Date("2026-09-27T14:00:00Z");
  const mk = (id, travelMin, startZ, routed = true) => ({
    unit: { id, name: id }, routed, detourMinutes: 3, deltaMinutes: -5, offRouteMiles: 1, milesAlongRoute: 10,
    etaAtNearestPoint: new Date(departure.getTime() + travelMin * 60000), arrivalAtBuilding: new Date(departure.getTime() + travelMin * 60000),
    startInstant: new Date(startZ),
  });
  const near = mk("near", 30, "2026-09-27T15:00:00Z");   // 09:00, 30 min away -> leave 08:25
  const far = mk("far", 120, "2026-09-27T17:00:00Z");    // 11:00, 2 h away    -> leave 08:55
  const none = { ...mk("none", 10, "2026-09-27T15:00:00Z"), startInstant: null };
  const filters = { ...DEFAULT_FILTERS, sort: "leave", aimMin: 5, maxDetourMin: 30, windowMin: -60, windowMax: 10 };
  const out = reapply([near, none, far], filters, departure);
  assert.deepEqual(out.map((c) => c.unit.id), ["far", "near", "none"]);
  assert.equal(far.leaveBy.toISOString(), "2026-09-27T14:55:00.000Z");
  assert.equal(near.leaveByApprox, false);
  assert.equal(none.leaveBy, null);
});

await atest("findCandidates: the language filter is independent of the unit type", async () => {
  const { route, tile, filters } = fixture();
  tile[0].units[0].lang = "nv"; // a YSA unit meeting in Navajo
  tile[3].units[0].lang = "en";
  const deps = { loadTile: async (key) => (key === "w112_n40" ? tile : null), matrix: fakeMatrix, concurrency: 1 };
  const any = await findCandidates(route, filters, deps);
  assert.ok(any.some((c) => c.unit.id === "u1") && any.some((c) => c.unit.id === "u4"), "empty = any language");
  const navajo = await findCandidates(route, { ...filters, langs: ["nv"] }, deps);
  assert.deepEqual(navajo.map((c) => c.unit.id), ["u1"]);
  const english = await findCandidates(route, { ...filters, langs: ["en", "es"] }, deps);
  assert.deepEqual(english.map((c) => c.unit.id), ["u4"]);
});

await atest("findCandidates: arriving on a day the unit doesn't meet is not a fit", async () => {
  const { route, tile, filters } = fixture();
  route.departure = new Date("2026-09-23T14:00:00Z"); // a Wednesday
  const out = await findCandidates(route, { ...filters, windowMin: -600, windowMax: 600 }, { loadTile: async () => tile, matrix: fakeMatrix, concurrency: 1 });
  const mid = out.find((c) => c.unit.id === "u1");
  assert.equal(mid.wrongDay, true);
  assert.equal(mid.passes, false);
  assert.equal(mid.deltaMinutes, null);
  assert.equal(mid.routed, false, "no routing budget spent on it");
});
await atest("findCandidates: a unit that meets on Friday fits a Friday arrival", async () => {
  const { route, tile, filters } = fixture();
  tile[0].units[0].day = "FRIDAY";
  route.departure = new Date("2026-09-25T14:00:00Z"); // a Friday
  const out = await findCandidates(route, filters, { loadTile: async () => tile, matrix: fakeMatrix, concurrency: 1 });
  const mid = out.find((c) => c.unit.id === "u1");
  assert.equal(mid.wrongDay, false);
  assert.equal(mid.passes, true);
});

// The real shape of the Gulf: Doha's wards meet on Friday, and the weekday
// must be judged in Asia/Qatar, not the traveller's zone.
function qatarFixture(departure) {
  const points = [];
  for (let i = 0; i <= 100; i++) points.push({ lng: 51 + i * 0.01, lat: 25.33, t: i * 36, d: i * 0.39, leg: 0 });
  const route = {
    departure, points, bbox: [51, 25.33, 52, 25.33], driveSeconds: 3600, dwellSeconds: 0, totalSeconds: 3600, timeScale: 1, totalMiles: 39,
    places: [{ name: "Al Wakrah", lng: 51, lat: 25.33 }, { name: "Al Khor", lng: 52, lat: 25.33 }], legSeconds: [3600],
  };
  const tile = [{
    id: "doha", name: "Doha 1, 2", lng: 51.52, lat: 25.34, tz: "Asia/Qatar", city: "Doha", state: "", units: [
      { id: "d2", name: "Doha 2nd Ward", subType: "CONVENTIONAL", day: "FRIDAY", start: "09:00" },
      { id: "d1", name: "Doha 1st Ward", subType: "CONVENTIONAL", day: "FRIDAY", start: "13:00" },
    ],
  }];
  const filters = { subtypes: ["CONVENTIONAL"], maxDetourMin: 30, windowMin: -60, windowMax: 10, wide: false, wideHours: 2, showFlagged: false, sort: "best" };
  const deps = { loadTile: async (key) => (key === "e51_n25" ? tile : null), matrix: fakeMatrix, concurrency: 1 };
  return { route, filters, deps };
}
await atest("Friday meetings in Qatar fit a Friday drive, judged in the building's zone", async () => {
  // 05:00Z is 08:00 in Doha on Friday 2026-09-25; the 09:00 ward is ~30 min ahead at the halfway point.
  const { route, filters, deps } = qatarFixture(new Date("2026-09-25T05:00:00Z"));
  const out = await findCandidates(route, filters, deps);
  const d2 = out.find((c) => c.unit.id === "d2"), d1 = out.find((c) => c.unit.id === "d1");
  assert.equal(d2.wrongDay, false);
  assert.equal(d2.meetsOn, "FRIDAY");
  assert.ok(d2.deltaMinutes < -20 && d2.deltaMinutes > -40, String(d2.deltaMinutes));
  assert.equal(d2.passes, true);
  assert.equal(d1.wrongDay, false);
  assert.equal(d1.passes, false, "13:00 is four hours off");
});
await atest("a Sunday drive through Qatar finds no meeting", async () => {
  const { route, filters, deps } = qatarFixture(new Date("2026-09-27T05:00:00Z"));
  const out = await findCandidates(route, filters, deps);
  assert.ok(out.length >= 2);
  assert.ok(out.every((c) => c.wrongDay && !c.passes && c.deltaMinutes === null));
});
await atest("the weekday flips at Doha's midnight, not the traveller's", async () => {
  // 21:30Z Friday is 00:30 Saturday in Doha: no meeting, even though it is
  // still Friday afternoon in Utah.
  const { route, filters, deps } = qatarFixture(new Date("2026-09-25T21:30:00Z"));
  const out = await findCandidates(route, filters, deps);
  assert.ok(out.every((c) => c.wrongDay));
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

await atest("findCandidates: a 'too far apart' matrix refusal splits down to a full re-route", async () => {
  const { route, tile, filters } = fixture();
  const routed = [];
  let matrixCalls = 0;
  const deps = {
    loadTile: async () => tile,
    matrix: async () => { matrixCalls++; throw new Error("Path distance exceeds the max distance limit"); },
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

await atest("findCandidates: a busy provider is retried once, not fanned out", async () => {
  const { route, tile, filters } = fixture();
  let matrixCalls = 0, routeCalls = 0;
  const deps = {
    loadTile: async () => tile,
    matrix: async () => { matrixCalls++; throw new Error("HTTP 503"); },
    routeDetour: async () => { routeCalls++; throw new Error("HTTP 503"); },
    concurrency: 1,
  };
  const out = await findCandidates(route, filters, deps);
  const mid = out.find((c) => c.unit.id === "u1");
  assert.equal(mid.routed, false);
  assert.match(mid.routeError, /503/);
  // Each attempt issues two matrix calls (vertex->building and building->vertex).
  assert.equal(matrixCalls, 4, "one retry after a pause, two calls per attempt");
  assert.equal(routeCalls, 1, "single-building batch gets one route attempt");
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
    matrix: async () => { throw new Error("Path distance exceeds the max distance limit"); },
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

test("general conference is the first Sunday of April and October plus the Saturday before", () => {
  assert.deepEqual(generalConferenceDays(2026), ["2026-04-04", "2026-04-05", "2026-10-03", "2026-10-04"]);
  assert.deepEqual(generalConferenceDays(2023), ["2023-04-01", "2023-04-02", "2023-09-30", "2023-10-01"]); // October 1 was a Sunday
  assert.deepEqual(generalConferenceDays(2027), ["2027-04-03", "2027-04-04", "2027-10-02", "2027-10-03"]);
  assert.equal(isGeneralConference("2026-10-04"), true);
  assert.equal(isGeneralConference("2026-10-03"), true);
  assert.equal(isGeneralConference("2026-10-11"), false);
  assert.equal(isGeneralConference("2026-09-27"), false);
  assert.equal(isGeneralConference(""), false);
});

test("geocoder label carries the street line so two branches in one city differ", () => {
  assert.equal(label({ name: "Costa Vida", housenumber: "801", street: "West Main Street", city: "Boise", state: "Idaho", country: "United States" }), "Costa Vida, 801 West Main Street, Boise, Idaho");
  assert.equal(label({ name: "Boise", city: "Boise", state: "Idaho", country: "United States" }), "Boise, Idaho");
  assert.equal(label({ name: "Munich", state: "Bavaria", country: "Germany" }), "Munich, Bavaria, Germany");
});

test("Google link: a searched place takes its coordinates from the data blob", () => {
  const u = "https://www.google.com/maps/dir/40.2969000,-111.6946000/Costa+Vida+Fresh+Mexican+Grill,+801+W+Main+St+Suite+101,+Boise,+ID+83702/@41.9,-116.6,998718m/data=!3m2!1e3!4b1!4m10!4m9!1m1!4e1!1m5!1m1!1s0x54aef8e4f1c19337:0xadcc49a814305482!2m2!1d-116.2038058!2d43.6154801!3e0?entry=ttu";
  assert.deepEqual(googleWaypointCoords(u), [null, { lng: -116.2038058, lat: 43.6154801 }]);
  const p = parseGoogleUrl(u);
  assert.equal(p.length, 2);
  assert.ok(Math.abs(p[0].lat - 40.2969) < 1e-6);
  assert.equal(p[1].lng, -116.2038058);
  assert.equal(p[1].lat, 43.6154801);
  assert.match(p[1].name, /Costa Vida/);
  // Two typed places and no blob: nothing to attach, names still geocode.
  assert.deepEqual(googleWaypointCoords("https://www.google.com/maps/dir/A/B/"), []);
  assert.equal("lng" in parseGoogleUrl("https://www.google.com/maps/dir/Provo,+UT/Boise,+ID/")[1], false);
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
  // The street fragment after the state sent Photon to a different charger 90 miles away.
  assert.equal(cleanStopName("Tesla Supercharger Beaver, UT - 525 W [Tesla]"), "Tesla Supercharger Beaver, UT");
  assert.equal(cleanStopName("Tesla Supercharger Yermo, CA - Sunrise Canyon Rd [Tesla]"), "Tesla Supercharger Yermo, CA");
  assert.equal(cleanStopName("Tesla Supercharger Moapa, NV [Tesla]"), "Tesla Supercharger Moapa, NV");
  assert.equal(cleanStopName("1924 Colina Salida del Sol, San Clemente, CA"), "1924 Colina Salida del Sol, San Clemente, CA");
  assert.equal(stopNameDetail("Tesla Supercharger Beaver, UT - 525 W [Tesla]"), "525 W");
  assert.equal(stopNameDetail("Tesla Supercharger Yermo, CA - Sunrise Canyon Rd [Tesla]"), "Sunrise Canyon Rd");
  assert.equal(stopNameDetail("Tesla Supercharger Moapa, NV [Tesla]"), null);
});

test("pickByAddress chooses among a city's chargers by ABRP's street fragment", () => {
  // Photon's real answers for "Tesla Supercharger Las Vegas, NV" and Barstow.
  const lv = [
    "Tesla Supercharger, 6509 South Las Vegas Boulevard, Las Vegas, Nevada",
    "Tesla Supercharger, 3545 South Las Vegas Boulevard, Paradise, Nevada",
    "Tesla Supercharger, 7860 West Tropical Parkway, Las Vegas, Nevada",
    "Tesla Supercharger, 2208 South Nellis Boulevard, Las Vegas, Nevada",
    "Tesla Supercharger, 500 East Windmill Lane, Las Vegas, Nevada",
  ].map((name) => ({ name, kind: "amenity:charging_station" }));
  assert.equal(pickByAddress("Tropical Pkwy", lv).name, lv[2].name);
  assert.equal(pickByAddress("3545 S Las Vegas Blvd", lv).name, lv[1].name, "house number beats the shared street words");
  assert.equal(pickByAddress("Nellis", lv).name, lv[3].name);
  assert.equal(pickByAddress("Windmill Ln", lv).name, lv[4].name);
  assert.equal(pickByAddress("Some Unknown Rd", lv).name, lv[0].name, "no match: first hit");
  assert.equal(pickByAddress(null, lv).name, lv[0].name);
  assert.equal(pickByAddress("x", []), null);
  const barstow = [
    "Tesla Supercharger, 1503 East Main Street, Barstow, California",
    "Tesla Supercharger, 2812 Lenwood Road, Barstow, California",
    "Tesla Supercharger - Barstow, CA - Tanger Way, 2796 Tanger Way, Barstow, California",
  ].map((name) => ({ name, kind: "amenity:charging_station" }));
  assert.equal(pickByAddress("Lenwood Rd", barstow).name, barstow[1].name);
  assert.equal(pickByAddress("Tanger Way", barstow).name, barstow[2].name);
  // The same scorer serves a restaurant address: Boise's McDonald's, as Photon lists them.
  const mcd = ["6190 South Five Mile Road", "6574 South Federal Way", "2510 West Fairview Avenue", "1375 South Broadway Avenue", "1185 South Vista Avenue", "9804 West Fairview Avenue", "7222 West Overland Road", "7811 West Fairview Avenue"]
    .map((a) => ({ name: `McDonald's, ${a}, Boise, Idaho`, kind: "amenity:fast_food" }));
  assert.equal(pickByAddress(" 1185 S Vista Ave, Boise, ID", mcd).name, mcd[4].name);
  assert.equal(pickByAddress(" 7811 W Fairview Ave, Boise, ID", mcd).name, mcd[7].name, "house number picks among three on Fairview");
  assert.equal(pickByAddress(" Overland Rd, Boise", mcd).name, mcd[6].name);
  assert.equal(pickByAddress(" Boise, ID", mcd).name, mcd[0].name, "city alone matches all equally: first hit");
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
  // Sandy: arrive 4:40, depart 4:50 -> the clock gap (10 min) beats the 5-min charge figure.
  assert.deepEqual(plan.stops.map((s) => s.dwellSeconds), [0, 600, 0]);
  assert.deepEqual(plan.stops.map((s) => s.driveSecondsToNext), [1860, 2160, null]);
  assert.equal(plan.stops[0].departureMin, 16 * 60 + 9);
  assert.equal(plan.stops[2].arrivalMin, 17 * 60 + 26);
  assert.equal(plan.totalDriveSeconds, 4020);
  assert.equal(plan.totalSeconds, 4560);
  assert.equal(plan.totalMiles, 58);
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

console.log("geocode");
test("rankSuggestions puts the city named Istanbul above a restaurant and a village of that name", () => {
  const photonOrder = [
    { name: "Istanbul, Sokolov, Karlovy Vary Region, Czechia", kind: "amenity:fast_food" },
    { name: "Istanbul, Germany", kind: "amenity:restaurant" },
    { name: "Istanbul, Turkey", kind: "place:city" },
    { name: "Istanbul, Turkey", kind: "place:province" },
  ];
  const ranked = rankSuggestions("Istanbul", photonOrder);
  assert.equal(ranked[0].kind, "place:city");
  // The rest tie on score, so Photon's order is kept: fast food, restaurant, province.
  assert.deepEqual(ranked.slice(1).map((p) => p.kind), ["amenity:fast_food", "amenity:restaurant", "place:province"]);
});
test("rankSuggestions: exact name beats prefix, town beats village, order otherwise kept", () => {
  const list = [
    { name: "Springfield Township, Ohio", kind: "boundary:administrative" },
    { name: "Springfield, Illinois", kind: "place:city" },
    { name: "Springfield, Vermont", kind: "place:village" },
    { name: "Springfield, Missouri", kind: "place:city" },
  ];
  const r = rankSuggestions("Springfield", list).map((p) => p.name);
  // Cities first in Photon's order; an exact-name village beats a prefix-match township.
  assert.deepEqual(r, ["Springfield, Illinois", "Springfield, Missouri", "Springfield, Vermont", "Springfield Township, Ohio"]);
});

console.log("share");
test("share links round-trip a plan, including non-ASCII names, and drop empties", () => {
  const plan = {
    departure: "2026-09-27T08:00",
    route: { originText: "München, Bayern", origin: { name: "München", lng: 11.575, lat: 48.137 }, destinationText: "", waypoints: [{ text: "Tesla Supercharger Beaver, UT", dwellMin: "15" }] },
    filters: { subtypes: ["YSA", "YSA_JR"], langs: ["es"], maxDetourMin: 30, wide: false, sort: "best" },
  };
  const url = shareUrl("https://sabbathstop.com/", plan);
  assert.ok(url.startsWith("https://sabbathstop.com/#s="));
  assert.doesNotMatch(url.split("#s=")[1], /[+/=]/, "base64url only, safe in chat and address bars");
  const back = decodeShare(sharePayloadFrom(new URL(url).hash));
  assert.equal(back.departure, "2026-09-27T08:00");
  assert.equal(back.route.originText, "München, Bayern");
  assert.equal(back.route.origin.lng, 11.575);
  assert.equal(back.route.waypoints[0].dwellMin, "15");
  assert.deepEqual(back.filters.subtypes, ["YSA", "YSA_JR"]);
  assert.deepEqual(back.filters.langs, ["es"]);
  assert.equal("destinationText" in back.route, false, "empty strings are dropped");
  assert.equal("wide" in back.filters, false, "false is dropped and comes back as the default");
});
test("share: bad or missing fragments are rejected cleanly", () => {
  assert.equal(sharePayloadFrom(""), null);
  assert.equal(sharePayloadFrom("#other"), null);
  assert.throws(() => decodeShare(encodeShare({ v: 99 }).replace(/./, "A")), Error);
});


// ---------------------------------------------------------------- saved plan

console.log("plan");
function samplePlan() {
  const departure = new Date("2026-09-27T14:00:00Z"); // 08:00 MDT Sunday
  const route = {
    departure, points: [{ lng: -112, lat: 40, t: 0, d: 0, leg: 0 }, { lng: -111.5, lat: 40.001234567, t: 1800.04, d: 26.5, leg: 0 }],
    places: [{ name: "A", lng: -112, lat: 40 }, { name: "B", lng: -111, lat: 40 }], legSeconds: [3600], totalSeconds: 3600, driveSeconds: 3600, dwellSeconds: 0, totalMiles: 53, provider: "valhalla",
  };
  const building = { id: "b", name: "Mid", lng: -111.5, lat: 40.01, tz: "America/Denver", city: "X", state: "UT" };
  const eta = new Date(departure.getTime() + 1800 * 1000); // 08:30
  const c = (id, start, extra = {}) => ({
    unit: { id, name: id, subType: "YSA", start, day: "SUNDAY" }, building, milesAlongRoute: 26.5, offRouteMiles: 0.7,
    etaAtNearestPoint: eta, startInstant: new Date(`2026-09-27T${start}:00-06:00`), meetsOn: "SUNDAY", wrongDay: false,
    deltaMinutes: null, detourMinutes: 4, arrivalAtBuilding: new Date(eta.getTime() + 2 * 60000), routed: true, passes: true, needsDetour: true, legIndex: 0, vertexIndex: 1, ...extra,
  });
  const candidates = [c("u1", "08:45"), c("u2", "13:00")];
  for (const x of candidates) x.deltaMinutes = (x.arrivalAtBuilding - x.startInstant) / 60000;
  return { route, candidates, zones: ["America/Denver", "America/Denver"], inputsKey: "k", savedAt: 1 };
}

test("inputsKey ignores typed text and ids, keys on places, dwell and the drive-time override", () => {
  const a = { stops: [{ id: "x", text: "Provo", place: { lng: -111.65871, lat: 40.23373 }, dwellMin: 0 }, { id: "y", text: "Boise, Idaho", place: { lng: -116.2, lat: 43.6 }, dwellMin: 0 }], trafficH: "", trafficM: "" };
  const b = { stops: [{ id: "q", text: "Provo, Utah", place: { lng: -111.658712, lat: 40.233731 }, dwellMin: 0 }, { id: "r", text: "Boise", place: { lng: -116.2, lat: 43.6 }, dwellMin: 0 }], trafficH: "", trafficM: "" };
  assert.equal(inputsKey(a), inputsKey(b));
  assert.notEqual(inputsKey(a), inputsKey({ ...a, trafficH: "5" }));
  assert.notEqual(inputsKey(a), inputsKey({ ...a, stops: [a.stops[0], { ...a.stops[1], dwellMin: 20 }] }));
});

test("a plan survives JSON with its dates and route points intact", () => {
  const plan = samplePlan();
  const back = revivePlan(JSON.parse(JSON.stringify(serializePlan(plan))));
  assert.equal(back.route.departure.getTime(), plan.route.departure.getTime());
  assert.equal(back.route.points.length, 2);
  assert.equal(back.route.points[1].lat, 40.00123);
  assert.equal(back.route.points[1].t, 1800);
  assert.equal(back.candidates[0].arrivalAtBuilding.getTime(), plan.candidates[0].arrivalAtBuilding.getTime());
  assert.equal(back.candidates[0].startInstant.getTime(), plan.candidates[0].startInstant.getTime());
  assert.equal(back.candidates[0].building.tz, "America/Denver");
  assert.equal(revivePlan({ v: 99 }), null);
  assert.equal(revivePlan(null), null);
});

test("shifting a plan 40 minutes later moves every arrival and delta by 40 minutes", () => {
  const plan = samplePlan();
  const later = new Date(plan.route.departure.getTime() + 40 * 60000);
  const out = shiftPlan(plan, later);
  assert.equal(out.route.departure.getTime(), later.getTime());
  assert.equal(out.candidates[0].arrivalAtBuilding.getTime(), plan.candidates[0].arrivalAtBuilding.getTime() + 40 * 60000);
  assert.ok(Math.abs(out.candidates[0].deltaMinutes - (plan.candidates[0].deltaMinutes + 40)) < 1e-9);
  assert.equal(out.candidates[0].startInstant.getTime(), plan.candidates[0].startInstant.getTime(), "same meeting, same day");
  assert.equal(out.candidates[0].wrongDay, false);
  // The original is untouched.
  assert.equal(plan.candidates[0].arrivalAtBuilding.getTime(), plan.candidates[0].startInstant.getTime() + plan.candidates[0].deltaMinutes * 60000);
});

test("shifting a plan onto Monday finds no meeting; onto next Sunday finds it again", () => {
  const plan = samplePlan();
  const monday = shiftPlan(plan, new Date(plan.route.departure.getTime() + 24 * 3600 * 1000));
  assert.ok(monday.candidates.every((c) => c.wrongDay && c.deltaMinutes === null && c.startInstant === null));
  const nextSunday = shiftPlan(plan, new Date(plan.route.departure.getTime() + 7 * 24 * 3600 * 1000));
  assert.ok(nextSunday.candidates.every((c) => !c.wrongDay));
  assert.equal(nextSunday.candidates[0].startInstant.getTime(), plan.candidates[0].startInstant.getTime() + 7 * 24 * 3600 * 1000);
  assert.ok(Math.abs(nextSunday.candidates[0].deltaMinutes - plan.candidates[0].deltaMinutes) < 1e-9);
});

test("an unrouted candidate's delta shifts from its nearest-point time", () => {
  const plan = samplePlan();
  plan.candidates[0].routed = false;
  plan.candidates[0].deltaMinutes = (plan.candidates[0].etaAtNearestPoint - plan.candidates[0].startInstant) / 60000;
  const out = shiftPlan(plan, new Date(plan.route.departure.getTime() + 10 * 60000));
  assert.ok(Math.abs(out.candidates[0].deltaMinutes - (plan.candidates[0].deltaMinutes + 10)) < 1e-9);
});

await atest("savePlan and loadPlan round-trip through a store and tolerate a full one", async () => {
  let text = null;
  const store = { get: async () => text, set: async (t) => { text = t; } };
  assert.equal(await savePlan(store, samplePlan()), true);
  const back = await loadPlan(store);
  assert.equal(back.candidates.length, 2);
  assert.equal(back.candidates[1].building, back.candidates[0].building, "one building object shared by its units");
  assert.equal("units" in back.candidates[0].building, false);
  const origWarn = console.warn; console.warn = () => {};
  try {
    const full = { get: async () => null, set: async () => { throw new Error("QuotaExceededError"); } };
    assert.equal(await savePlan(full, samplePlan()), false);
    assert.equal(await loadPlan(full), null);
  } finally { console.warn = origWarn; }
});

test("planStore prefers the Cache API and falls back to localStorage", () => {
  const ls = { getItem: () => "x", setItem: () => {} };
  assert.ok(planStore({ localStorage: ls }).get);
  assert.ok(planStore({ caches: { open: async () => ({}) }, localStorage: ls }).set);
});

console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nall ${passed} tests passed`);
process.exit(failed ? 1 : 0);
