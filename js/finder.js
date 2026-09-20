// The finder: (Route, Filters, Dataset) -> Candidate[]. Pure apart from the
// injected tile loader and detour router, so it can be driven from tests.
//
// Order of operations is the whole point:
//   1. tiles for the buffered route bbox
//   2. subtype filter          (cheapest, removes most of everything)
//   3. straight-line proximity (bucketed, not a scan)
//   4. ETA + arrival delta at the nearest vertex, apply time filters loosely
//   5. detour routing          (one network call each -- only on survivors)
//   6. exact arrival, delta, score, sort

import { bufferBbox, tilesForBbox, VertexBuckets } from "./geo.js";
import { meetingStartInstant } from "./tz.js";

export const IDEAL_EARLY = 12; // minutes before start

export const DEFAULT_FILTERS = {
  subtypes: [],          // codes; empty = nothing selected -> prompt the user
  maxDetourMin: 10,
  windowMin: -15,        // minutes relative to start; negative = early
  windowMax: 2,
  wide: false,
  wideHours: 2,
  hideRestricted: true,
  sort: "best",          // best | arrival | distance
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
  } else if (mode === "distance") {
    arr.sort((a, b) => a.milesAlongRoute - b.milesAlongRoute);
  } else {
    arr.sort((a, b) => a.score - b.score);
  }
  return arr;
}

/**
 * @param route      Route
 * @param filters    filters object (see DEFAULT_FILTERS)
 * @param deps       { loadTile(key) -> building[] | null,
 *                     routeDetour(places) -> { legSeconds, totalSeconds },
 *                     maxDetourCalls, concurrency, onProgress(msg) }
 */
export async function findCandidates(route, filters, deps) {
  const { loadTile, routeDetour, onProgress = () => {} } = deps;
  const maxDetourCalls = deps.maxDetourCalls ?? 40;
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
    rough.push({ building: b, units, vertex: v, offRouteMiles: near.miles });
  }
  onProgress(`${rough.length} buildings near the route`);

  // 4. pre-detour ETA and loose time screen. A detour only makes arrival later,
  // so anything already past the window's late edge cannot recover.
  const prelim = [];
  for (const r of rough) {
    const eta = new Date(route.departure.getTime() + r.vertex.t * 1000);
    for (const u of r.units) {
      if (filters.hideRestricted && u.flags?.includes("restricted_access")) continue;
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
        legIndex: r.vertex.leg,
      });
    }
  }

  // 5. detour routing on survivors only, capped. Spend the routing budget on
  // units whose pre-detour timing already sits near the window (a detour only
  // pushes arrival later), then on whatever is closest to the route.
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
  const jobs = Array.from(byBuilding.entries()).slice(0, maxDetourCalls);
  // route.timeScale > 1 when the user supplied a traffic-aware drive time from
  // Google or Apple; detour legs come back unscaled and get the same factor.
  const scale = route.timeScale || 1;
  let done = 0;
  async function worker(queue) {
    while (queue.length) {
      const [bid, cands] = queue.shift();
      const b = cands[0].building;
      const legIndex = cands[0].legIndex;
      const places = route.places.slice();
      places.splice(legIndex + 1, 0, { name: b.name, lng: b.lng, lat: b.lat });
      try {
        const r = await routeDetour(places, { departure: route.departure });
        const toBuilding = r.legSeconds.slice(0, legIndex + 1).reduce((a, s) => a + s, 0) * scale;
        const detourMin = (r.totalSeconds * scale - route.totalSeconds) / 60;
        for (const c of cands) {
          c.routed = true;
          c.detourMinutes = Math.max(0, detourMin);
          c.arrivalAtBuilding = new Date(route.departure.getTime() + toBuilding * 1000);
          if (c.startInstant) c.deltaMinutes = (c.arrivalAtBuilding - c.startInstant) / 60000;
        }
      } catch (e) {
        for (const c of cands) c.routeError = e.message;
      }
      done++;
      onProgress(`Routing detours… ${done}/${jobs.length}`);
    }
  }
  const queue = jobs.slice();
  await Promise.all(Array.from({ length: concurrency }, () => worker(queue)));

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
    const restricted = c.unit.flags?.includes("restricted_access");
    c.hidden = filters.hideRestricted && restricted;
    c.passes = c.routed && c.detourMinutes <= filters.maxDetourMin && inWindow(c.deltaMinutes, filters);
    c.score = score(c);
  }
  return sortCandidates(candidates.filter((c) => !c.hidden), filters.sort);
}
