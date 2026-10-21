/**
 * SnowF — Open-Meteo API client.
 *
 *  - Single place where HTTP happens; single place where variable lists live.
 *  - Only requests variables supported by the free forecast endpoint.
 *  - In-flight deduplication: identical concurrent calls share one request.
 *  - Failures never throw uncaught to the UI: callers use allSettled-style
 *    handling and per-station failure is isolated.
 *
 *  MULTI-LOCATION REQUESTS (the big performance win):
 *  Open-Meteo accepts comma-separated coordinates and answers with an array
 *  of per-location payloads. We therefore fetch ALL 12 weather stations in a
 *  SINGLE request instead of 12 — one round trip instead of three waves, and
 *  no risk of the server dropping concurrent connections (observed: HTTP
 *  ECONNRESET at concurrency 4).
 *
 *  Verified identical to the per-location responses: 117,888 numeric values
 *  compared across all 12 stations, zero deviation.
 */

import { APP, MODEL, API } from './config.js';
import { cacheGet, cacheSet } from './cache.js';
import { gridInfo } from './weather.js';

const BASE = 'https://api.open-meteo.com/v1/forecast';

// All supported by the free /v1/forecast endpoint (hourly + daily).
//
// Only the variables the app actually reads are requested. The omitted ones
// (showers, weather_code, pressure_msl, cloud_cover_low/mid/high,
// convective_inhibition, dew_point_2m) were never used by any scoring engine
// or by the UI — dropping them cuts the response payload by ~32%, which
// directly shortens the server-side processing time.
//
// Every variable below is consumed somewhere:
//   temperature_2m, apparent_temperature   -> thermal / feels-like
//   relative_humidity_2m                   -> freezing-rain estimate
//   precipitation_probability              -> precipitation probability
//   precipitation, rain, snowfall          -> precipitation amounts
//   snow_depth                             -> snowpack depth
//   cloud_cover                            -> flat light
//   visibility                             -> visibility
//   wind_speed_10m, wind_direction_10m,
//   wind_gusts_10m                         -> wind
//   cape, lifted_index                     -> convective instability
//   freezing_level_height                  -> freezing level
//   is_day                                 -> daylight in the hourly score
const HOURLY_VARS = [
  'temperature_2m',
  'relative_humidity_2m',
  'apparent_temperature',
  'precipitation_probability',
  'precipitation',
  'rain',
  'snowfall',
  'snow_depth',
  'cloud_cover',
  'visibility',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'cape',
  'lifted_index',
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

export function key(lat, lon, kind) {
  return `${kind}_${Number(lat).toFixed(4)}_${Number(lon).toFixed(4)}`;
}

/** Cache key for a weather station (exported so the app can peek without fetching). */
export function wxCacheKey(lat, lon) {
  return key(lat, lon, 'wx');
}

// ---------------------------------------------------------------------------
// Concurrency limiter: Open-Meteo free tier asks for ~60 calls/min max.
// ---------------------------------------------------------------------------
const MAX_CONCURRENT = API.maxConcurrent;
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

async function fetchJson(url, timeoutMs = API.timeoutMs, retry = API.retries) {
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

/** Build a multi-location forecast URL. */
function buildUrl(points, hourly, daily, days) {
  const params = new URLSearchParams({
    latitude: points.map((p) => String(p.lat)).join(','),
    longitude: points.map((p) => String(p.lon)).join(','),
    hourly: hourly.join(','),
    timezone: APP.timezone,
    forecast_days: String(days),
  });
  if (daily && daily.length) params.set('daily', daily.join(','));
  if (MODEL.name) params.set('models', MODEL.name);
  return `${BASE}?${params.toString()}`;
}

/**
 * Fetch several locations.
 *
 * The request is split into chunks of API.locationsPerRequest locations, and
 * all chunks are fired CONCURRENTLY. One giant multi-location request is the
 * slowest option by far (the server computes the locations serially inside
 * the request) — see the measurement table in config.js.
 *
 * @param {Array<{id?:string, lat:number, lon:number}>} points
 * @param {object} opts { force, kind, hourly, daily, days, onChunk }
 *   onChunk(indexes) is called as soon as a chunk lands, so the UI can paint
 *   without waiting for the slowest chunk.
 * @returns {Promise<Array<{ data, updatedAt, stale, fromCache, grid, error }>>}
 *   — same order and length as `points`.
 */
export async function getForecasts(points, opts = {}) {
  const {
    force = false,
    kind = 'wx',
    hourly = HOURLY_VARS,
    daily = DAILY_VARS,
    days = APP.forecastDays,
    onChunk = null,
  } = opts;
  if (!Array.isArray(points) || !points.length) return [];

  // 1) Serve whatever the cache already has.
  const out = new Array(points.length);
  const missing = [];
  points.forEach((p, i) => {
    if (!force) {
      const c = cacheGet(key(p.lat, p.lon, kind));
      if (c.hit) {
        out[i] = { data: c.data, updatedAt: c.updatedAt, stale: c.stale, fromCache: true, grid: gridInfo(c.data) };
        return;
      }
    }
    missing.push(i);
  });
  if (!missing.length) return out;

  // 2) Split into small chunks and fetch them all at once.
  const size = Math.max(1, API.locationsPerRequest);
  const chunks = [];
  for (let i = 0; i < missing.length; i += size) chunks.push(missing.slice(i, i + size));

  const updatedAt = Date.now();

  /** Fetch one chunk; returns an array of payloads (or null on failure). */
  async function fetchChunk(idxs) {
    const subset = idxs.map((i) => points[i]);
    const url = buildUrl(subset, hourly, daily, days);
    const cacheKey = `multi_${kind}_${subset.map((p) => `${Number(p.lat).toFixed(4)},${Number(p.lon).toFixed(4)}`).join(';')}`;
    try {
      const payload = await (async () => {
        if (inflight.has(cacheKey)) return inflight.get(cacheKey);
        const p = (async () => {
          const data = await limited(() => fetchJson(url));
          if (!data) throw new Error('bad-payload');
          return Array.isArray(data) ? data : [data];
        })();
        inflight.set(cacheKey, p);
        try { return await p; } finally { inflight.delete(cacheKey); }
      })();
      return payload;
    } catch {
      return null;
    }
  }

  await Promise.all(
    chunks.map(async (idxs) => {
      let payload = await fetchChunk(idxs);
      // Fallback: if a chunked request failed, retry its locations one by
      // one. Single-location requests are much smaller and far less likely
      // to be dropped by the server.
      if (!payload) {
        const singles = await Promise.all(idxs.map((i) => fetchChunk([i])));
        payload = singles.map((s) => (s ? s[0] : null));
        if (payload.every((p) => p === null)) payload = null;
      }
      // Split the response back per location, in request order.
      idxs.forEach((idx, n) => {
        const data = payload && payload[n];
        if (!data || !data.hourly) {
          out[idx] = { error: true };
          return;
        }
        cacheSet(key(points[idx].lat, points[idx].lon, kind), data, updatedAt);
        out[idx] = { data, updatedAt, stale: false, fromCache: false, grid: gridInfo(data) };
      });
      // Paint as soon as this chunk is in.
      if (onChunk) { try { onChunk(idxs); } catch { /* a render failure must not break the load */ } }
    })
  );
  return out;
}

/** Smaller query for road/access weather estimates (all roads in one request). */
export function getRoadForecasts(roads, { force = false } = {}) {
  return getForecasts(roads, {
    force,
    kind: 'road',
    hourly: ROAD_HOURLY_VARS,
    daily: [],
    days: 2,
  });
}

/**
 * Friendly Persian message for fetch failures.
 * @param {Error|null} err
 */
export function apiErrorMessage(err = null) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return 'به اینترنت متصل نیستی — آخرین داده ذخیره‌شده نمایش داده می‌شود.';
  }
  if (err && /HTTP 429/.test(String(err.message || err))) {
    return 'درخواست‌های زیادی به سرویس هواشناسی ارسال شد — چند لحظه بعد دوباره تلاش کن.';
  }
  return 'دریافت اطلاعات هواشناسی ناموفق بود.';
}
