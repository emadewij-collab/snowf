/**
 * SnowF — Open-Meteo API client.
 *
 *  - Single place where HTTP happens; single place where variable lists live.
 *  - Only requests variables supported by the free forecast endpoint.
 *  - In-flight deduplication: identical concurrent calls share one request.
 *  - Failures never throw uncaught to the UI: callers use allSettled-style
 *    handling and per-station failure is isolated.
 */

import { APP } from './config.js';
import { cacheGet, cacheSet } from './cache.js';

const BASE = 'https://api.open-meteo.com/v1/forecast';

// All supported by the free /v1/forecast endpoint (hourly + daily).
const HOURLY_VARS = [
  'temperature_2m',
  'relative_humidity_2m',
  'dew_point_2m',
  'apparent_temperature',
  'precipitation_probability',
  'precipitation',
  'rain',
  'showers',
  'snowfall',
  'snow_depth',
  'weather_code',
  'pressure_msl',
  'cloud_cover',
  'cloud_cover_low',
  'cloud_cover_mid',
  'cloud_cover_high',
  'visibility',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'cape',
  'lifted_index',
  'convective_inhibition',
  'freezing_level_height',
  'is_day',
];

const DAILY_VARS = [
  'weather_code',
  'temperature_2m_max',
  'temperature_2m_min',
  'apparent_temperature_max',
  'apparent_temperature_min',
  'precipitation_sum',
  'rain_sum',
  'snowfall_sum',
  'precipitation_hours',
  'precipitation_probability_max',
  'wind_speed_10m_max',
  'wind_gusts_10m_max',
  'wind_direction_10m_dominant',
  'sunrise',
  'sunset',
  'uv_index_max',
];

// Road queries are smaller (near-term access estimate only).
const ROAD_HOURLY_VARS = [
  'temperature_2m',
  'relative_humidity_2m',
  'precipitation',
  'snowfall',
  'visibility',
];

const inflight = new Map();

function key(lat, lon, kind) {
  return `${kind}_${Number(lat).toFixed(4)}_${Number(lon).toFixed(4)}`;
}

// ---------------------------------------------------------------------------
// Concurrency limiter: Open-Meteo free tier asks for ~60 calls/min max.
// We fire up to 4 in parallel and serialize the rest.
// ---------------------------------------------------------------------------
const MAX_CONCURRENT = 4;
let active = 0;
const queue = [];
function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    const { run } = queue.shift();
    active += 1;
    run().finally(() => {
      active -= 1;
      pump();
    });
  }
}
function limited(promiseFn) {
  return new Promise((resolve, reject) => {
    queue.push({
      run: () => promiseFn().then(resolve, reject),
    });
    pump();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, timeoutMs = 20000, retry = 1) {
  let lastErr;
  for (let attempt = 0; attempt <= retry; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        clearTimeout(timer);
        if (attempt < retry) {
          await sleep(1500 * (attempt + 1));
          continue;
        }
        throw lastErr;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      clearTimeout(timer);
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < retry && (e.name === 'AbortError' || e instanceof TypeError)) {
        await sleep(1200 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/**
 * Fetch (or reuse cached) full forecast for one point.
 * @returns {Promise<{ data, updatedAt, stale, fromCache }>} — rejects only
 *   when there is NO usable data at all (no network + no cache).
 */
export function getForecast(lat, lon, { force = false } = {}) {
  const k = key(lat, lon, 'wx');
  if (!force) {
    const c = cacheGet(k);
    if (c.hit && !c.stale) return Promise.resolve({ data: c.data, updatedAt: c.updatedAt, stale: false, fromCache: true });
  }
  if (inflight.has(k)) return inflight.get(k);

  const url =
    `${BASE}?latitude=${lat}&longitude=${lon}` +
    `&hourly=${HOURLY_VARS.join(',')}&daily=${DAILY_VARS.join(',')}` +
    `&forecast_days=${APP.forecastDays}&timezone=${encodeURIComponent(APP.timezone)}`;

  const p = (async () => {
    try {
      const data = await limited(() => fetchJson(url));
      if (!data || !data.hourly || !data.daily) throw new Error('bad-payload');
      const updatedAt = Date.now();
      cacheSet(k, data, updatedAt);
      return { data, updatedAt, stale: false, fromCache: false };
    } catch (err) {
      const c = cacheGet(k);
      if (c.hit) return { data: c.data, updatedAt: c.updatedAt, stale: true, fromCache: true };
      throw err;
    } finally {
      inflight.delete(k);
    }
  })();
  inflight.set(k, p);
  return p;
}

/** Smaller query for road/access weather estimates. */
export function getRoadForecast(lat, lon, { force = false } = {}) {
  const k = key(lat, lon, 'road');
  if (!force) {
    const c = cacheGet(k);
    if (c.hit && !c.stale) return Promise.resolve({ data: c.data, updatedAt: c.updatedAt, stale: false, fromCache: true });
  }
  if (inflight.has(k)) return inflight.get(k);

  const url =
    `${BASE}?latitude=${lat}&longitude=${lon}` +
    `&hourly=${ROAD_HOURLY_VARS.join(',')}&forecast_days=2&timezone=${encodeURIComponent(APP.timezone)}`;

  const p = (async () => {
    try {
      const data = await limited(() => fetchJson(url));
      if (!data || !data.hourly) throw new Error('bad-payload');
      const updatedAt = Date.now();
      cacheSet(k, data, updatedAt);
      return { data, updatedAt, stale: false, fromCache: false };
    } catch (err) {
      const c = cacheGet(k);
      if (c.hit) return { data: c.data, updatedAt: c.updatedAt, stale: true, fromCache: true };
      throw err;
    } finally {
      inflight.delete(k);
    }
  })();
  inflight.set(k, p);
  return p;
}

/** Friendly Persian message for fetch failures. */
export function apiErrorMessage() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return 'به اینترنت متصل نیستی — آخرین داده ذخیره‌شده نمایش داده می‌شود.';
  }
  return 'دریافت اطلاعات هواشناسی ناموفق بود.';
}
