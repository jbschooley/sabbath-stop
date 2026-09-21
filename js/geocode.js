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

// Among several hits, the one whose address best matches `detail`, the
// street part of what was asked for: a matching house number counts double,
// each street word once; suffixes and compass letters are ignored. With no
// match at all the first hit stands. Written for ABRP's "Tesla Supercharger
// Beaver, UT - 525 W", it serves any "Name, 1185 S Vista Ave, Boise, ID":
// Boise has eight McDonald's, and the address is what tells them apart.
const NOISE = new Set(["rd", "road", "st", "street", "ave", "avenue", "dr", "drive", "blvd", "boulevard", "hwy", "highway", "ln", "lane", "way", "pkwy", "parkway", "ct", "court", "pl", "n", "s", "e", "w", "north", "south", "east", "west", "the", "and"]);
export function pickByAddress(detail, hits) {
  if (!hits.length) return null;
  if (!detail) return hits[0];
  const words = detail.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !NOISE.has(w));
  const number = words.find((w) => /^\d+$/.test(w));
  let best = hits[0], bestScore = 0;
  for (const h of hits) {
    const text = ` ${(h.name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
    let score = 0;
    for (const w of words) {
      if (!text.includes(` ${w} `)) continue;
      score += w === number ? 2 : 1;
    }
    if (score > bestScore) { best = h; bestScore = score; }
  }
  return best;
}

// One-shot geocode for a pasted place name. The typed fields are where
// ambiguity gets a picker; here, anything after the name's first comma is
// treated as an address and used to choose among same-named hits.
export async function geocodeOne(query) {
  const hits = await suggest(query, { limit: 12 });
  if (!hits.length) throw new Error(`Could not find "${query}"`);
  const comma = query.indexOf(",");
  return comma > 0 ? pickByAddress(query.slice(comma + 1), hits) : hits[0];
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
