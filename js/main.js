// UI wiring. State lives here; the finder, providers and routing are pure-ish
// modules that know nothing about the DOM.

import { DEFAULT_FILTERS, findCandidates, reapply } from "./finder.js";
import { debounce, geocodeOne, reverse, suggest } from "./geocode.js";
import { isUnresolvableName, looksLikeXlsx, parseAbrpXlsx } from "./abrp.js";
import { bufferBbox, haversineMi, tilesForBbox } from "./geo.js";
import { defaultDwellMinutes, fromPlaces, fromTrackFile, looksLikeAbrpFile, parseLink } from "./providers.js";
import { applyDwell, dwellBefore, matrix, routePlaces } from "./routing.js";
import { decodeShare, sharePayloadFrom, shareUrl } from "./share.js";
import { defaultDepartureLocal, fmtDateTime, fmtHHMM, fmtTime, instantFromWallClock, toDatetimeLocal, tzAbbrev, wallClockValue } from "./tz.js";

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
  planLegs: null,        // per-leg ABRP times for the route being searched, else null
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
  try { localStorage.setItem(ROUTE_INPUT_KEY, JSON.stringify(routeSnapshot())); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- sharing

// Everything needed to reproduce this plan on another device.
function sharePlan() {
  const r = routeSnapshot();
  return {
    departure: $("departure").value,
    route: {
      stops: r.stops,
      trafficH: r.trafficH, trafficM: r.trafficM, trafficIncludesStops: r.trafficIncludesStops,
    },
    filters: state.filters,
  };
}

async function shareCurrentPlan() {
  const base = `${location.origin}${location.pathname}`;
  const url = shareUrl(base, sharePlan());
  const title = "Sabbath Stop plan";
  if (navigator.share) {
    try { await navigator.share({ title, url }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  try {
    await navigator.clipboard.writeText(url);
    setStatus("Link copied. Anyone who opens it sees this plan and its results.");
  } catch {
    // Clipboard blocked: put the link in a selectable box instead.
    // No focus()/select(): selecting a long value scrolls the panel sideways.
    const box = $("share-url");
    box.value = url;
    box.hidden = false;
    box.scrollLeft = 0;
    document.querySelector(".panel").scrollLeft = 0;
    setStatus("Copy the link below.");
  }
}

// A shared link fills the form, applies the filters, and runs the search.
// Returns true when a plan was applied.
function applySharedPlan() {
  const payload = sharePayloadFrom(location.hash);
  if (!payload) return false;
  let plan;
  try { plan = decodeShare(payload); } catch { setStatus("That share link couldn't be read.", true); return false; }
  if (plan.filters) { state.filters = { ...DEFAULT_FILTERS, ...plan.filters }; saveFilters(); }
  if (plan.departure) { $("departure").value = plan.departure; saveDeparture(plan.departure); }
  if (plan.route) { applyRouteSnapshot({ mode: "ab", ...plan.route }); saveRouteInput(); }
  // Drop the fragment so later edits and reloads use the saved state, not the link.
  history.replaceState(null, "", location.pathname + location.search);
  setStatus("Plan loaded from a shared link.");
  return true;
}
// The route part of the form as a plain object (what gets saved and shared).
function routeSnapshot() {
  return {
    mode: state.routeMode,
    stops: stopEntries().map((e) => ({ id: e.id, text: e.text, place: e.place, dwellMin: e.dwellMin || 0, legToNext: e.legToNext || null })),
    link: $("link").value,
    trafficH: $("traffic-h").value,
    trafficM: $("traffic-m").value,
    trafficIncludesStops: $("traffic-includes-stops").checked,
  };
}

function restoreRouteInput() {
  let snap = null;
  try { snap = JSON.parse(localStorage.getItem(ROUTE_INPUT_KEY) || "null"); } catch { /* ignore */ }
  if (!snap) return;
  applyRouteSnapshot(snap);
}

// Accepts the current shape ({stops}) and the older one ({origin, waypoints,
// destination}) so saved state and old share links keep working.
function applyRouteSnapshot(snap) {
  let stops;
  if (Array.isArray(snap.stops)) {
    stops = snap.stops.map((e) => ({ id: e.id, text: e.text || "", place: e.place || null, dwellMin: parseFloat(e.dwellMin) || 0, legToNext: e.legToNext || null }));
  } else {
    stops = [
      { text: snap.originText || "", place: snap.origin || null, dwellMin: 0 },
      ...(snap.waypoints || []).map((w) => ({ text: w.text || "", place: w.place || null, dwellMin: parseFloat(w.dwellMin) || 0 })),
      { text: snap.destinationText || "", place: snap.destination || null, dwellMin: 0 },
    ];
    // Older saves kept per-leg ABRP times as one array in route order.
    if (Array.isArray(snap.planLegSeconds) && snap.planLegSeconds.length === stops.length - 1) {
      stops.forEach((e, i) => { e.id = newId(); });
      stops.forEach((e, i) => { if (i < stops.length - 1 && snap.planLegSeconds[i] != null) e.legToNext = { to: stops[i + 1].id, seconds: snap.planLegSeconds[i] }; });
    }
  }
  renderStopRows(stops);
  $("link").value = snap.link || "";
  $("traffic-h").value = snap.trafficH || "";
  $("traffic-m").value = snap.trafficM || "";
  $("traffic-includes-stops").checked = !!snap.trafficIncludesStops;
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

// Push the filter values into their inputs (on boot and when a shared plan lands).
function syncFilterInputs() {
  const f = state.filters;
  $("max-detour").value = f.maxDetourMin;
  $("window-min").value = f.windowMin;
  $("window-max").value = f.windowMax;
  $("wide").checked = f.wide;
  $("wide-hours").value = f.wideHours;
  $("show-flagged").checked = !!f.showFlagged;
  $("hide-misses").checked = f.hideMissesOnMap !== false;
  $("sort").value = f.sort;
  $("window-row").style.opacity = f.wide ? 0.5 : 1;
}

function bindFilters() {
  const f = state.filters;
  syncFilterInputs();

  const onChange = () => {
    f.maxDetourMin = clamp(parseFloat($("max-detour").value) || 10, 1, 120);
    f.windowMin = parseFloat($("window-min").value);
    f.windowMax = parseFloat($("window-max").value);
    if (!(f.windowMin <= f.windowMax)) { f.windowMax = f.windowMin; $("window-max").value = f.windowMax; }
    f.wide = $("wide").checked;
    f.wideHours = clamp(parseFloat($("wide-hours").value) || 2, 0.5, 6);
    f.showFlagged = $("show-flagged").checked;
    f.hideMissesOnMap = $("hide-misses").checked;
    f.sort = $("sort").value;
    $("window-row").style.opacity = f.wide ? 0.5 : 1;
    saveFilters();
    // Live re-apply without re-routing. Showing flagged units or raising max
    // detour can add candidates that were never timed; that needs a fresh search.
    if (state.candidates.length) render();
  };
  for (const id of ["window-min", "window-max", "wide", "wide-hours", "show-flagged", "hide-misses", "sort", "max-detour"]) {
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

// ---------------------------------------------------------------- the stop list
//
// One ordered list of rows: the first is the start, the last the end, the
// rest are stops. Every row is the same component; its role (placeholder,
// location button, minutes box, remove button) is derived from position, so
// dragging any row anywhere just works. Each row carries its entry
// { text, place, dwellMin }; the DOM order is the route order.

function stopRows() { return [...$("stops").querySelectorAll(".stop-row")]; }
function stopEntries() { return stopRows().map((r) => r._entry); }

function newId() { return Math.random().toString(36).slice(2, 10); }

function renderStopRows(entries) {
  const list = (entries || []).map((e) => ({ id: e.id || newId(), text: e.text || "", place: e.place || null, dwellMin: e.dwellMin || 0, legToNext: e.legToNext || null }));
  while (list.length < 2) list.push({ id: newId(), text: "", place: null, dwellMin: 0, legToNext: null });
  $("stops").innerHTML = "";
  for (const e of list) $("stops").appendChild(makeStopRow(e));
  refreshStopRoles();
}

function addStopRow() {
  const rows = stopRows();
  const row = makeStopRow({ id: newId(), text: "", place: null, dwellMin: 0, legToNext: null });
  $("stops").insertBefore(row, rows[rows.length - 1]); // before the end
  refreshStopRoles();
  row.querySelector("input.place").focus();
  saveRouteInput();
}

function makeStopRow(entry) {
  const row = document.createElement("div");
  row.className = "stop-row";
  row._entry = entry;
  row.innerHTML = `
    <span class="gutter" tabindex="0" role="button" title="Drag to reorder (or use the arrow keys)" aria-label="Reorder"><span class="glyph"></span></span>
    <div class="suggest">
      <div class="row tight">
        <input type="text" class="place" autocomplete="off">
        <button class="btn icon locate" type="button" title="Use my location" aria-label="Use my location">◎</button>
        <input type="number" class="dwell" min="0" max="600" step="5" placeholder="0" inputmode="numeric" title="Minutes at this stop" aria-label="Minutes at this stop"><span class="unit">min</span>
        <button class="btn icon remove" type="button" title="Remove" aria-label="Remove stop">×</button>
      </div>
      <ul hidden></ul>
    </div>`;
  const input = row.querySelector("input.place"), list = row.querySelector("ul"), dwell = row.querySelector("input.dwell");
  input.value = entry.text || (entry.place ? entry.place.name : "");
  if (entry.dwellMin) dwell.value = entry.dwellMin;
  attachSuggest(input, list, (p) => {
    entry.place = p;
    if (p) entry.text = p.name;
    if (row === stopRows()[0]) updateDepartureZoneNote();
  });
  input.addEventListener("input", () => { entry.text = input.value; });
  dwell.addEventListener("change", () => { entry.dwellMin = Math.max(0, parseFloat(dwell.value) || 0); saveRouteInput(); });
  row.querySelector("button.remove").addEventListener("click", () => {
    if (stopRows().length <= 2) return;
    row.remove(); refreshStopRoles(); saveRouteInput(); updateDepartureZoneNote();
  });
  row.querySelector("button.locate").addEventListener("click", useMyLocation);
  attachDragHandle(row, row.querySelector(".gutter"));
  return row;
}

// Placeholder and controls follow position: only the first row gets the
// location button, only middle rows get minutes and remove.
function refreshStopRoles() {
  const rows = stopRows();
  rows.forEach((row, i) => {
    const role = i === 0 ? "start" : i === rows.length - 1 ? "end" : "via";
    row.dataset.role = role;
    row.querySelector("input.place").placeholder = role === "start" ? "Start" : role === "end" ? "Destination" : "Stop";
  });
}

// Route order is the rows' DOM order, so reordering is moving the row.
// Pointer events rather than HTML drag-and-drop, which iOS Safari lacks.
// The lifted row follows the pointer; the DOM reorders as it crosses the
// midpoint of a neighbour, and the transform is re-based so it doesn't jump.
function attachDragHandle(row, handle) {
  const wrap = $("stops");
  const finish = () => { refreshStopRoles(); saveRouteInput(); updateDepartureZoneNote(); };
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    row.classList.add("dragging");
    let translate = 0;
    const naturalTop = () => row.getBoundingClientRect().top - translate;
    const grabOffset = e.clientY - naturalTop();
    const setTranslate = (v) => { translate = v; row.style.transform = `translateY(${v}px)`; };
    const move = (ev) => {
      setTranslate(ev.clientY - grabOffset - naturalTop());
      for (const other of wrap.querySelectorAll(".stop-row")) {
        if (other === row) continue;
        const r = other.getBoundingClientRect();
        const mid = r.top + r.height / 2;
        const otherIsBelow = !!(row.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING);
        if (otherIsBelow && ev.clientY > mid) wrap.insertBefore(other, row);
        else if (!otherIsBelow && ev.clientY < mid) wrap.insertBefore(row, other);
        else continue;
        setTranslate(ev.clientY - grabOffset - naturalTop());
        refreshStopRoles();
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      row.classList.remove("dragging");
      row.style.transform = "";
      finish();
    };
    // Window listeners: moving the row in the DOM can drop pointer capture,
    // and the pointer is rarely over the handle on release.
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  });
  handle.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const sib = e.key === "ArrowUp" ? row.previousElementSibling : row.nextElementSibling;
    if (!sib) return;
    if (e.key === "ArrowUp") wrap.insertBefore(row, sib); else wrap.insertBefore(sib, row);
    handle.focus();
    finish();
  });
}

async function useMyLocation() {
  const btn = stopRows()[0].querySelector("button.locate");
  if (!navigator.geolocation) return setStatus("Geolocation isn't available in this browser.", true);
  if (!window.isSecureContext) return setStatus("Location needs HTTPS or localhost. Type your origin instead.", true);
  btn.disabled = true;
  setStatus("Getting your location…");
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { longitude: lng, latitude: lat } = pos.coords;
      const first = stopRows()[0];
      let p;
      try { p = await reverse(lng, lat); setStatus(`Starting from ${p.name}`); }
      catch { p = { name: `${lat.toFixed(4)}, ${lng.toFixed(4)}`, lng, lat }; setStatus(""); }
      first._entry.place = p;
      first._entry.text = p.name;
      first.querySelector("input.place").value = p.name;
      saveRouteInput();
      updateDepartureZoneNote();
      btn.disabled = false;
    },
    (err) => { setStatus(`Couldn't get your location (${err.message}). Type it instead.`, true); btn.disabled = false; },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
  );
}

// The picker holds a wall-clock time. It means that time at the ORIGIN: the
// same as the device's clock when you start from where you are, but a trip
// planned from Utah that starts in California leaves at 8:00 Pacific.
function readDeparture(originTz) {
  const v = $("departure").value;
  const tz = originTz || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const d = v ? instantFromWallClock(v, tz) : null;
  if (!d || Number.isNaN(d.getTime())) throw new Error("Pick a departure date and time.");
  return d;
}

// The origin as a place with coordinates: the picked place, or the typed text
// geocoded now (once), so its zone is known before the departure is read.
async function resolveOrigin() {
  const first = stopEntries()[0];
  if (first && first.place && typeof first.place.lng === "number") return first.place;
  const text = (first && first.text || "").trim();
  if (!text) return null;
  const hit = await geocodeOne(text);
  return { ...hit, name: text };
}

// Note under the picker when the origin's zone differs from the device's.
async function updateDepartureZoneNote() {
  const el = $("departure-tz");
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const first = stopEntries()[0];
  const o = first && first.place;
  if (!o || typeof o.lng !== "number") { el.hidden = true; return; }
  const tz = await tzAt(o.lng, o.lat);
  if (tz === localTz) { el.hidden = true; return; }
  const now = new Date();
  el.textContent = `Departure is read in the starting point's zone: ${tzAbbrev(now, tz)} (your device is on ${tzAbbrev(now, localTz)}).`;
  el.hidden = false;
}

// A pasted link is an importer, not a route mode: it fills the A -> B fields
// and switches to that tab, so there is one place the route comes from.
// Returns true when the origin is still being resolved (geolocation).
async function importLink() {
  const url = $("link").value.trim();
  if (!url) throw new Error("Paste a directions link.");
  if (looksLikeAbrpFile(url)) {
    setStatus("Fetching the ABRP export…");
    setLinkBusy(true);
    try {
      let resp;
      try { resp = await fetch(url); } catch { throw new Error("Couldn't download the ABRP export. Download it yourself and use the File / ABRP tab."); }
      if (!resp.ok) throw new Error(`ABRP returned HTTP ${resp.status} for that export link.`);
      return await importAbrp(await resp.arrayBuffer());
    } finally { setLinkBusy(false); }
  }
  const { places, departure } = parseLink(url);

  return fillForm(places, places.slice(1, -1).map((p) => defaultDwellMinutes(p) || ""), departure, "link");
}

// Empty every route input: from, stops, to, the pasted link, the chosen file,
// the drive-time override and any per-leg times from an export.
function clearRouteInputs() {
  renderStopRows([]);
  $("link").value = "";
  $("file").value = "";
  $("traffic-h").value = "";
  $("traffic-m").value = "";
  $("traffic-includes-stops").checked = false;
  showFieldError("link-error", "");
  showFieldError("file-error", "");
  clearResults();
  if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
  saveRouteInput();
  updateDepartureZoneNote();
  setStatus("Route cleared.");
}

// Put a list of places into the A -> B form. places[0] / last may be null
// (unknown start / end). dwellMins lines up with the intermediate stops.
function fillForm(places, dwellMins, departure, sourceWord) {
  renderStopRows(places.map((p, i) => {
    const isEnd = i === 0 || i === places.length - 1;
    const picked = p && typeof p.lng === "number" ? p : null;
    return { text: p ? (picked ? p.name : p.query || p.name) : "", place: picked, dwellMin: isEnd ? 0 : parseFloat(dwellMins[i - 1]) || 0 };
  }));
  if (departure) {
    // An absolute instant from a link: show it as wall-clock time at the
    // origin when the origin's zone is known, else in the device's zone.
    const o = places[0];
    const setPicker = (tz) => { $("departure").value = tz ? wallClockValue(departure, tz) : toDatetimeLocal(departure); saveDeparture($("departure").value); };
    if (o && typeof o.lng === "number") tzAt(o.lng, o.lat).then(setPicker);
    else setPicker(null);
  }
  selectTab("ab");
  saveRouteInput();
  updateDepartureZoneNote();

  const notes = [];
  if (departure) notes.push(`departure taken from the ${sourceWord}`);
  if (!places[0]) { notes.push(`no usable start in the ${sourceWord}, using your location`); useMyLocation(); }
  if (!places[places.length - 1]) notes.push(`the ${sourceWord} doesn't say where the trip ends; type the destination`);
  setStatus(`Imported ${places.length} places${notes.length ? ` (${notes.join("; ")})` : ""}.`);
  return !places[0]; // true when the origin is still being resolved
}

// ABRP "Export to Excel": names, charge times and per-leg drive times, but no
// coordinates. Stops go in as text for Photon to resolve; charge time becomes
// dwell; the per-leg times replace the router's once the route is built.
async function importAbrp(fileOrBuffer) {
  const buf = fileOrBuffer instanceof ArrayBuffer ? fileOrBuffer : await fileOrBuffer.arrayBuffer();
  const plan = await parseAbrpXlsx(buf);
  const places = plan.stops.map((s) => (isUnresolvableName(s.rawName) ? null : { query: s.name, name: s.name }));
  const dwellMins = plan.stops.slice(1, -1).map((s) => (s.dwellSeconds ? Math.round(s.dwellSeconds / 60) : ""));
  // ABRP gives a wall-clock departure at the origin but no date. Put that
  // clock straight into the picker on the date already there; the picker is
  // read in the origin's zone, which is exactly what ABRP meant.
  const waiting = fillForm(places, dwellMins, null, "ABRP export");
  const dep = plan.stops[0].departureMin;
  if (dep !== null) {
    const date = ($("departure").value || toDatetimeLocal(new Date())).slice(0, 10);
    const pad = (n) => String(n).padStart(2, "0");
    $("departure").value = `${date}T${pad(Math.floor(dep / 60))}:${pad(dep % 60)}`;
    saveDeparture($("departure").value);
    setStatus(`${$("status").textContent} Departure ${fmtClock(dep)} taken from the ABRP export.`);
  }
  // Each ABRP leg time rides with the pair of stops it belongs to, so it
  // survives reordering and applies again whenever that pair is adjacent.
  const entries = stopEntries();
  plan.stops.forEach((s, i) => {
    if (i < entries.length - 1 && s.driveSecondsToNext != null) entries[i].legToNext = { to: entries[i + 1].id, seconds: s.driveSecondsToNext };
  });
  saveRouteInput();
  renderPlanSummary(plan);
  return waiting;
}

// Straight from the sheet, shown the moment an ABRP plan is imported, before
// anything is routed. Replaced by the routed summary after Find wards.
function renderPlanSummary(plan) {
  const dwell = plan.stops.reduce((a, s) => a + (s.dwellSeconds || 0), 0);
  const drive = plan.totalDriveSeconds ?? plan.stops.reduce((a, s) => a + (s.driveSecondsToNext || 0), 0);
  const total = plan.totalSeconds ?? drive + dwell;
  const parts = ["ABRP plan"];
  if (plan.totalMiles) parts.push(`${plan.totalMiles.toFixed(0)} mi`);
  parts.push(`${fmtDuration(drive)} driving`);
  if (dwell) parts.push(`${fmtDuration(dwell)} at stops`, `${fmtDuration(total)} total`);
  const first = plan.stops[0], last = plan.stops[plan.stops.length - 1];
  if (first.departureMin !== null && last.arrivalMin !== null) parts.push(`${fmtClock(first.departureMin)} → ${fmtClock(last.arrivalMin)} (ABRP's times, local at each stop)`);
  const el = $("route-summary");
  el.textContent = parts.join(" · ");
  el.hidden = false;
  renderItinerary(plan.stops.map((s) => ({
    name: s.name,
    arrive: s.arrivalMin === null ? null : fmtClock(s.arrivalMin),
    depart: s.departureMin === null ? null : fmtClock(s.departureMin),
    dwellSeconds: s.dwellSeconds,
  })));
}

function fmtClock(minutes) {
  const h = Math.floor(minutes / 60) % 24, m = minutes % 60;
  const ampm = h >= 12 ? "PM" : "AM";
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${ampm}`;
}

// One line per place: name on the left, arrive / depart on the right.
function renderItinerary(rows) {
  const ol = $("itinerary");
  ol.innerHTML = rows.map((r, i) => {
    const isFirst = i === 0, isLast = i === rows.length - 1;
    let times;
    if (isFirst) times = r.depart ? `depart <b>${escapeHtml(r.depart)}</b>` : "";
    else if (isLast) times = r.arrive ? `arrive <b>${escapeHtml(r.arrive)}</b>` : "";
    else {
      const stay = r.dwellSeconds ? ` (${Math.round(r.dwellSeconds / 60)} min)` : "";
      times = `${r.arrive ? `<b>${escapeHtml(r.arrive)}</b>` : "?"} → ${r.depart ? `<b>${escapeHtml(r.depart)}</b>` : "?"}${stay}`;
    }
    if (r.tag) times += `<span class="tz">${escapeHtml(r.tag)}</span>`;
    return `<li><span class="place" title="${escapeAttr(r.name)}">${escapeHtml(r.name)}</span><span class="times">${times}</span></li>`;
  }).join("");
  ol.hidden = rows.length === 0;
}

// Itinerary from the routed times: arrival at place k is departure plus the
// (scaled) legs before it plus the dwell at the stops already passed. Each
// row is in that place's own zone, tagged when it differs from the browser's.
function itineraryFromRoute(route, zones, localTz) {
  const t0 = route.departure.getTime();
  let drive = 0;
  return route.places.map((p, k) => {
    const tz = zones[k] || localTz;
    if (k > 0) drive += route.legSeconds[k - 1] || 0;
    const dwellPassed = k > 0 ? dwellBefore(route.places, k - 1) : 0;
    const arrive = new Date(t0 + (drive + dwellPassed) * 1000);
    const dwell = k > 0 && k < route.places.length - 1 ? p.dwellSeconds || 0 : 0;
    const depart = new Date(arrive.getTime() + dwell * 1000);
    const tag = tz !== localTz ? ` ${tzAbbrev(arrive, tz)}` : "";
    return { name: p.name, arrive: fmtTime(arrive, tz), depart: fmtTime(depart, tz), dwellSeconds: dwell, tag };
  });
}

function selectTab(name) {
  const btn = document.querySelector(`[role="tab"][data-tab="${name}"]`);
  if (btn) btn.click();
}

async function buildRoute() {
  const mode = state.routeMode;
  if (mode === "link") {
    let waitingForLocation;
    try { waitingForLocation = await importLink(); showFieldError("link-error", ""); }
    catch (e) { showFieldError("link-error", e.message); throw e; }
    if (waitingForLocation) throw new Error("Getting your location for the start. Press Find wards again once it shows in the From field.");
    return buildRoute();
  }
  if (mode === "file") {
    const f = $("file").files[0];
    if (!f) throw new Error("Choose an ABRP export, GPX, or KML file.");
    try {
      if (looksLikeXlsx(f.name, await f.slice(0, 4).arrayBuffer())) {
        const waiting = await importAbrp(f);
        if (waiting) throw new Error("Getting your location for the start. Press Find wards again once it shows in the From field.");
        return buildRoute();
      }
      // A track file's own timestamps win when it has them; otherwise the
      // picker is read in the device's zone since the file has no origin yet.
      return await fromTrackFile(await f.text(), f.name, readDeparture());
    } catch (e) { showFieldError("file-error", e.message); throw e; }
  }
  const o = await resolveOrigin();
  const entries = stopEntries();
  const last = entries[entries.length - 1];
  const d = last && (last.place && typeof last.place.lng === "number" ? last.place : last.text.trim() ? { query: last.text.trim(), name: last.text.trim() } : null);
  if (!o || !d) throw new Error("Enter where you're starting and where you're going.");
  const originTz = await tzAt(o.lng, o.lat);
  const departure = readDeparture(originTz);
  // Middle rows are stops: a picked place if there is one, otherwise the
  // typed text to geocode on submit. Minutes count only on middle rows.
  const vias = [];
  const used = [entries[0]];
  for (const e of entries.slice(1, -1)) {
    const place = e.place && typeof e.place.lng === "number" ? e.place : e.text.trim() ? { query: e.text.trim(), name: e.text.trim() } : null;
    if (!place) continue;
    vias.push({ ...place, dwellSeconds: (e.dwellMin || 0) * 60 });
    used.push(e);
  }
  used.push(last);
  // ABRP leg times apply wherever the pair they belong to is still adjacent.
  const planLegs = used.slice(0, -1).map((e, i) => (e.legToNext && e.legToNext.to === used[i + 1].id ? e.legToNext.seconds : null));
  state.planLegs = planLegs.some((v) => v != null) ? planLegs : null;
  return fromPlaces([o, ...vias, d], departure);
}

// ---------------------------------------------------------------- traffic

function readTrafficSeconds() {
  const h = parseFloat($("traffic-h").value) || 0;
  const m = parseFloat($("traffic-m").value) || 0;
  const s = h * 3600 + m * 60;
  return s > 0 ? s : null;
}

// The free router has no traffic. Two ways to correct it, in priority order:
//  1. An ABRP export supplied a drive time per leg: scale each leg to match.
//  2. The user typed the time their navigation app predicts: scale the whole
//     route. If that time includes stops (Tesla, ABRP), the dwell is taken
//     out first; Google's times are driving only.
// Dwell at stops is clock time, not driving, and is never scaled. Detour legs
// get the factor of the leg they sit on inside the finder.
function applyTrafficTime(route) {
  route.timeScale = 1; route.legScales = null;
  if (!route.driveSeconds || route.provider === "file") return;

  const plan = state.planLegs;
  if (plan && plan.length === route.legSeconds.length) {
    const scales = plan.map((sec, i) => {
      if (sec == null || !(route.legSeconds[i] > 0)) return 1;
      const k = sec / route.legSeconds[i];
      return k >= 0.4 && k <= 3 ? k : 1;
    });
    if (scales.some((k) => k !== 1)) {
      const legs = route.legSeconds.map((s, i) => s * scales[i]);
      const drive = legs.reduce((a, s) => a + s, 0);
      route.legScales = scales;
      route.timeScale = drive / route.driveSeconds;
      route.totalSeconds = drive + (route.dwellSeconds || 0);
      applyDwell(route.points, route.places, scales);
      route.legSeconds = legs;
      const n = plan.filter((v) => v != null).length;
      route.timingNote = n === plan.length ? "leg times from ABRP" : `${n} of ${plan.length} leg times from ABRP`;
      return;
    }
  }

  let wanted = readTrafficSeconds();
  if (!wanted) return;
  if ($("traffic-includes-stops").checked) wanted -= route.dwellSeconds || 0;
  if (wanted <= 0) { setStatus("That time is shorter than the stops alone; ignoring it.", true); return; }
  const scale = wanted / route.driveSeconds;
  if (scale < 0.5 || scale > 3) { setStatus("That drive time is far from the routed one; ignoring it.", true); return; }
  route.timeScale = scale;
  route.totalSeconds = wanted + (route.dwellSeconds || 0);
  applyDwell(route.points, route.places, scale);
  route.legSeconds = route.legSeconds.map((s) => s * scale);
  route.timingNote = `scaled ×${scale.toFixed(2)} to your Maps time`;
}

// ---------------------------------------------------------------- search

async function go() {
  if (!state.filters.subtypes.length) return setStatus("Pick at least one unit type first.", true);
  const btn = $("go");
  setBusy(btn, true, "Finding…");
  clearResults();
  try {
    setStatus("Routing…");
    const route = await buildRoute();
    if (route.source === "gpx" && route.provider === "file") {
      // The file carried its own timestamps; show the departure in the picker.
      $("departure").value = toDatetimeLocal(route.departure);
      saveDeparture($("departure").value);
    }
    applyTrafficTime(route);
    state.route = route;
    drawRoute(route);
    renderRouteSummary(route);
    setStatus("Finding wards…");
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
    setBusy(btn, false);
  }
}

// The route line persists above the results; the status line is transient.
// Every time is shown in the zone of the place it happens at, with the zone
// abbreviation whenever that differs from the browser's zone.
async function renderRouteSummary(route) {
  const el = $("route-summary");
  const dwell = route.dwellSeconds || 0;
  const arrive = new Date(route.departure.getTime() + route.totalSeconds * 1000);
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zones = await Promise.all(route.places.map((p) => tzAt(p.lng, p.lat)));
  const destTz = zones[zones.length - 1];
  const parts = [
    `${route.totalMiles.toFixed(0)} mi`,
    `${fmtDuration(route.totalSeconds - dwell)} driving`,
  ];
  if (dwell) parts.push(`${fmtDuration(dwell)} at stops`, `${fmtDuration(route.totalSeconds)} total`);
  parts.push(`arrive ${fmtDateTime(arrive, destTz)}${destTz !== localTz ? ` ${tzAbbrev(arrive, destTz)} (local there)` : ""}`);
  if (route.timingNote) parts.push(route.timingNote);
  else if (route.provider === "osrm") parts.push("timed by the OSRM fallback, which runs slow on freeways; enter your Maps time above to correct it");
  el.textContent = parts.join(" · ");
  el.hidden = false;
  renderItinerary(itineraryFromRoute(route, zones, localTz));
}

// ---------------------------------------------------------------- render

let map, routeLayer, clusterOn, clusterOff;

function initMap() {
  map = L.map("map", { zoomControl: true }).setView([39.5, -111.5], 6);
  // OpenStreetMap's standard tiles: keyless, but 256px with no 2x variant, so
  // they look soft on high-DPI phones. CARTO's basemaps now watermark without
  // an API key, so they are not an option. A sharper map means a provider
  // account (Stadia or MapTiler free tiers, domain-restricted rather than a
  // key in the page) or self-hosting; see APP_SPEC on basemaps.
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
  $("route-summary").hidden = true;
  $("itinerary").hidden = true;
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
  // slightly offset, each carrying its own popup. Near misses stay off the
  // map by default; the one that's selected is always shown.
  clusterOn.clearLayers(); clusterOff.clearLayers(); state.markers.clear();
  const perBuilding = new Map();
  for (const c of list) {
    if (!c.passes && state.filters.hideMissesOnMap && c.unit.id !== state.selectedId) continue;
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
  const previous = state.selectedId;
  state.selectedId = id;
  document.querySelectorAll(".result").forEach((li) => li.classList.toggle("selected", li.dataset.id === id));
  const c = state.candidates.find((x) => x.unit.id === id);
  // A hidden near miss gets its pin only while selected: rebuild the markers
  // when the selection moves onto or off one.
  if (state.filters.hideMissesOnMap && c && fromList) {
    const prevC = state.candidates.find((x) => x.unit.id === previous);
    if (!c.passes || (prevC && !prevC.passes)) renderMarkersOnly();
  }
  const m = state.markers.get(id);
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

// Redraw pins without touching the list (used when a selection reveals or
// hides a near miss).
function renderMarkersOnly() {
  const list = reapply(state.candidates, state.filters);
  clusterOn.clearLayers(); clusterOff.clearLayers(); state.markers.clear();
  const perBuilding = new Map();
  for (const c of list) {
    if (!c.passes && state.filters.hideMissesOnMap && c.unit.id !== state.selectedId) continue;
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

function highlight(id, on) {
  const m = state.markers.get(id);
  const c = state.candidates.find((x) => x.unit.id === id);
  if (m && c && id !== state.selectedId) m.setIcon(pinIcon(c.passes, on));
}

function deltaWords(c) {
  if (c.wrongDay) return { text: `no meeting that day (meets ${titleCase(c.meetsOn)})`, cls: "warn" };
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
// Inline error under a specific field; empty message hides it.
function showFieldError(id, msg) {
  const el = $(id);
  el.textContent = msg;
  el.hidden = !msg;
  if (msg) setStatus(msg, true);
}
// Busy state for a button: disabled, spinner, optional label swap.
function setBusy(btn, busy, label) {
  if (busy) {
    btn.dataset.label = btn.dataset.label || btn.textContent;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner" aria-hidden="true"></span> ${escapeHtml(label || btn.dataset.label)}`;
  } else {
    btn.disabled = false;
    btn.textContent = btn.dataset.label || btn.textContent;
  }
}
function setLinkBusy(busy) {
  setBusy($("import-link"), busy, busy ? "Fetching…" : undefined);
}
// Informational hints start hidden behind a small (i) button on the label.
function wireInfoHints() {
  for (const hint of document.querySelectorAll(".hint.info")) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "info-btn";
    btn.textContent = "i";
    btn.setAttribute("aria-label", "More information");
    btn.setAttribute("aria-expanded", "false");
    hint.hidden = true;
    btn.addEventListener("click", () => {
      hint.hidden = !hint.hidden;
      btn.setAttribute("aria-expanded", String(!hint.hidden));
    });
    // The button sits at the right of the field's label; a field with no label
    // (the departure picker) uses the section heading above it.
    const field = hint.closest(".field");
    const label = field && field.querySelector("label");
    const heading = field && !label && field.previousElementSibling && field.previousElementSibling.tagName === "H2"
      ? field.previousElementSibling : null;
    const prev = hint.previousElementSibling;
    let anchor; // the element that carries the (i); the note opens right below it
    if (label) { label.appendChild(btn); anchor = label; }
    else if (heading) { heading.appendChild(btn); anchor = heading; }
    else if (prev && prev.tagName === "H2") { prev.appendChild(btn); anchor = prev; }
    else if (prev && prev.tagName === "BUTTON") { prev.after(btn); anchor = prev; }
    else if (prev && prev.classList.contains("row")) { prev.appendChild(btn); anchor = prev; }
    else { hint.parentNode.insertBefore(btn, hint); anchor = btn; }
    anchor.after(hint);
  }
}
function fmtDuration(sec) {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function titleCase(s) { return String(s || "").toLowerCase().replace(/^\w/, (ch) => ch.toUpperCase()); }

// Time zone at a point, from the nearest building in the local tiles. Falls
// back to the browser's zone when no tile covers the spot.
async function tzAt(lng, lat) {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const keys = tilesForBbox(bufferBbox([lng, lat, lng, lat], 25));
  const tiles = await Promise.all(keys.map((k) => loadTile(k)));
  let best = null, bestMi = Infinity;
  for (const b of tiles.flat().filter(Boolean)) {
    if (!b.tz) continue;
    const mi = haversineMi(lng, lat, b.lng, b.lat);
    if (mi < bestMi) { bestMi = mi; best = b.tz; }
  }
  return best || local;
}
function escapeHtml(s) { return String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])); }
function escapeAttr(s) { return escapeHtml(s); }

// ---------------------------------------------------------------- boot

async function boot() {
  $("departure").value = initialDepartureLocal();
  $("departure").addEventListener("change", () => saveDeparture($("departure").value));
  $("reset-departure").addEventListener("click", () => {
    try { localStorage.removeItem(DEPART_KEY); } catch { /* ignore */ }
    $("departure").value = defaultDepartureLocal();
    setStatus("Departure reset to the default.");
  });
  $("clear-route").addEventListener("click", clearRouteInputs);
  initMap();
  bindTabs();
  bindFilters();
  renderStopRows([]);
  $("add-waypoint").addEventListener("click", addStopRow);
  $("link").addEventListener("input", saveRouteInput);
  // Import as soon as a link lands in the field, whether pasted or typed.
  // Errors show right under the field, where a user on a small screen is looking.
  const tryImport = async () => {
    if (!$("link").value.trim()) { showFieldError("link-error", ""); return; }
    try { await importLink(); showFieldError("link-error", ""); }
    catch (e) { showFieldError("link-error", e.message); }
  };
  $("link").addEventListener("paste", () => setTimeout(tryImport, 0));
  $("link").addEventListener("change", tryImport);
  $("import-link").addEventListener("click", tryImport);
  $("traffic-h").addEventListener("change", saveRouteInput);
  $("traffic-m").addEventListener("change", saveRouteInput);
  $("traffic-includes-stops").addEventListener("change", saveRouteInput);
  // Choosing an ABRP file imports it straight away, like pasting a link.
  $("file").addEventListener("change", async () => {
    const f = $("file").files[0];
    showFieldError("file-error", "");
    if (!f) return;
    try {
      if (looksLikeXlsx(f.name, await f.slice(0, 4).arrayBuffer())) await importAbrp(f);
    } catch (e) { showFieldError("file-error", e.message); }
  });
  const shared = applySharedPlan();
  if (!shared) restoreRouteInput();
  updateDepartureZoneNote();
  wireInfoHints();
  $("share").addEventListener("click", shareCurrentPlan);
  // A share link pasted into an already-open tab only changes the fragment,
  // which never reloads the page: apply it here.
  window.addEventListener("hashchange", () => {
    if (!applySharedPlan()) return;
    syncFilterInputs();
    renderSubtypes();
    updateDepartureZoneNote();
    go();
  });
  // iOS Safari ignores user-scalable=no; block pinch on the panel here. The
  // map keeps its own pinch handling.
  const panel = document.querySelector(".panel");
  for (const ev of ["gesturestart", "gesturechange", "gestureend"]) panel.addEventListener(ev, (e) => e.preventDefault());
  panel.addEventListener("touchmove", (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
  $("go").addEventListener("click", go);
  document.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.tagName === "INPUT" && e.target.type !== "text") go(); });
  await loadDataset();
  // A shared link that carries a complete plan runs itself.
  const ends = stopEntries();
  const filled = (e) => e && (e.place || (e.text || "").trim());
  if (shared && state.filters.subtypes.length && filled(ends[0]) && filled(ends[ends.length - 1])) go();
}

boot();
