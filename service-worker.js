/**
 * SnowF service worker — static-asset caching only.
 *
 *  - Same-origin GET (html/css/js/json/icons): cache-first, then network.
 *  - CDN libraries: stale-while-revalidate (opaque-safe).
 *  - Weather API: NEVER cached here (the app's own cache layer handles
 *    freshness + explicit "stored data" flags).
 */
const VERSION = 'snowf-v3-0-0';
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

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never intercept the weather API — freshness is handled by the app.
  if (url.hostname === 'api.open-meteo.com') return;

  // Same-origin static assets: cache-first.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req, { ignoreSearch: false }).then((hit) => {
        if (hit) return hit;
        return fetch(req).then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(STATIC_CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        });
      })
    );
    return;
  }

  // CDN: stale-while-revalidate.
  event.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          if (res && (res.ok || res.type === 'opaque')) {
            const copy = res.clone();
            caches.open(CDN_CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});
