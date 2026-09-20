#!/usr/bin/env node
// Pure-logic tests for the app modules. No network, no DOM.
//   node test_app.mjs

import assert from "node:assert/strict";
import { decodePolyline, haversineMi, tileKey, tilesForBbox, bufferBbox, VertexBuckets } from "./js/geo.js";
import { meetingStartInstant, zonedToInstant, tzOffsetMinutes, parseDuration, defaultDepartureLocal } from "./js/tz.js";
import { score, inWindow, sortCandidates, detourRadiusMiles, findCandidates } from "./js/finder.js";
import { parseGoogleUrl, parseAppleUrl } from "./js/providers.js";

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
test("parseDuration accepts the common shapes", () => {
  assert.equal(parseDuration("5h 20m"), 19200);
  assert.equal(parseDuration("5:20"), 19200);
  assert.equal(parseDuration("320"), 19200);
  assert.equal(parseDuration("320 min"), 19200);
  assert.equal(parseDuration("5.5h"), 19800);
  assert.equal(parseDuration(""), null);
  assert.equal(parseDuration("soon"), null);
});
test("default departure is a Sunday at 08:00", () => {
  const v = defaultDepartureLocal(new Date(2026, 8, 20, 15, 0)); // a Sunday afternoon
  const d = new Date(v);
  assert.equal(d.getDay(), 0);
  assert.equal(d.getHours(), 8);
  assert.ok(d > new Date(2026, 8, 20, 15, 0), "must be the *next* Sunday");
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
test("detour radius has a floor and grows with the budget", () => {
  assert.equal(detourRadiusMiles(1), 3);
  assert.ok(detourRadiusMiles(60) > detourRadiusMiles(10));
});

await atest("findCandidates: full pipeline with a fake router and one tile", async () => {
  // A straight east-west route along lat 40 from -112 to -111, one hour long.
  const points = [];
  for (let i = 0; i <= 100; i++) points.push({ lng: -112 + i * 0.01, lat: 40, t: i * 36, d: i * 0.53, leg: 0 });
  const departure = new Date("2026-09-27T14:00:00Z"); // 08:00 MDT
  const route = {
    departure, points, bbox: [-112, 40, -111, 40], totalSeconds: 3600, totalMiles: 53,
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
    // Near, but starts at 08:00: already 30 min late at the nearest point, never routed.
    building("late", -111.5, 40.01, [{ id: "u4", name: "Late YSA", subType: "YSA", start: "08:00" }]),
    // No published time.
    building("notime", -111.5, 40.01, [{ id: "u5", name: "Unknown YSA", subType: "YSA", start: null, flags: ["no_start_time"] }]),
  ];
  const routed = [];
  const deps = {
    loadTile: async (key) => (key === "w112_n40" ? tile : null),
    routeDetour: async (places) => { routed.push(places[1].name); return { legSeconds: [1830, 1830], totalSeconds: 3660 }; },
    maxDetourCalls: 10, concurrency: 1,
  };
  const out = await findCandidates(route, { subtypes: ["YSA"], maxDetourMin: 10, windowMin: -15, windowMax: 2, wide: false, wideHours: 2, hideRestricted: true, sort: "best" }, deps);
  assert.deepEqual(routed, ["mid"], "only the promising candidate gets a routing call");
  const ids = out.map((c) => c.unit.id);
  assert.ok(ids.includes("u1") && ids.includes("u4") && ids.includes("u5") && !ids.includes("u2") && !ids.includes("u3"), ids.join(","));
  const mid = out.find((c) => c.unit.id === "u1");
  assert.equal(mid.passes, true);
  assert.equal(Math.round(mid.detourMinutes), 1);
  // arrival = 08:00 + 1830 s = 08:30:30; start 08:45 -> 14.5 min early
  assert.ok(Math.abs(mid.deltaMinutes + 14.5) < 0.01, String(mid.deltaMinutes));
  assert.equal(out[0].unit.id, "u1", "best fit sorts first");
  assert.equal(out.find((c) => c.unit.id === "u4").passes, false);
  assert.equal(out.find((c) => c.unit.id === "u5").deltaMinutes, null);
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
test("Apple Maps link parses saddr and daddr", () => {
  const p = parseAppleUrl("https://maps.apple.com/?saddr=Salt+Lake+City&daddr=37.1,-113.58&dirflg=d");
  assert.equal(p[0].query, "Salt Lake City");
  assert.ok(Math.abs(p[1].lat - 37.1) < 1e-9);
});

console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nall ${passed} tests passed`);
process.exit(failed ? 1 : 0);
