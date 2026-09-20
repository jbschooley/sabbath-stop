// UI wiring. State lives here; the finder, providers and routing are pure-ish
// modules that know nothing about the DOM.

import { DEFAULT_FILTERS, findCandidates, reapply } from "./finder.js";
import { debounce, reverse, suggest } from "./geocode.js";
import { fromAppleUrl, fromGoogleUrl, fromPlaces, fromTrackFile, looksLikeApple, looksLikeGoogle } from "./providers.js";
import { applyDwell, matrix, routePlaces } from "./routing.js";
import { defaultDepartureLocal, fmtDateTime, fmtHHMM, toDatetimeLocal, tzAbbrev } from "./tz.js";

const $ = (id) => document.getElementById(id);
const FILTERS_KEY = "ss:filters:v2"; // bumped when defaults change so they take effect
const DEPART_KEY = "ss:departure";
const ROUTE_INPUT_KEY = "ss:route-input";
const TOP_SUBTYPES = ["CONVENTIONAL", "YSA", "YSA_JR", "YSA_SR", "SPANISH", "STUDENT_MARRIED"];
const MAX_MISSES_LISTED = 40;

const state = {
  filters: loadFilters(),
  route: null,
  candidates: [],
  selectedId: null,
  places: { origin: null, destination: null, waypoints: [], dwellMin: [] },
  manifest: null,
  subtypes: [],
  tileCache: new Map(),
  markers: new Map(),
};

// ---------------------------------------------------------------- persistence

function loadFilters() {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTERS_KEY) || "null");
    return { ...DEFAULT_FILTERS, ...(saved || {}) };
  } catch { return { ...DEFAULT_FILTERS }; }
}
function saveFilters() {
  try { localStorage.setItem(FILTERS_KEY, JSON.stringify(state.filters)); } catch { /* ignore */ }
}

// A departure still in the future is worth keeping across reloads; one in
// the past is stale and the picker goes back to now.
function initialDepartureLocal() {
  try {
    const saved = localStorage.getItem(DEPART_KEY);
    if (saved && new Date(saved) > new Date()) return saved;
  } catch { /* ignore */ }
  return defaultDepartureLocal();
}
// Origin, stops, destination, pasted link and which tab is active. Typed text
// that never became a picked place is kept as text so it comes back as typed.
function saveRouteInput() {
  try {
    const rows = [...document.querySelectorAll("#waypoints .field")];
    const snap = {
      mode: state.routeMode,
      originText: $("origin").value,
      origin: state.places.origin,
      destinationText: $("destination").value,
      destination: state.places.destination,
      waypoints: rows.map((row) => ({
        text: row.querySelector("input[type=text]").value,
        place: state.places.waypoints[row.dataset.idx] || null,
        dwellMin: row.querySelector("input.dwell").value,
      })),
      link: $("link").value,
      trafficH: $("traffic-h").value,
      trafficM: $("traffic-m").value,
    };
    localStorage.setItem(ROUTE_INPUT_KEY, JSON.stringify(snap));
  } catch { /* ignore */ }
}
function restoreRouteInput() {
  let snap = null;
  try { snap = JSON.parse(localStorage.getItem(ROUTE_INPUT_KEY) || "null"); } catch { /* ignore */ }
  if (!snap) return;
  $("origin").value = snap.originText || "";
  state.places.origin = snap.origin || null;
  $("destination").value = snap.destinationText || "";
  state.places.destination = snap.destination || null;
  for (const w of snap.waypoints || []) addWaypointRow(w.place, w.text, w.dwellMin);
  $("link").value = snap.link || "";
  $("traffic-h").value = snap.trafficH || "";
  $("traffic-m").value = snap.trafficM || "";
  if (snap.mode && snap.mode !== "ab") {
    const btn = document.querySelector(`[role="tab"][data-tab="${snap.mode}"]`);
    if (btn) btn.click();
  }
}
function saveDeparture(value) {
  try {
    if (value && new Date(value) > new Date()) localStorage.setItem(DEPART_KEY, value);
    else localStorage.removeItem(DEPART_KEY);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------- dataset

async function loadTile(key) {
  if (state.manifest && !state.manifest.tiles[key]) return null; // no units there
  if (state.tileCache.has(key)) return state.tileCache.get(key);
  const p = fetch(`data/tiles/${key}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  state.tileCache.set(key, p);
  return p;
}

async function loadDataset() {
  try {
    const [m, s] = await Promise.all([
      fetch("data/manifest.json").then((r) => r.json()),
      fetch("data/subtypes.json").then((r) => r.json()),
    ]);
    state.manifest = m;
    state.subtypes = s;
    $("dataset-note").textContent =
      `Dataset: ${m.counts.buildings.toLocaleString()} buildings, ${m.counts.units.toLocaleString()} units, refreshed ${m.generated.slice(0, 10)}.`;
  } catch (e) {
    setStatus("Could not load the dataset (data/manifest.json). Run build_tiles.py or wait for the monthly refresh.", true);
    state.subtypes = [];
  }
  renderSubtypes();
}

// ---------------------------------------------------------------- subtypes

function renderSubtypes() {
  const top = $("subtypes"), more = $("subtypes-more");
  top.innerHTML = ""; more.innerHTML = "";
  const selected = new Set(state.filters.subtypes);
  const known = new Map(state.subtypes.map((s) => [s.code, s]));
  const order = [...TOP_SUBTYPES.filter((c) => known.has(c)), ...state.subtypes.map((s) => s.code).filter((c) => !TOP_SUBTYPES.includes(c))];
  for (const code of order) {
    const s = known.get(code);
    const chip = document.createElement("label");
    chip.className = "chip" + (selected.has(code) ? " on" : "");
    chip.innerHTML = `<input type="checkbox" value="${code}" ${selected.has(code) ? "checked" : ""}> ${escapeHtml(s.label)} <span class="n">${s.count}</span>`;
    chip.querySelector("input").addEventListener("change", (e) => {
      const set = new Set(state.filters.subtypes);
      e.target.checked ? set.add(code) : set.delete(code);
      state.filters.subtypes = [...set];
      chip.classList.toggle("on", e.target.checked);
      saveFilters();
      $("subtype-hint").hidden = set.size > 0;
    });
    (TOP_SUBTYPES.includes(code) ? top : more).appendChild(chip);
  }
  $("subtype-hint").hidden = selected.size > 0;
}

// ---------------------------------------------------------------- filters UI

function bindFilters() {
  const f = state.filters;
  $("max-detour").value = f.maxDetourMin;
  $("window-min").value = f.windowMin;
  $("window-max").value = f.windowMax;
  $("wide").checked = f.wide;
  $("wide-hours").value = f.wideHours;
  $("show-flagged").checked = !!f.showFlagged;
  $("sort").value = f.sort;
  $("window-row").style.opacity = f.wide ? 0.5 : 1;

  const onChange = () => {
    f.maxDetourMin = clamp(parseFloat($("max-detour").value) || 10, 1, 120);
    f.windowMin = parseFloat($("window-min").value);
    f.windowMax = parseFloat($("window-max").value);
    if (!(f.windowMin <= f.windowMax)) { f.windowMax = f.windowMin; $("window-max").value = f.windowMax; }
    f.wide = $("wide").checked;
    f.wideHours = clamp(parseFloat($("wide-hours").value) || 2, 0.5, 6);
    f.showFlagged = $("show-flagged").checked;
    f.sort = $("sort").value;
    $("window-row").style.opacity = f.wide ? 0.5 : 1;
    saveFilters();
    // Live re-apply without re-routing. Showing flagged units or raising max
    // detour can add candidates that were never timed; that needs a fresh search.
    if (state.candidates.length) render();
  };
  for (const id of ["window-min", "window-max", "wide", "wide-hours", "show-flagged", "sort", "max-detour"]) {
    $(id).addEventListener("change", onChange);
  }
}

// ---------------------------------------------------------------- route input

function bindTabs() {
  document.querySelectorAll('[role="tab"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll('[role="tab"]').forEach((b) => b.setAttribute("aria-selected", b === btn));
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${btn.dataset.tab}`));
      state.routeMode = btn.dataset.tab;
      saveRouteInput();
    });
  });
  state.routeMode = "ab";
}

// Type-ahead against Photon: 300 ms debounce, 3-char minimum, ambiguous
// queries get a picker rather than the first hit.
function attachSuggest(input, list, onPick) {
  const run = debounce((q) => suggest(q, { bias: mapCenter() }), 300);
  let items = [], active = -1;
  const close = () => { list.hidden = true; list.innerHTML = ""; items = []; active = -1; };
  const show = (places) => {
    items = places; active = -1;
    list.innerHTML = places.map((p) => `<li role="option">${escapeHtml(p.name)}<span class="kind">${escapeHtml(p.kind || "")}</span></li>`).join("");
    list.hidden = places.length === 0;
    [...list.children].forEach((li, i) => li.addEventListener("mousedown", (e) => { e.preventDefault(); pick(i); }));
  };
  const pick = (i) => { const p = items[i]; if (!p) return; input.value = p.name; onPick(p); close(); saveRouteInput(); };
  input.addEventListener("input", async () => {
    onPick(null); // typed text invalidates any previous pick
    saveRouteInput();
    const q = input.value;
    if (q.trim().length < 3) return close();
    try { const res = await run(q); if (input.value === q) show(res); } catch { close(); }
  });
  input.addEventListener("keydown", (e) => {
    if (list.hidden) return;
    if (e.key === "ArrowDown") { active = Math.min(items.length - 1, active + 1); }
    else if (e.key === "ArrowUp") { active = Math.max(0, active - 1); }
    else if (e.key === "Enter") { if (active >= 0) { e.preventDefault(); pick(active); } return; }
    else if (e.key === "Escape") { return close(); }
    else return;
    e.preventDefault();
    [...list.children].forEach((li, i) => li.setAttribute("aria-selected", i === active));
  });
  input.addEventListener("blur", () => setTimeout(close, 150));
}

function addWaypointRow(prefill, text, dwellMin) {
  const wrap = $("waypoints");
  const idx = state.places.waypoints.length;
  state.places.waypoints.push(prefill || null);
  state.places.dwellMin.push(parseFloat(dwellMin) || 0);
  const row = document.createElement("div");
  row.className = "field suggest";
  row.dataset.idx = idx;
  row.innerHTML = `<label>Via</label><div class="row tight">
      <input type="text" placeholder="Optional stop" autocomplete="off">
      <input type="number" class="dwell" min="0" max="600" step="5" placeholder="0" inputmode="numeric" title="Minutes at this stop" aria-label="Minutes at this stop"><span class="unit">min</span>
      <button class="btn icon" title="Remove" aria-label="Remove stop">×</button>
    </div><ul hidden></ul>`;
  const input = row.querySelector("input[type=text]"), list = row.querySelector("ul"), dwell = row.querySelector("input.dwell");
  input.value = text ?? (prefill ? prefill.name : "");
  if (dwellMin) dwell.value = dwellMin;
  attachSuggest(input, list, (p) => { state.places.waypoints[idx] = p; });
  dwell.addEventListener("change", () => { state.places.dwellMin[idx] = Math.max(0, parseFloat(dwell.value) || 0); saveRouteInput(); });
  row.querySelector("button").addEventListener("click", () => { state.places.waypoints[idx] = undefined; row.remove(); saveRouteInput(); });
  wrap.appendChild(row);
}

async function useMyLocation() {
  const btn = $("use-location");
  if (!navigator.geolocation) return setStatus("Geolocation isn't available in this browser.", true);
  if (!window.isSecureContext) return setStatus("Location needs HTTPS or localhost. Type your origin instead.", true);
  btn.disabled = true;
  setStatus("Getting your location…");
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { longitude: lng, latitude: lat } = pos.coords;
      try {
        const p = await reverse(lng, lat);
        state.places.origin = p;
        $("origin").value = p.name;
        setStatus(`Starting from ${p.name}`);
      } catch {
        state.places.origin = { name: `${lat.toFixed(4)}, ${lng.toFixed(4)}`, lng, lat };
        $("origin").value = state.places.origin.name;
        setStatus("");
      }
      saveRouteInput();
      btn.disabled = false;
    },
    (err) => { setStatus(`Couldn't get your location (${err.message}). Type it instead.`, true); btn.disabled = false; },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
  );
}

function readDeparture() {
  const v = $("departure").value;
  const d = v ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) throw new Error("Pick a departure date and time.");
  return d;
}

async function buildRoute() {
  const departure = readDeparture();
  const mode = state.routeMode;
  if (mode === "link") {
    const url = $("link").value.trim();
    if (!url) throw new Error("Paste a directions link.");
    if (looksLikeGoogle(url)) return fromGoogleUrl(url, departure);
    if (looksLikeApple(url)) return fromAppleUrl(url, departure);
    throw new Error("That doesn't look like a Google Maps or Apple Maps link.");
  }
  if (mode === "file") {
    const f = $("file").files[0];
    if (!f) throw new Error("Choose a GPX or KML file.");
    return fromTrackFile(await f.text(), f.name, departure);
  }
  const o = state.places.origin || ($("origin").value.trim() ? { query: $("origin").value.trim() } : null);
  const d = state.places.destination || ($("destination").value.trim() ? { query: $("destination").value.trim() } : null);
  if (!o || !d) throw new Error("Enter where you're starting and where you're going.");
  const vias = state.places.waypoints
    .map((p, i) => (p ? { ...p, dwellSeconds: (state.places.dwellMin[i] || 0) * 60 } : null))
    .filter(Boolean);
  return fromPlaces([o, ...vias, d], departure);
}

// ---------------------------------------------------------------- traffic

function readTrafficSeconds() {
  const h = parseFloat($("traffic-h").value) || 0;
  const m = parseFloat($("traffic-m").value) || 0;
  const s = h * 3600 + m * 60;
  return s > 0 ? s : null;
}

// The free router has no traffic. If the user tells us what Google or Apple
// predicts for this departure, scale every driving time to match. Dwell at
// stops is clock time, not driving, and is left alone. Detour legs get the
// same factor inside the finder.
function applyTrafficTime(route) {
  const wanted = readTrafficSeconds();
  if (!wanted || !route.driveSeconds || route.provider === "file") { route.timeScale = 1; return; }
  const scale = wanted / route.driveSeconds;
  if (scale < 0.5 || scale > 3) { setStatus("That drive time is far from the routed one; ignoring it.", true); route.timeScale = 1; return; }
  route.timeScale = scale;
  route.totalSeconds = wanted + (route.dwellSeconds || 0);
  applyDwell(route.points, route.places, scale);
  route.legSeconds = route.legSeconds.map((s) => s * scale);
}

// ---------------------------------------------------------------- search

async function go() {
  if (!state.filters.subtypes.length) return setStatus("Pick at least one unit type first.", true);
  const btn = $("go");
  btn.disabled = true;
  clearResults();
  try {
    setStatus("Routing…");
    const route = await buildRoute();
    if (route.departureFromLink || (route.source === "gpx" && route.provider === "file")) {
      // The link or file carried its own departure; show it in the picker.
      $("departure").value = toDatetimeLocal(route.departure);
      saveDeparture($("departure").value);
    }
    applyTrafficTime(route);
    state.route = route;
    drawRoute(route);
    const scaled = route.timeScale && route.timeScale !== 1 ? ` (scaled ×${route.timeScale.toFixed(2)} to your Maps time)` : "";
    const dwell = route.dwellSeconds ? ` plus ${fmtDuration(route.dwellSeconds)} at stops` : "";
    const fromLink = route.departureFromLink ? " Departure taken from the link." : "";
    setStatus(`Route: ${route.totalMiles.toFixed(0)} mi, ${fmtDuration(route.totalSeconds - (route.dwellSeconds || 0))} driving${dwell} via ${route.provider}${scaled}.${fromLink} Finding wards…`);
    const candidates = await findCandidates(route, state.filters, {
      loadTile,
      matrix,
      routeDetour: routePlaces,
      onProgress: (m, partial) => {
        setStatus(m);
        if (partial) { state.candidates = partial; render(); }
      },
      maxDetourBuildings: 200,
      concurrency: 2,
    });
    state.candidates = candidates;
    render();
    const n = candidates.filter((c) => c.passes).length;
    setStatus(n ? `${n} ward${n === 1 ? "" : "s"} fit your filters.` : "Nothing fits. Greyed pins show near misses; try shifting departure or widening the window.");
  } catch (e) {
    console.error(e);
    setStatus(e.message || String(e), true);
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- render

let map, routeLayer, clusterOn, clusterOff;

function initMap() {
  map = L.map("map", { zoomControl: true }).setView([39.5, -111.5], 6);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  clusterOn = L.markerClusterGroup({ maxClusterRadius: 40 });
  clusterOff = L.markerClusterGroup({ maxClusterRadius: 60, iconCreateFunction: mutedClusterIcon });
  map.addLayer(clusterOff);
  map.addLayer(clusterOn);
}

function mutedClusterIcon(cluster) {
  return L.divIcon({ html: `<div style="opacity:.55"><span>${cluster.getChildCount()}</span></div>`, className: "marker-cluster marker-cluster-small", iconSize: L.point(40, 40) });
}

function mapCenter() {
  if (!map) return null;
  const c = map.getCenter();
  return { lng: c.lng, lat: c.lat };
}

function drawRoute(route) {
  if (routeLayer) map.removeLayer(routeLayer);
  const latlngs = route.points.map((p) => [p.lat, p.lng]);
  routeLayer = L.layerGroup([
    L.polyline(latlngs, { color: "#1d1d1b", weight: 5, opacity: 0.25 }),
    L.polyline(latlngs, { color: "#2f6f9f", weight: 3 }),
    ...route.places.map((p, i) => L.circleMarker([p.lat, p.lng], { radius: 6, color: "#fff", fillColor: i === 0 ? "#2e7d4f" : i === route.places.length - 1 ? "#b3261e" : "#b26a00", fillOpacity: 1, weight: 2 }).bindTooltip(p.name)),
  ]).addTo(map);
  map.fitBounds(L.latLngBounds(latlngs), { padding: [30, 30] });
}

function clearResults() {
  state.candidates = [];
  state.selectedId = null;
  state.markers.clear();
  clusterOn.clearLayers();
  clusterOff.clearLayers();
  $("results").innerHTML = "";
  $("summary").textContent = "";
}

function pinIcon(on, selected) {
  return L.divIcon({ className: "", html: `<div class="pin ${on ? "on" : "off"}${selected ? " sel" : ""}"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] });
}

function render() {
  const list = reapply(state.candidates, state.filters);
  const fits = list.filter((c) => c.passes);
  const misses = list.filter((c) => !c.passes);
  $("summary").textContent = list.length
    ? `${fits.length} fit, ${misses.length} near miss${misses.length === 1 ? "" : "es"} among ${list.length} matching units near the route.`
    : "";

  // list: every fit, then the nearest near misses. The map carries the rest.
  const ul = $("results");
  ul.innerHTML = "";
  const shownMisses = misses.slice().sort((a, b) => a.offRouteMiles - b.offRouteMiles).slice(0, MAX_MISSES_LISTED);
  for (const c of [...fits, ...shownMisses]) {
    const li = document.createElement("li");
    li.className = "result" + (c.passes ? "" : " miss") + (c.unit.id === state.selectedId ? " selected" : "");
    li.dataset.id = c.unit.id;
    li.innerHTML = resultHtml(c);
    li.addEventListener("click", () => select(c.unit.id, true));
    li.addEventListener("mouseenter", () => highlight(c.unit.id, true));
    li.addEventListener("mouseleave", () => highlight(c.unit.id, false));
    ul.appendChild(li);
  }
  if (misses.length > shownMisses.length) {
    const li = document.createElement("li");
    li.className = "result miss";
    li.textContent = `${(misses.length - shownMisses.length).toLocaleString()} more near misses are on the map but not listed.`;
    ul.appendChild(li);
  }

  // map: one marker per unit so a building with two units gets two pins,
  // slightly offset, each carrying its own popup.
  clusterOn.clearLayers(); clusterOff.clearLayers(); state.markers.clear();
  const perBuilding = new Map();
  for (const c of list) {
    const k = perBuilding.get(c.building.id) || 0;
    perBuilding.set(c.building.id, k + 1);
    const jitter = k * 0.00025;
    const m = L.marker([c.building.lat + jitter, c.building.lng + jitter], { icon: pinIcon(c.passes, c.unit.id === state.selectedId), zIndexOffset: c.passes ? 1000 : 0 });
    m.bindPopup(popupHtml(c), { maxWidth: 280 });
    m.on("click", () => select(c.unit.id, false));
    (c.passes ? clusterOn : clusterOff).addLayer(m);
    state.markers.set(c.unit.id, m);
  }
}

function select(id, fromList) {
  state.selectedId = id;
  document.querySelectorAll(".result").forEach((li) => li.classList.toggle("selected", li.dataset.id === id));
  const m = state.markers.get(id);
  const c = state.candidates.find((x) => x.unit.id === id);
  if (m && c) {
    m.setIcon(pinIcon(c.passes, true));
    if (fromList) {
      const group = c.passes ? clusterOn : clusterOff;
      group.zoomToShowLayer(m, () => m.openPopup());
    }
  }
  if (!fromList) {
    const li = document.querySelector(`.result[data-id="${CSS.escape(id)}"]`);
    if (li) li.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  for (const [uid, mk] of state.markers) if (uid !== id) { const cc = state.candidates.find((x) => x.unit.id === uid); mk.setIcon(pinIcon(cc.passes, false)); }
}

function highlight(id, on) {
  const m = state.markers.get(id);
  const c = state.candidates.find((x) => x.unit.id === id);
  if (m && c && id !== state.selectedId) m.setIcon(pinIcon(c.passes, on));
}

function deltaWords(c) {
  if (c.deltaMinutes === null) return { text: "time unknown", cls: "warn" };
  const m = Math.round(c.deltaMinutes);
  if (m > 0) return { text: `${m} min late`, cls: "bad" };
  if (m === 0) return { text: "right at the start", cls: "warn" };
  return { text: `${-m} min before it starts`, cls: -m > 45 ? "warn" : "good" };
}

function detourWords(c) {
  if (!c.routed) {
    if (c.routeError) return { text: "detour unknown", cls: "warn" };
    return { text: c.needsDetour ? "not timed (over the cap)" : "not timed", cls: "warn" };
  }
  const m = Math.round(c.detourMinutes);
  return { text: `+${m} min`, cls: m <= state.filters.maxDetourMin ? "good" : "bad" };
}

function flagWords(u) {
  const f = u.flags || [];
  const words = [];
  if (f.includes("no_start_time")) words.push("no start time published");
  if (f.includes("implausible_start")) words.push("start time looks like a typo upstream");
  if (f.includes("end_not_after_start")) words.push("end time ignored (before start)");
  if (f.includes("restricted_access")) words.push("restricted access");
  return words.join(" · ");
}

function startWords(c) {
  if (!c.unit.start) return "time not published";
  return `Sacrament ${fmtHHMM(c.unit.start, c.building.tz, c.etaAtNearestPoint)}`;
}

function resultHtml(c) {
  const d = deltaWords(c), t = detourWords(c);
  return `
    <div class="name">${escapeHtml(c.unit.name)}</div>
    <div class="where">${escapeHtml([c.building.city, c.building.state].filter(Boolean).join(", "))} · ${escapeHtml(c.unit.subTypeDisplay)} · ${escapeHtml(startWords(c))}</div>
    <div class="numbers"><span class="num ${t.cls}">${t.text}</span><span class="num ${d.cls}">${d.text}</span><span class="num">${c.milesAlongRoute.toFixed(0)} mi in</span></div>
    ${c.unit.flags?.length ? `<div class="flags">⚠ ${escapeHtml(flagWords(c.unit))}</div>` : ""}
    <div class="links">${linksHtml(c)}</div>`;
}

function popupHtml(c) {
  const d = deltaWords(c), t = detourWords(c);
  return `
    <div class="name">${escapeHtml(c.unit.name)}</div>
    <div>${escapeHtml(c.unit.subTypeDisplay)} · ${escapeHtml(startWords(c))}</div>
    <div>${escapeHtml(c.building.addr || "")}</div>
    <div><b class="num ${t.cls}">${t.text}</b> added · <b class="num ${d.cls}">${d.text}</b></div>
    <div>Arrive ${escapeHtml(fmtDateTime(c.arrivalAtBuilding, c.building.tz))} ${escapeHtml(tzAbbrev(c.arrivalAtBuilding, c.building.tz))}</div>
    ${c.unit.flags?.length ? `<div class="flags">⚠ ${escapeHtml(flagWords(c.unit))}</div>` : ""}
    <div class="links" style="margin-top:6px">${linksHtml(c)}</div>`;
}

function linksHtml(c) {
  const r = state.route;
  const b = c.building;
  const ll = (p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
  const o = r.places[0], dst = r.places[r.places.length - 1];
  const vias = r.places.slice(1, -1);
  vias.splice(c.legIndex, 0, b);
  const google = `https://www.google.com/maps/dir/?api=1&origin=${ll(o)}&destination=${ll(dst)}&waypoints=${encodeURIComponent(vias.map(ll).join("|"))}&travelmode=driving`;
  const apple1 = `https://maps.apple.com/?saddr=${ll(o)}&daddr=${ll(b)}&dirflg=d`;
  const apple2 = `https://maps.apple.com/?saddr=${ll(b)}&daddr=${ll(dst)}&dirflg=d`;
  return [
    b.url ? `<a href="${escapeAttr(b.url)}" target="_blank" rel="noopener">Official locator page</a>` : "",
    `<a href="${escapeAttr(google)}" target="_blank" rel="noopener">Google Maps (whole trip)</a>`,
    `<a href="${escapeAttr(apple1)}" target="_blank" rel="noopener">Apple Maps to ward</a>`,
    `<a href="${escapeAttr(apple2)}" target="_blank" rel="noopener">then onward</a>`,
  ].filter(Boolean).join("");
}

// ---------------------------------------------------------------- utils

function setStatus(msg, isErr = false) {
  const el = $("status");
  el.textContent = msg;
  el.classList.toggle("err", isErr);
}
function fmtDuration(sec) {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function escapeHtml(s) { return String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])); }
function escapeAttr(s) { return escapeHtml(s); }

// ---------------------------------------------------------------- boot

function boot() {
  $("departure").value = initialDepartureLocal();
  $("departure").addEventListener("change", () => saveDeparture($("departure").value));
  initMap();
  bindTabs();
  bindFilters();
  attachSuggest($("origin"), $("origin-suggest"), (p) => { state.places.origin = p; });
  attachSuggest($("destination"), $("destination-suggest"), (p) => { state.places.destination = p; });
  $("add-waypoint").addEventListener("click", () => { addWaypointRow(); saveRouteInput(); });
  $("use-location").addEventListener("click", useMyLocation);
  $("link").addEventListener("input", saveRouteInput);
  $("traffic-h").addEventListener("change", saveRouteInput);
  $("traffic-m").addEventListener("change", saveRouteInput);
  restoreRouteInput();
  $("go").addEventListener("click", go);
  document.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.tagName === "INPUT" && e.target.type !== "text") go(); });
  loadDataset();
}

boot();
