/**
 * SnowF — Data Normalizer & Derived Metrics.
 *
 * Raw Open-Meteo JSON never reaches the UI or the scoring engines directly.
 * Everything flows through here first:
 *   - safe getters (missing data → null, never crash, never fake numbers)
 *   - day/hour alignment (hourly rows grouped by local calendar day)
 *   - height correction (model temperature → true station altitude)
 *   - derived metrics (ski-window aggregates, trends, feels-like, …)
 *
 * Pure module: no DOM, no network. Safe to unit-test in Node.
 */

import { HEIGHT, SKI_HOURS } from './config.js';

// Hourly variables we rely on (used for the data-quality report).
// Must stay in sync with HOURLY_VARS in api.js.
const KEY_HOURLY_VARS = [
  'temperature_2m',
  'apparent_temperature',
  'precipitation',
  'rain',
  'snowfall',
  'snow_depth',
  'visibility',
  'cloud_cover',
  'wind_speed_10m',
  'wind_gusts_10m',
  'wind_direction_10m',
  'cape',
  'freezing_level_height',
];

const KEY_DAILY_VARS = [
  'temperature_2m_max',
  'temperature_2m_min',
  'snowfall_sum',
  'precipitation_probability_max',
  'wind_speed_10m_max',
  'wind_gusts_10m_max',
  'sunrise',
  'sunset',
];

/** Safe array getter: returns `fallback` (default null) when missing. */
export function get(arr, i, fallback = null) {
  if (!Array.isArray(arr)) return fallback;
  const v = arr[i];
  return v === undefined || v === null || Number.isNaN(v) ? fallback : v;
}

export function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Assess which expected variables are missing from a forecast response.
 * @returns {{ missingHourly: string[], missingDaily: string[], level: 'good'|'limited'|'poor', total: number }}
 */
export function assessDataQuality(data) {
  const missingHourly = [];
  const missingDaily = [];
  if (!data || typeof data !== 'object') {
    return { missingHourly: KEY_HOURLY_VARS.slice(), missingDaily: KEY_DAILY_VARS.slice(), level: 'poor', total: 0 };
  }
  for (const k of KEY_HOURLY_VARS) {
    if (!data.hourly || !Array.isArray(data.hourly[k]) || data.hourly[k].length === 0) missingHourly.push(k);
  }
  for (const k of KEY_DAILY_VARS) {
    if (!data.daily || !Array.isArray(data.daily[k]) || data.daily[k].length === 0) missingDaily.push(k);
  }
  const total = missingHourly.length + missingDaily.length;
  const level = total === 0 ? 'good' : total <= 4 ? 'limited' : 'poor';
  return { missingHourly, missingDaily, level, total };
}

/**
 * Grid metadata of the model cell the request snapped to.
 * Two stations that land on the SAME cell receive the same wind, cloud and
 * precipitation — only temperature is resolved per requested point.
 */
export function gridInfo(data) {
  return {
    lat: isNum(data?.latitude) ? data.latitude : null,
    lon: isNum(data?.longitude) ? data.longitude : null,
    elevation: isNum(data?.elevation) ? data.elevation : null,
  };
}

/** Stable key for a model grid cell (null when unknown). */
export function gridCellKey(grid) {
  if (!grid || !isNum(grid.lat) || !isNum(grid.lon)) return null;
  return `${grid.lat.toFixed(4)},${grid.lon.toFixed(4)}`;
}

/** Great-circle-ish distance in km (good enough for < 50 km). */
export function haversineKm(aLat, aLon, bLat, bLon) {
  if (![aLat, aLon, bLat, bLon].every(isNum)) return null;
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const la1 = (aLat * Math.PI) / 180;
  const la2 = (bLat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Build an index: local date string (YYYY-MM-DD) → { start, end } hourly indices.
 * Open-Meteo hourly[].time entries look like "2026-10-07T00:00" (local ISO, no zone).
 */
export function buildDayIndex(hourlyTimes) {
  const map = new Map();
  if (!Array.isArray(hourlyTimes)) return map;
  hourlyTimes.forEach((t, i) => {
    if (typeof t !== 'string' || t.length < 10) return;
    const day = t.slice(0, 10);
    if (!map.has(day)) map.set(day, { start: i, end: i });
    else map.get(day).end = i;
  });
  return map;
}

/**
 * HEIGHT CORRECTION.
 *
 * Open-Meteo corrects temperature to the DEM elevation of the requested
 * coordinate. We want the temperature at the resort's OFFICIAL station
 * altitude, which the DEM may represent several tens of metres away from.
 *
 *   ΔT = -(stationAlt - demAlt) * lapseRate
 *
 * The sign is negative on purpose: a station that sits HIGHER than the DEM
 * point must be COLDER. (Verified against Open-Meteo: two points in the same
 * grid cell whose DEM elevations differ by 151 m reported a 1.0 °C
 * difference — a 6.6 °C/km lapse rate, matching LAPSE_RATE.)
 *
 * Only thermodynamic variables are shifted (see HEIGHT.applyTo).
 *
 * @param {object} data Open-Meteo payload
 * @param {number|null} targetAlt official station altitude in metres
 * @returns {{ delta: number, applied: boolean, demAlt: number|null, targetAlt: number|null }}
 */
export function heightCorrection(data, targetAlt) {
  const demAlt = isNum(data?.elevation) ? data.elevation : null;
  const target = isNum(targetAlt) ? targetAlt : null;
  if (demAlt === null || target === null) {
    return { delta: 0, applied: false, demAlt, targetAlt: target };
  }
  const diffM = target - demAlt;
  if (Math.abs(diffM) < HEIGHT.minDeltaM) {
    return { delta: 0, applied: false, demAlt, targetAlt: target };
  }
  return {
    // higher station → negative (colder) shift
    delta: Math.round(-diffM * HEIGHT.lapseRate * 1000) / 1000,
    applied: true,
    demAlt: Math.round(demAlt),
    targetAlt: target,
  };
}

/**
 * Build 24 (or fewer) normalized hour rows for daily[dayIndex].
 * Missing values stay `null` — callers must handle nulls explicitly.
 *
 * @param {object} data Open-Meteo payload
 * @param {number} dayIndex index into daily.time
 * @param {object} opts { targetAlt } — station altitude for the height correction
 */
export function buildDayHours(data, dayIndex, opts = {}) {
  const hours = [];
  if (!data || !data.hourly || !data.daily || !Array.isArray(data.daily.time)) return hours;
  const dayStr = data.daily.time[dayIndex];
  if (!dayStr) return hours;

  const dayIdx = buildDayIndex(data.hourly.time);
  const range = dayIdx.get(dayStr);
  if (!range) return hours;

  const h = data.hourly;
  const hc = heightCorrection(data, opts.targetAlt ?? null);
  const shift = hc.applied ? hc.delta : 0;

  for (let i = range.start; i <= range.end; i++) {
    const t = h.time[i] || '';
    hours.push({
      idx: i,
      time: t,
      hour: t.length >= 13 ? Number(t.slice(11, 13)) : null,
      temp: shifted(get(h.temperature_2m, i), shift),
      appTemp: shifted(get(h.apparent_temperature, i), shift),
      humidity: get(h.relative_humidity_2m, i),
      precip: get(h.precipitation, i),
      prob: get(h.precipitation_probability, i),
      rain: get(h.rain, i),
      snowfall: get(h.snowfall, i), // cm
      snowDepth: get(h.snow_depth, i), // m in API! converted below
      cloud: get(h.cloud_cover, i),
      vis: get(h.visibility, i), // meters
      wind: get(h.wind_speed_10m, i),
      gust: get(h.wind_gusts_10m, i),
      windDir: get(h.wind_direction_10m, i),
      cape: get(h.cape, i),
      li: get(h.lifted_index, i),
      freezingLevel: get(h.freezing_level_height, i),
      isDay: get(h.is_day, i),
    });
  }
  // Open-Meteo snow_depth unit is meters — convert to cm once, centrally.
  for (const r of hours) {
    if (isNum(r.snowDepth)) r.snowDepth = r.snowDepth * 100;
    if (isNum(r.vis)) r.visKm = r.vis / 1000;
    else r.visKm = null;
  }
  return hours;
}

/** Shift a value by the height correction (null-safe). */
function shifted(v, delta) {
  if (!isNum(v)) return v;
  if (!delta) return v;
  return Math.round((v + delta) * 100) / 100;
}

/** Daily aggregates for one day (safe, null-tolerant). */
export function buildDaySummary(data, dayIndex) {
  const d = (data && data.daily) || {};
  return {
    date: get(d.time, dayIndex, ''),
    weatherCode: get(d.weather_code, dayIndex),
    tempMax: get(d.temperature_2m_max, dayIndex),
    tempMin: get(d.temperature_2m_min, dayIndex),
    appMax: get(d.apparent_temperature_max, dayIndex),
    appMin: get(d.apparent_temperature_min, dayIndex),
    precipSum: get(d.precipitation_sum, dayIndex),
    rainSum: get(d.rain_sum, dayIndex),
    snowSum: get(d.snowfall_sum, dayIndex), // cm
    precipHours: get(d.precipitation_hours, dayIndex),
    probMax: get(d.precipitation_probability_max, dayIndex),
    windMax: get(d.wind_speed_10m_max, dayIndex),
    gustMax: get(d.wind_gusts_10m_max, dayIndex),
    windDir: get(d.wind_direction_10m_dominant, dayIndex),
    sunrise: get(d.sunrise, dayIndex, ''),
    sunset: get(d.sunset, dayIndex, ''),
    uvMax: get(d.uv_index_max, dayIndex),
  };
}

/**
 * Canadian wind-chill (°C). Only meaningful for temp<=10 & wind>=4.8.
 * Returns null when inputs are missing.
 */
function windChill(tempC, windKmh) {
  if (!isNum(tempC) || !isNum(windKmh)) return null;
  if (tempC > 10 || windKmh < 4.8) return Math.round(tempC * 10) / 10;
  const v = Math.pow(windKmh, 0.16);
  return Math.round((13.12 + 0.6215 * tempC - 11.37 * v + 0.3965 * tempC * v) * 10) / 10;
}

/** "Feels like": the colder of apparent temp and wind chill (null-tolerant). */
export function feelsLike(tempC, appTempC, windKmh) {
  const wc = windChill(tempC, windKmh);
  const cands = [isNum(appTempC) ? appTempC : null, wc, isNum(tempC) ? tempC : null].filter(isNum);
  if (!cands.length) return null;
  return Math.min(...cands);
}

/**
 * Is this hour inside the ski window?
 *
 * The window is HALF-OPEN: `start` inclusive, `end` exclusive. A window of
 * 07:00–16:00 therefore contains the hourly rows 07:00 … 15:00 — the 16:00
 * row already describes the hour 16:00→17:00, which is past the end.
 */
export function inSkiWindow(hour, window = SKI_HOURS) {
  return isNum(hour) && hour >= window.start && hour < window.end;
}

/**
 * Aggregate the ski window (default 07:00–16:00) from hour rows.
 * @param {Array} hours hour rows from buildDayHours
 * @param {number|null} fromHour for "today": ignore past hours (null = whole window)
 */
export function summarizeSkiWindow(hours, fromHour = null, window = SKI_HOURS) {
  const rows = hours.filter(
    (r) => inSkiWindow(r.hour, window) && (fromHour === null || r.hour >= fromHour)
  );
  const pick = (fn) => rows.map(fn).filter(isNum);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const avg = (a) => (a.length ? sum(a) / a.length : null);
  const max = (a) => (a.length ? Math.max(...a) : null);
  const min = (a) => (a.length ? Math.min(...a) : null);

  const feels = rows.map((r) => feelsLike(r.temp, r.appTemp, r.wind)).filter(isNum);

  return {
    hours: rows,
    count: rows.length,
    avgTemp: avg(pick((r) => r.temp)),
    minTemp: min(pick((r) => r.temp)),
    maxTemp: max(pick((r) => r.temp)),
    avgFeels: avg(feels),
    minFeels: min(feels),
    maxWind: max(pick((r) => r.wind)),
    avgWind: avg(pick((r) => r.wind)),
    maxGust: max(pick((r) => r.gust)),
    minVisKm: min(pick((r) => r.visKm)),
    avgCloud: avg(pick((r) => r.cloud)),
    totalSnowCm: sum(pick((r) => r.snowfall)),
    totalRainMm: sum(pick((r) => r.rain)),
    totalPrecipMm: sum(pick((r) => r.precip)),
    maxSnowRate: max(pick((r) => r.snowfall)),
    maxCape: max(pick((r) => r.cape)),
    minLi: min(pick((r) => r.li)),
    minFreezingLevel: min(pick((r) => r.freezingLevel)),
    avgFreezingLevel: avg(pick((r) => r.freezingLevel)),
    maxHumidity: max(pick((r) => r.humidity)),
    snowDepthCm: (() => {
      const ds = pick((r) => r.snowDepth);
      return ds.length ? ds[ds.length - 1] : null; // latest in window
    })(),
  };
}

/** 24h temperature change: day's max vs previous day's max (null-tolerant). */
export function tempRise24h(data, dayIndex) {
  if (!data || !data.daily) return null;
  const cur = get(data.daily.temperature_2m_max, dayIndex);
  const prev = get(data.daily.temperature_2m_max, dayIndex - 1);
  if (!isNum(cur) || !isNum(prev)) return null;
  return Math.round((cur - prev) * 10) / 10;
}

/**
 * Trailing 24h sum of an hourly variable, ending at `endIndex`.
 * This is the TRUE "last 24 hours" (it may cross a day boundary), which is
 * what "برف تازه ۲۴ساعته" should mean — the daily sum of a forecast day is
 * a calendar day, not a trailing window.
 *
 * @returns {number|null} null when no numeric value is available at all
 */
export function trailing24hSum(arr, endIndex, len = 24) {
  if (!Array.isArray(arr)) return null;
  if (!Number.isInteger(endIndex) || endIndex < 0 || endIndex >= arr.length) return null;
  const start = Math.max(0, endIndex - len + 1);
  let total = 0;
  let found = false;
  for (let i = start; i <= endIndex; i++) {
    const v = arr[i];
    if (isNum(v)) {
      total += v;
      found = true;
    }
  }
  return found ? Math.round(total * 10) / 10 : null;
}

/**
 * Index of the last hourly row of a given calendar day (null when unknown).
 */
export function dayEndIndex(data, dayIndex) {
  if (!data || !data.hourly || !data.daily || !Array.isArray(data.daily.time)) return null;
  const dayStr = data.daily.time[dayIndex];
  if (!dayStr) return null;
  const range = buildDayIndex(data.hourly.time).get(dayStr);
  return range ? range.end : null;
}

/**
 * Fresh snow over the trailing 24h ending at the end of the ski window of
 * the given day (or at "now" for today).
 *
 * @param {object} data Open-Meteo payload
 * @param {number} dayIndex
 * @param {number|null} nowIndex current hour index (used for today)
 * @returns {number|null} cm
 */
export function freshSnow24h(data, dayIndex, nowIndex = null) {
  if (!data || !data.hourly) return null;
  let end = dayEndIndex(data, dayIndex);
  if (dayIndex === 0 && Number.isInteger(nowIndex) && nowIndex >= 0) end = nowIndex;
  if (end === null) return null;
  return trailing24hSum(data.hourly.snowfall, end, 24);
}

/**
 * Hour rows of one calendar day, reduced to what the snow-opportunity
 * model needs: the hour, the temperature and the snowfall.
 */
export function dayHourRows(data, dayIndex) {
  try {
    if (!data?.hourly?.time || !data?.daily?.time) return [];
    const range = buildDayIndex(data.hourly.time).get(data.daily.time[dayIndex]);
    if (!range) return [];
    const out = [];
    for (let i = range.start; i <= range.end; i++) {
      out.push({
        hour: Number((data.hourly.time[i] || '').slice(11, 13)),
        temp: data.hourly.temperature_2m?.[i],
        snowfall: data.hourly.snowfall?.[i] || 0,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Snowfall that actually falls AS snow.
 *
 * The daily `snowfall_sum` counts every frozen precipitation, including
 * sleet, so a "2 cm snow" day at +1 °C is really rain. Only the hours at
 * or below freezing are real snow.
 */
export function coldSnowfall(hours = []) {
  let total = 0;
  for (const h of hours) {
    if (isNum(h.snowfall) && h.snowfall > 0 && isNum(h.temp) && h.temp <= 0) total += h.snowfall;
  }
  return Math.round(total * 10) / 10;
}

/**
 * Current hour index within hourly[].time for "now" in the forecast timezone.
 * Falls back to null when it cannot be determined.
 */
export function findNowIndex(hourlyTimes, now = new Date(), timeZone = 'Asia/Tehran') {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
    const needle = `${p.year}-${p.month}-${p.day}T${p.hour}`;
    if (!Array.isArray(hourlyTimes)) return null;
    const i = hourlyTimes.findIndex((t) => typeof t === 'string' && t.startsWith(needle));
    return i >= 0 ? i : null;
  } catch {
    return null;
  }
}

/** Extract HH:MM from an ISO datetime string. */
export function hhmm(iso) {
  if (typeof iso !== 'string' || !iso.includes('T')) return null;
  return iso.slice(11, 16);
}

/** Compass name (Persian) for wind direction degrees. */
export function windDirName(deg) {
  if (!isNum(deg)) return null;
  const names = ['شمال', 'شمال‌شرق', 'شرق', 'جنوب‌شرق', 'جنوب', 'جنوب‌غرب', 'غرب', 'شمال‌غرب'];
  return names[Math.round(deg / 45) % 8];
}

/** Round helper that preserves null. */
export function r1(v) {
  return isNum(v) ? Math.round(v * 10) / 10 : null;
}
export function r0(v) {
  return isNum(v) ? Math.round(v) : null;
}
