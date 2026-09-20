// The finder: (Route, Filters, Dataset) -> Candidate[]. Pure apart from the
// injected tile loader and detour router, so it can be driven from tests.
//
// Order of operations is the whole point:
//   1. tiles for the buffered route bbox
//   2. subtype filter          (cheapest, removes most of everything)
//   3. straight-line proximity (bucketed, not a scan)
//   4. ETA + arrival delta at the nearest vertex, apply time filters loosely
//   5. detour timing via the matrix endpoint, batched along the route,
//      only on survivors; full re-route as the fallback
//   6. exact arrival, delta, score, sort

import { bufferBbox, tilesForBbox, VertexBuckets } from "./geo.js";
import { dwellBefore } from "./routing.js";
import { meetingStartInstant } from "./tz.js";

export const IDEAL_EARLY = 12; // minutes before start

// Detour geometry. A stop is modelled as: leave the route at one vertex,
// drive to the building, rejoin at the same or a later vertex. Leg times
// come from the matrix endpoint, which uses the same road graph as a full
// route, so the only approximation is the choice of exit vertex. It can only
// make a detour look slightly longer than a free re-route would, never
// shorter. EXIT_SPAN_MI adds candidate exits that far before and after the
// nearest vertex; the cheapest pair wins. Every extra exit multiplies matrix
// pairs, and the public instance takes about 4 ms per pair, so 0 (nearest
// vertex only) is the speed setting and 4 is the accuracy setting.
export const EXIT_SPAN_MI = 0;
export const BATCH_BUILDINGS = 20;
export const BATCH_SPAN_MI = 60; // keeps every pair inside the 150 km matrix limit

export const DEFAULT_FILTERS = {
  subtypes: [],          // codes; empty = nothing selected -> prompt the user
  maxDetourMin: 30,
  windowMin: -60,        // minutes relative to start; negative = early
  windowMax: 10,
  wide: false,
  wideHours: 2,
  showFlagged: false,    // units with data-quality flags are hidden unless asked for
  sort: "best",          // best | arrival | earliest | distance
};

// How far off the route a building may sit before we skip even the coarse
// check. Derived from max detour: assume the detour is a round trip at a
// generous 45 mph, plus a floor so tiny detour settings still see anything.
export function detourRadiusMiles(maxDetourMin) {
  return Math.max(3, (maxDetourMin / 60) * 45 * 0.5);
}

export function score(c) {
  if (c.deltaMinutes === null) return Infinity;
  const early = -c.deltaMinutes;
  const latePenalty = c.deltaMinutes > 0 ? c.deltaMinutes * 6 : 0;
  const waitPenalty = Math.max(0, early - IDEAL_EARLY) * 0.5;
  const flagPenalty = c.unit.flags?.length ? 15 : 0;
  return (c.detourMinutes ?? 0) + latePenalty + waitPenalty + flagPenalty;
}

export function inWindow(delta, filters) {
  if (delta === null) return false;
  if (filters.wide) return Math.abs(delta) <= filters.wideHours * 60;
  return delta >= filters.windowMin && delta <= filters.windowMax;
}

export function sortCandidates(list, mode) {
  const arr = list.slice();
  if (mode === "arrival") {
    arr.sort((a, b) => {
      const la = a.deltaMinutes === null ? 2 : a.deltaMinutes > 0 ? 1 : 0;
      const lb = b.deltaMinutes === null ? 2 : b.deltaMinutes > 0 ? 1 : 0;
      if (la !== lb) return la - lb;
      return (a.deltaMinutes ?? 0) - (b.deltaMinutes ?? 0);
    });
  } else if (mode === "earliest") {
    // Earliest meeting start first; unknown times last; ties by how far off
    // the route the building sits.
    arr.sort((a, b) => {
      const ta = a.startInstant ? a.startInstant.getTime() : Infinity;
      const tb = b.startInstant ? b.startInstant.getTime() : Infinity;
      if (ta !== tb) return ta - tb;
      return (a.offRouteMiles ?? 0) - (b.offRouteMiles ?? 0);
    });
  } else if (mode === "distance") {
    arr.sort((a, b) => a.milesAlongRoute - b.milesAlongRoute);
  } else {
    arr.sort((a, b) => a.score - b.score);
  }
  return arr;
}

// Indices of the route vertices to try as exit/rejoin points for a building
// whose nearest vertex is `idx`: about EXIT_SPAN_MI before, the vertex
// itself, and about EXIT_SPAN_MI after. Deduplicated, in route order.
export function exitVertices(points, idx, spanMi = EXIT_SPAN_MI) {
  const d0 = points[idx].d;
  let before = idx;
  while (before > 0 && points[before].d > d0 - spanMi) before--;
  let after = idx;
  while (after < points.length - 1 && points[after].d < d0 + spanMi) after++;
  return [...new Set([before, idx, after])];
}

// Group buildings (already sorted by distance along the route) into batches
// that stay within BATCH_SPAN_MI of each other and BATCH_BUILDINGS in size.
export function batchAlongRoute(jobs) {
  const batches = [];
  let cur = [], start = 0;
  for (const j of jobs) {
    if (cur.length && (cur.length >= BATCH_BUILDINGS || j.milesAlongRoute - start > BATCH_SPAN_MI)) {
      batches.push(cur); cur = [];
    }
    if (!cur.length) start = j.milesAlongRoute;
    cur.push(j);
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/**
 * @param route      Route
 * @param filters    filters object (see DEFAULT_FILTERS)
 * @param deps       { loadTile(key) -> building[] | null,
 *                     matrix(sources, targets, {departure}) -> seconds[s][t] | null,
 *                     routeDetour(places, {departure}) -> { legSeconds, totalSeconds }  (fallback),
 *                     maxDetourBuildings, concurrency, onProgress(msg) }
 */
export async function findCandidates(route, filters, deps) {
  const { loadTile, matrix, routeDetour, onProgress = () => {} } = deps;
  const maxDetourBuildings = deps.maxDetourBuildings ?? 400;
  const concurrency = deps.concurrency ?? 2;
  const selected = new Set(filters.subtypes);
  const radiusMi = detourRadiusMiles(filters.maxDetourMin);

  // 1. tiles
  const keys = tilesForBbox(bufferBbox(route.bbox, radiusMi));
  onProgress(`Loading ${keys.length} tiles…`);
  const tiles = await Promise.all(keys.map((k) => loadTile(k)));
  const buildings = tiles.flat().filter(Boolean);

  // 2 + 3. subtype, then proximity
  const buckets = new VertexBuckets(route.points);
  const rough = [];
  for (const b of buildings) {
    const units = b.units.filter((u) => selected.has(u.subType));
    if (!units.length) continue;
    const near = buckets.nearest(b.lng, b.lat, radiusMi);
    if (near.index < 0) continue;
    const v = route.points[near.index];
    rough.push({ building: b, units, vertex: v, vertexIndex: near.index, offRouteMiles: near.miles });
  }
  onProgress(`${rough.length} buildings near the route`);

  // 4. pre-detour ETA and loose time screen. A detour only makes arrival later,
  // so anything already past the window's late edge cannot recover.
  const prelim = [];
  for (const r of rough) {
    const eta = new Date(route.departure.getTime() + r.vertex.t * 1000);
    for (const u of r.units) {
      if (u.flags?.length && !filters.showFlagged) continue;
      let delta = null, startInstant = null;
      if (u.start && !u.flags?.includes("no_start_time")) {
        startInstant = meetingStartInstant(eta, u.start, r.building.tz);
        delta = (eta - startInstant) / 60000;
      }
      const lateEdge = filters.wide ? filters.wideHours * 60 : filters.windowMax;
      const timeOk = delta === null ? false : delta <= lateEdge;
      prelim.push({
        unit: u, building: r.building,
        milesAlongRoute: r.vertex.d,
        offRouteMiles: r.offRouteMiles,
        etaAtNearestPoint: eta,
        startInstant, deltaMinutes: delta,
        detourMinutes: null, arrivalAtBuilding: eta,
        routed: false, passes: false, needsDetour: timeOk,
        legIndex: r.vertex.leg, vertexIndex: r.vertexIndex,
      });
    }
  }

  // 5. detour timing on survivors only. Spend the budget on units whose
  // pre-detour timing already sits near the window (a detour only pushes
  // arrival later), then on whatever is closest to the route.
  const lateEdge = filters.wide ? filters.wideHours * 60 : filters.windowMax;
  const earlyEdge = filters.wide ? -filters.wideHours * 60 : filters.windowMin;
  const promising = (c) => c.deltaMinutes !== null && c.deltaMinutes >= earlyEdge - 30 && c.deltaMinutes <= lateEdge;
  const toRoute = prelim
    .filter((c) => c.needsDetour)
    .sort((a, b) => (promising(b) - promising(a)) || (a.offRouteMiles - b.offRouteMiles));
  const byBuilding = new Map();
  for (const c of toRoute) {
    if (!byBuilding.has(c.building.id)) byBuilding.set(c.building.id, []);
    byBuilding.get(c.building.id).push(c);
  }
  const jobs = Array.from(byBuilding.values())
    .slice(0, maxDetourBuildings)
    .map((cands) => ({ cands, building: cands[0].building, milesAlongRoute: cands[0].milesAlongRoute, vertexIndex: cands[0].vertexIndex, legIndex: cands[0].legIndex }))
    .sort((a, b) => a.milesAlongRoute - b.milesAlongRoute);
  // route.timeScale != 1 when the user supplied a traffic-aware drive time;
  // route.legScales holds one factor per leg when an ABRP export supplied
  // per-leg times. Leg times come back unscaled and get the factor of the leg
  // the building sits on.
  const scaleFor = (legIndex) => (route.legScales ? (route.legScales[legIndex] ?? 1) : route.timeScale || 1);
  const scale = route.timeScale || 1;
  const pts = route.points;
  let done = 0;
  const total = jobs.length;

  // detourSec and toBuildingSec are unscaled driving seconds; extraSec is
  // clock time that is not driving (dwell at earlier stops) and is not scaled.
  const applyResult = (job, detourSec, toBuildingSec, exitIndex, extraSec = 0) => {
    const k = scaleFor(job.legIndex);
    for (const c of job.cands) {
      c.routed = true;
      c.detourMinutes = Math.max(0, (detourSec * k) / 60);
      c.arrivalAtBuilding = new Date(route.departure.getTime() + (pts[exitIndex].t + toBuildingSec * k + extraSec) * 1000);
      if (c.startInstant) c.deltaMinutes = (c.arrivalAtBuilding - c.startInstant) / 60000;
    }
  };

  // Full re-route for one building: the fallback when a matrix batch fails.
  const detourByRoute = async (job) => {
    if (!routeDetour) throw new Error("no route fallback");
    const places = route.places.slice();
    places.splice(job.legIndex + 1, 0, { name: job.building.name, lng: job.building.lng, lat: job.building.lat });
    const r = await routeDetour(places, { departure: route.departure });
    const toBuilding = r.legSeconds.slice(0, job.legIndex + 1).reduce((a, s) => a + s, 0);
    const driveSeconds = route.driveSeconds ?? route.totalSeconds / scale;
    // arrival = departure + drive to building + dwell at stops passed on the way.
    applyResult(job, r.totalSeconds - driveSeconds, toBuilding, 0, dwellBefore(route.places, job.legIndex));
  };

  const detourByMatrix = async (batch) => {
    const exits = batch.map((j) => exitVertices(pts, j.vertexIndex));
    const vertexIdx = [...new Set(exits.flat())];
    const col = new Map(vertexIdx.map((v, i) => [v, i]));
    const sources = vertexIdx.map((i) => pts[i]);
    const targets = batch.map((j) => j.building);
    const opts = { departure: route.departure };
    const [toB, fromB] = await Promise.all([matrix(sources, targets, opts), matrix(targets, sources, opts)]);
    batch.forEach((job, bi) => {
      let best = null;
      for (const i of exits[bi]) {
        for (const j of exits[bi]) {
          if (pts[j].t < pts[i].t) continue;
          const a = toB[col.get(i)][bi];
          const c = fromB[bi][col.get(j)];
          if (a == null || c == null) continue;
          const onRoute = (pts[j].t - pts[i].t) / scaleFor(job.legIndex);
          const det = a + c - onRoute;
          if (!best || det < best.det) best = { det, a, i };
        }
      }
      if (best) applyResult(job, best.det, best.a, best.i);
      else for (const c of job.cands) c.routeError = "unreachable";
    });
  };

  // Try a batch through the matrix; on failure split it, and at size one fall
  // back to a full re-route so a single odd building can't sink its batch.
  const runBatch = async (batch) => {
    try {
      await detourByMatrix(batch);
    } catch (e) {
      if (batch.length > 1) {
        const mid = Math.ceil(batch.length / 2);
        await runBatch(batch.slice(0, mid));
        await runBatch(batch.slice(mid));
        return;
      }
      try { await detourByRoute(batch[0]); }
      catch (e2) { for (const c of batch[0].cands) c.routeError = e2.message || String(e2); }
    }
    done += batch.length;
    // Hand back the partial result so the UI can fill in as batches land.
    for (const c of prelim) { c.passes = c.routed && c.detourMinutes <= filters.maxDetourMin && inWindow(c.deltaMinutes, filters); c.score = score(c); }
    onProgress(`Timing detours… ${Math.min(done, total)}/${total}`, prelim);
  };

  const queue = batchAlongRoute(jobs);
  const worker = async () => { while (queue.length) await runBatch(queue.shift()); };
  await Promise.all(Array.from({ length: concurrency }, worker));

  // 6. finalize
  for (const c of prelim) {
    c.passes = c.routed && c.detourMinutes <= filters.maxDetourMin && inWindow(c.deltaMinutes, filters);
    c.score = score(c);
  }
  return sortCandidates(prelim, filters.sort);
}

// Re-apply filters that don't need any routing (window, sort, restricted).
export function reapply(candidates, filters) {
  for (const c of candidates) {
    c.hidden = !filters.showFlagged && !!c.unit.flags?.length;
    c.passes = c.routed && c.detourMinutes <= filters.maxDetourMin && inWindow(c.deltaMinutes, filters);
    c.score = score(c);
  }
  return sortCandidates(candidates.filter((c) => !c.hidden), filters.sort);
}
