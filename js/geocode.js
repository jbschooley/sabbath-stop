// Photon (komoot) for type-ahead and reverse geocoding. Free, keyless,
// CORS-enabled, and built for autocomplete, which Nominatim's policy forbids.

export const PHOTON_URL = "https://photon.komoot.io";

const memo = new Map();

function label(props) {
  const bits = [props.name];
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

// Returns up to `limit` places. Callers must debounce; this only memoizes.
export async function suggest(query, { limit = 6, bias } = {}) {
  const q = query.trim();
  if (q.length < 3) return [];
  const key = `${q}|${limit}|${bias ? `${bias.lng.toFixed(1)},${bias.lat.toFixed(1)}` : ""}`;
  if (memo.has(key)) return memo.get(key);
  const params = new URLSearchParams({ q, limit: String(limit), lang: "en" });
  if (bias) { params.set("lat", String(bias.lat)); params.set("lon", String(bias.lng)); }
  const resp = await fetch(`${PHOTON_URL}/api/?${params}`);
  if (!resp.ok) throw new Error(`Photon HTTP ${resp.status}`);
  const json = await resp.json();
  const places = (json.features || []).map(toPlace);
  memo.set(key, places);
  return places;
}

// One-shot geocode for a pasted place name. Takes the first hit; the typed
// fields are where ambiguity gets a picker.
export async function geocodeOne(query) {
  const hits = await suggest(query, { limit: 1 });
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
