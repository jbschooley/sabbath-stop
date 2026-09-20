// Routing adapter. Valhalla (FOSSGIS) first, OSRM demo server as fallback.
// Both are donated community infrastructure: results are cached in
// localStorage and the base URLs live here so self-hosting is a one-line change.

import { decodePolyline, haversineMi } from "./geo.js";

export const VALHALLA_URL = "https://valhalla1.openstreetmap.de/route";
export const MATRIX_URL = "https://valhalla1.openstreetmap.de/sources_to_targets";
export const OSRM_URL = "https://router.project-osrm.org/route/v1/driving";

// Drive times from every source to every target in one call. Same road graph
// and costing as a route request, so each cell is an exact routed leg time.
// Returns seconds[sourceIndex][targetIndex], null where unreachable.
// The public instance refuses the whole request if any pair is over 150 km,
// so callers batch by position along the route.
export async function matrix(sources, targets, { departure } = {}) {
  const body = {
    sources: sources.map((p) => ({ lat: p.lat, lon: p.lng })),
    targets: targets.map((p) => ({ lat: p.lat, lon: p.lng })),
    costing: "auto",
  };
  if (departure) body.date_time = { type: 1, value: localStamp(departure) };
  const resp = await fetch(MATRIX_URL, { method: "POST", body: JSON.stringify(body) });
  const json = await resp.json().catch(() => null);
  if (!resp.ok || !json || !json.sources_to_targets) {
    throw new Error((json && json.error) || `matrix HTTP ${resp.status}`);
  }
  return json.sources_to_targets.map((row) => row.map((cell) => (cell && cell.time != null ? cell.time : null)));
}

// Time spent at intermediate stops. places[k].dwellSeconds is how long you
// stay at stop k (origin and destination carry none). dwellBefore(legIndex)
// is the dwell accumulated before you start driving leg legIndex.
export function dwellBefore(places, legIndex) {
  let s = 0;
  for (let k = 1; k <= legIndex && k < places.length - 1; k++) s += places[k].dwellSeconds || 0;
  return s;
}

// Turn pure driving times into clock times: t = scaled drive + dwell before
// this leg. `scale` is one factor for the whole route or an array with one
// factor per leg (an ABRP export gives per-leg times). Keeps `drive` on each
// point so a different scale can be applied later. The vertex shared by two
// legs belongs to the earlier leg, so each leg's scale covers exactly its
// own segments.
export function applyDwell(points, places, scale = 1) {
  const s = (leg) => (Array.isArray(scale) ? (scale[leg] ?? 1) : scale);
  let leg = -1, legStartDrive = 0, scaledAtLegStart = 0, lastDrive = 0;
  for (const p of points) {
    if (p.drive === undefined) p.drive = p.t;
    if (p.leg !== leg) {
      if (leg >= 0) scaledAtLegStart += (lastDrive - legStartDrive) * s(leg);
      leg = p.leg;
      legStartDrive = lastDrive;
    }
    p.t = scaledAtLegStart + (p.drive - legStartDrive) * s(leg) + dwellBefore(places, leg);
    lastDrive = p.drive;
  }
  return points;
}

const CACHE_PREFIX = "ss:route:";
const CACHE_MAX_ENTRIES = 12;
const CACHE_MAX_BYTES = 1_500_000;

function cacheKey(places, departure) {
  const when = departure ? localStamp(departure) : "";
  return CACHE_PREFIX + when + "|" + places.map((p) => `${p.lng.toFixed(5)},${p.lat.toFixed(5)}`).join(";");
}

// "YYYY-MM-DDTHH:MM" in the browser's zone. Valhalla wants the local time at
// the origin; the person planning the trip is almost always there.
function localStamp(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function cacheGet(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw);
    v.points = v.points.map(([lng, lat, t, d, leg]) => ({ lng, lat, t, d, leg }));
    return v;
  } catch { return null; }
}

function cacheSet(key, value) {
  try {
    const compact = { ...value, points: value.points.map((p) => [p.lng, p.lat, p.t, p.d, p.leg]) };
    const raw = JSON.stringify(compact);
    if (raw.length > CACHE_MAX_BYTES) return;
    const keys = Object.keys(localStorage).filter((k) => k.startsWith(CACHE_PREFIX));
    while (keys.length >= CACHE_MAX_ENTRIES) localStorage.removeItem(keys.shift());
    localStorage.setItem(key, raw);
  } catch {
    // Quota or private mode: drop the whole route cache and carry on.
    try {
      Object.keys(localStorage).filter((k) => k.startsWith(CACHE_PREFIX)).forEach((k) => localStorage.removeItem(k));
    } catch { /* ignore */ }
  }
}

// Returns { points: [{lng, lat, t, d, leg}], legSeconds: [...], totalSeconds, totalMiles, provider }.
// t = cumulative seconds from departure, d = cumulative miles, leg = index of the
// leg the vertex belongs to (needed to insert a detour stop in the right place).
export async function routePlaces(places, { departure } = {}) {
  if (places.length < 2) throw new Error("Need at least two places to route");
  const key = cacheKey(places, departure);
  const hit = cacheGet(key);
  if (hit) return hit;

  let result;
  try {
    result = await routeValhalla(places, departure);
  } catch (e) {
    try {
      result = await routeOsrm(places);
    } catch (e2) {
      throw new Error(`Routing failed. Valhalla: ${e.message}. OSRM: ${e2.message}`);
    }
  }
  cacheSet(key, result);
  return result;
}

async function routeValhalla(places, departure) {
  const body = {
    locations: places.map((p) => ({ lat: p.lat, lon: p.lng })),
    costing: "auto",
    units: "miles",
  };
  // Time-dependent routing. The public FOSSGIS instance has no live traffic,
  // so this mostly matters for time-restricted roads; it costs nothing to
  // send and becomes useful the moment the routing host has speed history.
  if (departure) body.date_time = { type: 1, value: localStamp(departure) };
  // A string body with the default text/plain content type is a "simple"
  // request: no CORS preflight round-trip against a donated server.
  const resp = await fetch(VALHALLA_URL, { method: "POST", body: JSON.stringify(body) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = await resp.json();
  const trip = json.trip;
  if (!trip || !trip.legs) throw new Error("no trip in response");

  const points = [];
  const legSeconds = [];
  let t = 0, d = 0;
  trip.legs.forEach((leg, legIdx) => {
    const shape = decodePolyline(leg.shape, 6);
    // Per-vertex time: walk maneuvers and spread each one's time across its
    // vertices in proportion to segment length.
    const vt = new Array(shape.length).fill(0);
    for (const m of leg.maneuvers || []) {
      const b = m.begin_shape_index, e = m.end_shape_index;
      if (e <= b) continue;
      const segLens = [];
      let total = 0;
      for (let i = b; i < e; i++) {
        const l = haversineMi(shape[i][0], shape[i][1], shape[i + 1][0], shape[i + 1][1]);
        segLens.push(l); total += l;
      }
      for (let i = b; i < e; i++) {
        const share = total > 0 ? segLens[i - b] / total : 1 / (e - b);
        vt[i + 1] = (m.time || 0) * share;
      }
    }
    const start = legIdx === 0 ? 0 : 1; // legs share their boundary vertex
    for (let i = start; i < shape.length; i++) {
      if (i > 0) {
        d += haversineMi(shape[i - 1][0], shape[i - 1][1], shape[i][0], shape[i][1]);
        t += vt[i];
      }
      points.push({ lng: shape[i][0], lat: shape[i][1], t, d, leg: legIdx });
    }
    legSeconds.push(leg.summary?.time ?? 0);
  });

  return {
    points,
    legSeconds,
    totalSeconds: trip.summary?.time ?? t,
    totalMiles: trip.summary?.length ?? d,
    provider: "valhalla",
  };
}

async function routeOsrm(places) {
  const coords = places.map((p) => `${p.lng},${p.lat}`).join(";");
  const url = `${OSRM_URL}/${coords}?overview=full&geometries=polyline6&annotations=duration,distance&steps=false`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = await resp.json();
  const route = json.routes && json.routes[0];
  if (!route) throw new Error(json.message || "no route");

  const shape = decodePolyline(route.geometry, 6);
  const points = [];
  const legSeconds = [];
  let t = 0, d = 0, vi = 0;
  route.legs.forEach((leg, legIdx) => {
    const dur = leg.annotation.duration;
    const dist = leg.annotation.distance;
    if (legIdx === 0) points.push({ lng: shape[0][0], lat: shape[0][1], t: 0, d: 0, leg: 0 });
    for (let i = 0; i < dur.length; i++) {
      vi++;
      t += dur[i];
      d += dist[i] / 1609.344;
      const v = shape[Math.min(vi, shape.length - 1)];
      points.push({ lng: v[0], lat: v[1], t, d, leg: legIdx });
    }
    legSeconds.push(leg.duration);
  });

  return {
    points,
    legSeconds,
    totalSeconds: route.duration,
    totalMiles: route.distance / 1609.344,
    provider: "osrm",
  };
}
