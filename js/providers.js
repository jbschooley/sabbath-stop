// Route providers. Every one of them ends in the same Route shape; nothing
// downstream knows where a route came from.
//
// Route = { source, departure, points:[{lng,lat,t,d,leg}], bbox, totalSeconds,
//           totalMiles, places:[{name,lng,lat}], legSeconds }

import { bboxOf, haversineMi } from "./geo.js";
import { geocodeOne } from "./geocode.js";
import { applyDwell, dwellBefore, routePlaces } from "./routing.js";

// ---------------------------------------------------------------- shared

async function routeThrough(source, places, departure) {
  const r = await routePlaces(places, { departure });
  const points = applyDwell(r.points.map((p) => ({ ...p })), places);
  const dwellSeconds = dwellBefore(places, places.length - 2);
  return {
    source, departure,
    points,
    bbox: bboxOf(points),
    driveSeconds: r.totalSeconds,          // pure driving, unscaled
    dwellSeconds,
    totalSeconds: r.totalSeconds + dwellSeconds,
    timeScale: 1,
    totalMiles: r.totalMiles,
    legSeconds: r.legSeconds,
    places,
    provider: r.provider,
  };
}

// Resolve any places that are still just text.
async function resolvePlaces(specs) {
  const out = [];
  for (const s of specs) {
    if (typeof s.lng === "number" && typeof s.lat === "number") { out.push(s); continue; }
    const hit = await geocodeOne(s.query);
    // Keep what came with the request (dwellSeconds, etc.); take coordinates
    // and any missing name from the hit.
    out.push({ ...s, ...hit, name: s.name || hit.name });
  }
  return out;
}

// ---------------------------------------------------------------- manual A -> B

export async function fromPlaces(places, departure) {
  return routeThrough("manual", await resolvePlaces(places), departure);
}

// ---------------------------------------------------------------- Google Maps link

const LATLNG_RE = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

function placeFromText(text) {
  const m = LATLNG_RE.exec(text);
  if (m) {
    const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
    return { name: `${lat.toFixed(4)}, ${lng.toFixed(4)}`, lat, lng };
  }
  return { query: text, name: text };
}

// Expanded /dir/ URLs only. Short maps.app.goo.gl links cannot be followed
// from a browser because the redirect is blocked by CORS.
// Returns [origin, ...stops, destination]; origin is null when the link has
// an empty first segment ("/dir//Cedar+City/..."), which Google emits for
// "your location".
export function parseGoogleUrl(url) {
  const u = new URL(url);
  if (/goo\.gl$/.test(u.hostname) || u.hostname === "maps.app.goo.gl") {
    throw new Error("Short Google links can't be expanded here. Open it, then paste the full /dir/ URL from the address bar.");
  }
  const i = u.pathname.indexOf("/dir/");
  if (i < 0) {
    // The query form, which ABRP's "open in Google Maps" emits:
    //   /maps?saddr=lat,lng&daddr=lat,lng+to:lat,lng&dirflg=d
    // Same shape as Apple's, so the same parser applies.
    if (u.searchParams.get("daddr")) return parseSaddrDaddr(u);
    throw new Error("Not a Google Maps directions URL (no /dir/ path and no daddr).");
  }
  const segs = u.pathname.slice(i + 5).split("/");
  const places = [];
  segs.forEach((raw, idx) => {
    if (raw.startsWith("@") || raw.startsWith("data=")) { segs.length = idx; return; }
    const text = decodeURIComponent(raw.replace(/\+/g, " ")).trim();
    if (text) places.push(placeFromText(text));
    else if (idx === 0) places.push(null);
  });
  while (places.length && places[places.length - 1] === null) places.pop();
  if (places.length < 2) throw new Error("Need at least a destination and one more place in the link.");
  return places;
}

// Google's expanded directions URLs carry a chosen time inside the data blob
// as "!8j<epoch seconds>", with "!6e0" meaning depart-at and "!6e1" arrive-by.
// Only depart-at is a departure. The share-link form (?api=1) and Apple Maps
// links carry no time at all. Returns a Date or null.
export function parseGoogleDeparture(url) {
  const m = /!8j(\d{9,11})(?:!|$)/.exec(url);
  if (!m) return null;
  if (/!6e1(?:!|$)/.test(url)) return null; // arrive-by, not a departure
  const d = new Date(parseInt(m[1], 10) * 1000);
  const y = d.getUTCFullYear();
  return y >= 2020 && y < 2100 ? d : null;
}

// ---------------------------------------------------------------- Apple Maps link

// saddr is optional (omitted for "current location"); daddr may chain stops
// with " to:" (both Apple and Google accept this form; URLSearchParams turns
// the "+" into a space). Returns [origin|null, ..., dest].
function parseSaddrDaddr(u) {
  const s = u.searchParams.get("saddr");
  const d = u.searchParams.get("daddr");
  if (!d) throw new Error("The link needs a daddr (destination).");
  const stops = d.split(/\s+to:\s*/i).map((t) => t.trim()).filter(Boolean).map(placeFromText);
  return [s && s.trim() ? placeFromText(s.trim()) : null, ...stops];
}

export function parseAppleUrl(url) {
  return parseSaddrDaddr(new URL(url));
}

export function looksLikeGoogle(url) { return /google\.[a-z.]+\/maps|goo\.gl/.test(url); }
export function looksLikeApple(url) { return /maps\.apple\.com/.test(url); }
// ABRP's "Export to Excel" share link. Served with CORS, so it can be fetched
// straight from the page.
export function looksLikeAbrpFile(url) { return /api\.iternio\.com\/1\/files\/get_file\?/.test(url); }

// One entry point for pasted links. Returns { places, departure } where
// places[0] may be null (use the device's location) and departure may be null.
export function parseLink(url) {
  const trimmed = url.trim();
  if (looksLikeGoogle(trimmed)) return { places: parseGoogleUrl(trimmed), departure: parseGoogleDeparture(trimmed), source: "google" };
  if (looksLikeApple(trimmed)) return { places: parseAppleUrl(trimmed), departure: null, source: "apple" };
  throw new Error("That doesn't look like a Google Maps or Apple Maps link.");
}

// Default time at a stop, by what the stop is. Tesla Superchargers get a
// charging stop; everything else is a pass-through unless the user says so.
export function defaultDwellMinutes(place) {
  const name = (place && (place.name || place.query)) || "";
  return /supercharger/i.test(name) || /\btesla\b/i.test(name) ? 15 : 0;
}

// ---------------------------------------------------------------- GPX / KML

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("File is not well-formed XML.");
  return doc;
}

// Returns { track: [{lng,lat,time?}], waypoints: [{name,lng,lat}] }
export function parseGpx(text) {
  const doc = parseXml(text);
  const track = [];
  for (const pt of doc.querySelectorAll("trkpt, rtept")) {
    const lat = parseFloat(pt.getAttribute("lat"));
    const lng = parseFloat(pt.getAttribute("lon"));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const timeEl = pt.querySelector("time");
    const time = timeEl ? Date.parse(timeEl.textContent.trim()) : NaN;
    track.push({ lng, lat, time: Number.isFinite(time) ? time : undefined });
  }
  const waypoints = [];
  for (const wp of doc.querySelectorAll("wpt")) {
    const lat = parseFloat(wp.getAttribute("lat"));
    const lng = parseFloat(wp.getAttribute("lon"));
    const name = (wp.querySelector("name") || {}).textContent || "";
    if (Number.isFinite(lat) && Number.isFinite(lng)) waypoints.push({ name: name.trim() || "Waypoint", lng, lat });
  }
  return { track, waypoints };
}

export function parseKml(text) {
  const doc = parseXml(text);
  const track = [];
  for (const ls of doc.querySelectorAll("LineString coordinates, gx\\:Track")) {
    const raw = ls.textContent.trim();
    for (const tuple of raw.split(/\s+/)) {
      const [lng, lat] = tuple.split(",").map(Number);
      if (Number.isFinite(lat) && Number.isFinite(lng)) track.push({ lng, lat });
    }
  }
  const waypoints = [];
  for (const pm of doc.querySelectorAll("Placemark")) {
    const pt = pm.querySelector("Point coordinates");
    if (!pt) continue;
    const [lng, lat] = pt.textContent.trim().split(",").map(Number);
    const name = (pm.querySelector("name") || {}).textContent || "Waypoint";
    if (Number.isFinite(lat) && Number.isFinite(lng)) waypoints.push({ name: name.trim(), lng, lat });
  }
  return { track, waypoints };
}

// Thin the track to at most n evenly spaced points, always keeping both ends.
function sampleTrack(track, n) {
  if (track.length <= n) return track;
  const out = [];
  for (let i = 0; i < n; i++) out.push(track[Math.round((i * (track.length - 1)) / (n - 1))]);
  return out;
}

export async function fromTrackFile(text, filename, departure) {
  const isKml = /\.kml$/i.test(filename) || /<kml[\s>]/i.test(text.slice(0, 500));
  const { track, waypoints } = isKml ? parseKml(text) : parseGpx(text);
  if (track.length < 2 && waypoints.length < 2) throw new Error("No track or waypoints found in the file.");

  const stamped = track.filter((p) => p.time !== undefined);
  if (stamped.length >= 2 && stamped.length === track.length) {
    // Highest-fidelity case: real timestamps. Departure becomes the first
    // timestamp unless the user has overridden it, and t is measured from it.
    const t0 = track[0].time;
    const points = [];
    let d = 0;
    track.forEach((p, i) => {
      if (i > 0) d += haversineMi(track[i - 1].lng, track[i - 1].lat, p.lng, p.lat);
      const t = (p.time - t0) / 1000;
      points.push({ lng: p.lng, lat: p.lat, t, drive: t, d, leg: 0 });
    });
    const places = [
      { name: "Start", lng: track[0].lng, lat: track[0].lat },
      { name: "End", lng: track[track.length - 1].lng, lat: track[track.length - 1].lat },
    ];
    const last = points[points.length - 1];
    return {
      source: "gpx", departure: departure || new Date(t0),
      points, bbox: bboxOf(points), driveSeconds: last.t, dwellSeconds: 0, totalSeconds: last.t, timeScale: 1,
      totalMiles: last.d, legSeconds: [last.t], places, provider: "file",
    };
  }

  // No timing in the file: re-route through its shape rather than inventing
  // speeds. Valhalla accepts many locations, but be gentle with the count.
  const seed = track.length >= 2 ? sampleTrack(track, 12) : waypoints;
  const places = seed.map((p, i) => ({
    name: p.name || (i === 0 ? "Start" : i === seed.length - 1 ? "End" : `Via ${i}`),
    lng: p.lng, lat: p.lat,
  }));
  return routeThrough("gpx", places, departure);
}
