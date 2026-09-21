// Service worker: makes the home-screen app open without a connection.
//
// What works offline is what was already fetched: the app shell, the dataset
// tiles a search touched, and the map tiles that were looked at. Routing,
// geocoding and detour timing are network services and are never cached
// here; the page falls back to its saved plan for those.
//
// VERSION must match the ?v= stamp in index.html. Bump both on every deploy:
// the shell cache is named by it, and activating a new version drops the old.
const VERSION = "2026092050";
const SHELL = `ss-shell-${VERSION}`;
const DATA = "ss-data";
const MAP = "ss-map";
const MAP_MAX_ENTRIES = 600;

const SHELL_URLS = [
  "index.html",
  `css/app.css?v=${VERSION}`,
  `js/main.js?v=${VERSION}`,
  ...["abrp", "finder", "geo", "geocode", "plan", "providers", "routing", "share", "tz"].map((m) => `js/${m}.js?v=${VERSION}`),
  "manifest.webmanifest",
  "brand/exit-sign.svg",
  "brand/icon-32.png",
  "brand/icon-192.png",
  "brand/icon-512.png",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/MarkerCluster.css",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/MarkerCluster.Default.css",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/leaflet.markercluster.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(SHELL_URLS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("ss-shell-") && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const isShell = (url) => url.origin === self.location.origin
  ? !url.pathname.includes("/data/")
  : url.hostname === "cdnjs.cloudflare.com";
const isDataTile = (url) => url.origin === self.location.origin && url.pathname.includes("/data/tiles/");
const isDataIndex = (url) => url.origin === self.location.origin && url.pathname.includes("/data/") && !isDataTile(url);
const isMapTile = (url) => url.hostname.endsWith("tile.openstreetmap.org");

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (req.mode === "navigate") event.respondWith(networkFirst(req, SHELL, "index.html"));
  else if (isDataTile(url)) event.respondWith(staleWhileRevalidate(req, DATA));
  else if (isDataIndex(url)) event.respondWith(networkFirst(req, DATA));
  else if (isMapTile(url)) event.respondWith(networkFirst(req, MAP, null, MAP_MAX_ENTRIES));
  else if (isShell(url)) event.respondWith(cacheFirst(req, SHELL));
  // Everything else (routers, geocoder, analytics, ABRP) goes straight to the network.
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const resp = await fetch(req);
  if (resp.ok) cache.put(req, resp.clone());
  return resp;
}

// Fresh when online; the last copy when not. `fallbackKey` is what to serve
// when the request itself was never cached (any navigation gets the shell).
async function networkFirst(req, cacheName, fallbackKey = null, maxEntries = 0) {
  const cache = await caches.open(cacheName);
  try {
    const resp = await fetch(req);
    if (resp.ok) {
      await cache.put(req, resp.clone());
      if (maxEntries) trim(cache, maxEntries);
    }
    return resp;
  } catch (e) {
    const hit = await cache.match(req) || (fallbackKey && await cache.match(fallbackKey));
    if (hit) return hit;
    throw e;
  }
}

// Serve the cached copy at once and refresh it behind the scenes. Dataset
// tiles change once a month, so a stale one is a fine answer.
async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const refresh = fetch(req).then((resp) => { if (resp.ok) cache.put(req, resp.clone()); return resp; }).catch(() => null);
  return hit || (await refresh) || new Response(null, { status: 503, statusText: "offline" });
}

// Map tiles are only ever cached as a side effect of looking at them, which
// is what OpenStreetMap's tile policy allows; keep that cache small.
let trimming = false;
async function trim(cache, maxEntries) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    for (const k of keys.slice(0, Math.max(0, keys.length - maxEntries))) await cache.delete(k);
  } finally { trimming = false; }
}
