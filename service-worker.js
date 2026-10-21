/**
 * SnowF service worker — static-asset caching only.
 *
 * Strategy per request:
 *  - Same-origin GET  → stale-while-revalidate: the cached copy is served
 *    immediately (offline-first) while a background request refreshes the
 *    cache. This means a new release reaches users on their next visit
 *    WITHOUT anyone having to bump a version constant by hand.
 *  - Requests that explicitly opt out of caching (fetch(..., {cache:
 *    'no-cache'})) — e.g. data/resorts.json — go network-first, so a
 *    stale precached copy can never shadow fresh data.
 *  - CDN libraries → stale-while-revalidate (opaque-safe).
 *  - Weather API → NEVER intercepted; freshness is handled by the app's own
 *    cache layer, which flags stored data explicitly.
 */
const VERSION = 'snowf-v3';
const STATIC_CACHE = `${VERSION}-static`;
const CDN_CACHE = `${VERSION}-cdn`;

const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './css/themes.css',
  './css/main.css',
  './css/components.css',
  './data/resorts.json',
  './js/app.js',
  './js/config.js',
  './js/resorts.js',
  './js/api.js',
  './js/cache.js',
  './js/weather.js',
  './js/analysis.js',
  './js/ski-score.js',
  './js/snow-quality.js',
  './js/safety.js',
  './js/recommendation.js',
  './js/comparison.js',
  './js/charts.js',
  './js/ui.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('snowf-') && k !== STATIC_CACHE && k !== CDN_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/** Put a response into a cache without letting a failure break the response. */
function store(cacheName, request, response) {
  try {
    const copy = response.clone();
    caches.open(cacheName).then((cache) => cache.put(request, copy));
  } catch { /* quota / opaque response — ignore */ }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never intercept the weather API — freshness is handled by the app.
  if (url.hostname === 'api.open-meteo.com') return;

  // Local development: act as a pass-through so an edited file is always
  // the file the browser runs. The PWA behaviour is exercised on the real
  // deployment, where the host is not localhost.
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]') {
    return;
  }

  // Same-origin static assets: stale-while-revalidate.
  if (url.origin === self.location.origin) {
    // The caller explicitly asked for a fresh copy → network first.
    const noCache = req.cache === 'no-cache' || req.cache === 'reload' || req.cache === 'no-store';
    if (noCache) {
      event.respondWith(
        fetch(req)
          .then((res) => {
            if (res && res.ok) store(STATIC_CACHE, req, res);
            return res;
          })
          .catch(() => caches.match(req).then((hit) => hit || Response.error()))
      );
      return;
    }
    // Navigation (the HTML shell): network-first with a cache fallback.
    // The shell is tiny, so online visitors always get the current markup
    // immediately instead of a version that is one visit behind; offline
    // visitors still get the cached shell.
    if (req.mode === 'navigate') {
      event.respondWith(
        fetch(req)
          .then((res) => {
            if (res && res.ok) store(STATIC_CACHE, req, res);
            return res;
          })
          .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('./index.html').then((h2) => h2 || Response.error())))
      );
      return;
    }
    event.respondWith(
      caches.match(req).then((hit) => {
        const network = fetch(req)
          .then((res) => {
            if (res && res.ok) store(STATIC_CACHE, req, res);
            return res;
          })
          .catch(() => hit || Response.error());
        return hit || network;
      })
    );
    return;
  }

  // CDN: stale-while-revalidate.
  event.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          if (res && (res.ok || res.type === 'opaque')) store(CDN_CACHE, req, res);
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});
