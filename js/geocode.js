// Photon (komoot) for type-ahead and reverse geocoding. Free, keyless,
// CORS-enabled, and built for autocomplete, which Nominatim's policy forbids.

export const PHOTON_URL = "https://photon.komoot.io";

const memo = new Map();

// "Costa Vida, 801 West Main Street, Boise, Idaho": the street line tells
// two branches in one city apart, the way Google's picker does.
export function label(props) {
  const street = [props.housenumber, props.street].filter(Boolean).join(" ");
  const bits = [props.name];
  if (street && street !== props.name) bits.push(street);
  if (props.city && props.city !== props.name) bits.push(props.city);
  if (props.state) bits.push(props.state);
  if (props.country && props.country !== "United States") bits.push(props.country);
  return bits.filter(Boolean).join(", ");
}

function toPlace(feature) {
  const [lng, lat] = feature.geometry.coordinates;
  const props = feature.properties || {};
  return {
    name: label(props) || `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
    lng, lat,
    kind: [props.osm_key, props.osm_value].filter(Boolean).join(":"),
  };
}

// Photon ranks by importance and location bias, which lets a restaurant or a
// hamlet that happens to be named "Istanbul" outrank the city when the map is
// nearby. For a route planner the settlement is almost always what was meant,
// so re-rank: populated places first, biggest first, and an exact name match
// ahead of a partial one. Photon's own order breaks ties.
const KIND_WEIGHT = {
  "place:city": 60, "place:town": 50, "boundary:administrative": 40, "place:village": 35,
  "place:municipality": 35, "place:suburb": 25, "place:hamlet": 20, "place:locality": 15,
  "place:county": 10, "place:state": 10, "place:country": 10,
};
export function rankSuggestions(query, places) {
  const head = query.split(",")[0].trim().toLowerCase();
  const score = (p) => {
    const kind = KIND_WEIGHT[p.kind] ?? 0;
    const name = (p.name || "").split(",")[0].trim().toLowerCase();
    const exact = head && name === head ? 30 : head && name.startsWith(head) ? 10 : 0;
    return kind + exact;
  };
  return places
    .map((p, i) => ({ p, i, s: score(p) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.p);
}

// Returns up to `limit` places. Callers must debounce; this only memoizes.
export async function suggest(query, { limit = 6, bias } = {}) {
  const q = query.trim();
  if (q.length < 3) return [];
  const key = `${q}|${limit}|${bias ? `${bias.lng.toFixed(1)},${bias.lat.toFixed(1)}` : ""}`;
  if (memo.has(key)) return memo.get(key);
  // Ask for a few more than we show so a city that Photon ranked fifth can
  // still surface at the top.
  const params = new URLSearchParams({ q, limit: String(Math.max(limit, 8)), lang: "en" });
  // location_bias_scale: 0 = pure proximity, 1 = pure importance. At the
  // default 0.2 a kebab shop near the map beats the city of Istanbul; at 0.7
  // the city wins while the nearer of several Springfields is still first.
  if (bias) { params.set("lat", String(bias.lat)); params.set("lon", String(bias.lng)); params.set("location_bias_scale", "0.7"); }
  const resp = await fetch(`${PHOTON_URL}/api/?${params}`);
  if (!resp.ok) throw new Error(`Photon HTTP ${resp.status}`);
  const json = await resp.json();
  const places = rankSuggestions(q, (json.features || []).map(toPlace)).slice(0, limit);
  memo.set(key, places);
  return places;
}

// One-shot geocode for a pasted place name. Takes the top-ranked hit; the
// typed fields are where ambiguity gets a picker.
export async function geocodeOne(query) {
  const hits = await suggest(query, { limit: 5 });
  if (!hits.length) throw new Error(`Could not find "${query}"`);
  return hits[0];
}

export async function reverse(lng, lat) {
  const params = new URLSearchParams({ lon: String(lng), lat: String(lat), lang: "en" });
  const resp = await fetch(`${PHOTON_URL}/reverse?${params}`);
  if (!resp.ok) throw new Error(`Photon HTTP ${resp.status}`);
  const json = await resp.json();
  const f = json.features && json.features[0];
  if (!f) return { name: `${lat.toFixed(4)}, ${lng.toFixed(4)}`, lng, lat };
  const p = toPlace(f);
  return { ...p, lng, lat }; // keep the exact fix, not the matched feature
}

export function debounce(fn, ms) {
  let timer;
  return (...args) =>
    new Promise((resolve) => {
      clearTimeout(timer);
      timer = setTimeout(() => resolve(fn(...args)), ms);
    });
}
