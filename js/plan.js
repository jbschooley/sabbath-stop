// A finished plan, kept so it comes back without the network: the route,
// every candidate with its detour time, the zones of the route's places,
// and a key for the inputs it was built from. Routing and detour timing are
// the only things that need a connection; once a plan exists, moving the
// departure moves every arrival by the same amount, and the meeting-day and
// window checks are local. That is what makes "I'm running 40 minutes late"
// answerable in a dead zone.

import { meetingStartInstant, weekdayIn } from "./tz.js";

export const PLAN_KEY = "ss:last-plan";       // localStorage key
export const PLAN_URL = "./ss-last-plan.json"; // Cache API key: a same-origin URL that is never fetched
export const PLAN_VERSION = 1;

const r5 = (v) => Math.round(v * 1e5) / 1e5;
const r1 = (v) => Math.round(v * 10) / 10;
const ms = (d) => (d instanceof Date ? d.getTime() : d == null ? null : d);
const date = (v) => (v == null ? null : new Date(v));

// The inputs a plan depends on, as one comparable string: each place's
// coordinates and dwell, and the drive-time override. Typed text and ids
// are left out so a re-picked identical place still matches.
export function inputsKey(snapshot) {
  const stops = (snapshot.stops || []).map((s) => {
    const p = s.place && typeof s.place.lng === "number" ? [r5(s.place.lng), r5(s.place.lat)] : (s.text || "").trim().toLowerCase();
    return [p, +s.dwellMin || 0];
  });
  return JSON.stringify([stops, snapshot.trafficH || "", snapshot.trafficM || "", !!snapshot.trafficIncludesStops]);
}

export function serializePlan({ route, candidates, zones, inputsKey: key, savedAt = Date.now() }) {
  // Buildings are shared by their units and carry every unit they host;
  // store each once, without that list, and point at it by id.
  const buildings = {};
  for (const c of candidates) {
    if (!buildings[c.building.id]) { const { units, ...b } = c.building; buildings[b.id] = b; }
  }
  return {
    v: PLAN_VERSION,
    savedAt,
    inputsKey: key,
    zones,
    route: {
      ...route,
      departure: ms(route.departure),
      points: route.points.map((p) => [r5(p.lng), r5(p.lat), r1(p.t), r1(p.d), p.leg || 0]),
    },
    buildings,
    candidates: candidates.map(({ building, ...c }) => ({
      ...c,
      buildingId: building.id,
      etaAtNearestPoint: ms(c.etaAtNearestPoint),
      startInstant: ms(c.startInstant),
      arrivalAtBuilding: ms(c.arrivalAtBuilding),
    })),
  };
}

export function revivePlan(obj) {
  if (!obj || obj.v !== PLAN_VERSION || !obj.route || !Array.isArray(obj.candidates) || !obj.buildings) return null;
  return {
    savedAt: obj.savedAt,
    inputsKey: obj.inputsKey,
    zones: obj.zones || [],
    route: {
      ...obj.route,
      departure: date(obj.route.departure),
      points: obj.route.points.map(([lng, lat, t, d, leg]) => ({ lng, lat, t, d, leg })),
    },
    candidates: obj.candidates.map(({ buildingId, ...c }) => ({
      ...c,
      building: obj.buildings[buildingId],
      etaAtNearestPoint: date(c.etaAtNearestPoint),
      startInstant: date(c.startInstant),
      arrivalAtBuilding: date(c.arrivalAtBuilding),
    })),
  };
}

// Move a plan to a new departure. Drive and dwell times are unchanged, so
// every instant shifts by the same amount; the meeting start is then found
// again on the new arrival day in the building's zone, since the shift can
// cross midnight or land on a day the unit does not meet.
export function shiftPlan(plan, departure) {
  const delta = departure.getTime() - plan.route.departure.getTime();
  const route = { ...plan.route, departure: new Date(departure.getTime()) };
  const candidates = plan.candidates.map((c) => {
    const eta = new Date(c.etaAtNearestPoint.getTime() + delta);
    const arrival = new Date(c.arrivalAtBuilding.getTime() + delta);
    const tz = c.building.tz;
    const meetsOn = c.meetsOn || c.unit.day || "SUNDAY";
    const wrongDay = weekdayIn(eta, tz) !== meetsOn;
    let startInstant = null, deltaMinutes = null;
    if (!wrongDay && c.unit.start && !(c.unit.flags || []).includes("no_start_time")) {
      startInstant = meetingStartInstant(eta, c.unit.start, tz);
      deltaMinutes = ((c.routed ? arrival : eta).getTime() - startInstant.getTime()) / 60000;
    }
    return { ...c, etaAtNearestPoint: eta, arrivalAtBuilding: arrival, wrongDay, meetsOn, startInstant, deltaMinutes };
  });
  return { ...plan, route, candidates };
}

// Where the plan lives. The Cache API has room for it (localStorage's few
// megabytes are shared with the route cache and a long trip's plan can be
// most of that); localStorage is the fallback where caches are unavailable,
// such as a non-secure context.
export function planStore(win = globalThis) {
  if (win.caches && typeof win.caches.open === "function") {
    return {
      async get() { const c = await win.caches.open("ss-plan"); const r = await c.match(PLAN_URL); return r ? r.text() : null; },
      async set(text) { const c = await win.caches.open("ss-plan"); await c.put(PLAN_URL, new Response(text, { headers: { "Content-Type": "application/json" } })); },
    };
  }
  const ls = win.localStorage;
  return { async get() { return ls.getItem(PLAN_KEY); }, async set(text) { ls.setItem(PLAN_KEY, text); } };
}

export async function savePlan(store, plan) {
  try { await store.set(JSON.stringify(serializePlan(plan))); return true; }
  catch (e) { console.warn("plan not saved:", e.message); return false; } // a convenience, not a requirement
}

export async function loadPlan(store) {
  try { return revivePlan(JSON.parse((await store.get()) || "null")); }
  catch { return null; }
}
