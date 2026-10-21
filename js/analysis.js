/**
 * SnowF — Analysis Engine.
 *
 * Pipeline for one location × one day:
 *   normalized hours → ski-window aggregates → flags → snow surface →
 *   mountain risk → safety → ski quality → single analysis object.
 *
 * Also: road/weather access estimate, freezing-level reading, lens advice.
 *
 * Pure module: no DOM, no network. Safe to unit-test in Node.
 */

import { ELEVATION_WEIGHTS, FLAGS, LIFT_ESTIMATE, LENS, SKI_HOURS, VERDICT } from './config.js';
import {
  get, isNum, buildDayHours, buildDaySummary, summarizeSkiWindow,
  tempRise24h, freshSnow24h, findNowIndex, gridInfo, heightCorrection,
  windDirName, hhmm, r0, r1,
} from './weather.js';
import { estimateSnowSurface, detectRefreeze, detectRainOnSnow, detectFreezingRain } from './snow-quality.js';
import { calculateMountainRisk, calculateSafetyScore } from './safety.js';
import { calculateSkiQuality } from './ski-score.js';
import { hourlySkiScore } from './recommendation.js';

/**
 * Full analysis for one station (location) and one day.
 * @param {object} data Open-Meteo forecast JSON (or null on fetch failure)
 * @param {number} dayIndex index into daily.time
 * @param {object} meta { alt, nameFa, shortFa, zone }
 * @param {object} opts { fromHour (for today: skip past hours) }
 * @returns analysis object, or { failed: true, ... } when data is missing.
 */
export function analyzeLocationDay(data, dayIndex, meta = {}, opts = {}) {
  const base = {
    failed: false,
    alt: meta.alt ?? null,
    nameFa: meta.nameFa || '',
    shortFa: meta.shortFa || '',
    zone: meta.zone || 'mid',
    dayIndex,
  };
  if (!data || !data.hourly || !data.daily) {
    return { ...base, failed: true, failReason: 'داده هواشناسی موجود نیست' };
  }

  // --- Height correction: model temperature → true station altitude. ---
  const hc = heightCorrection(data, meta.alt ?? null);
  const hours = buildDayHours(data, dayIndex, { targetAlt: meta.alt ?? null });
  const day = buildDaySummary(data, dayIndex);
  if (!hours.length) {
    return { ...base, failed: true, failReason: 'داده ساعتی برای این روز موجود نیست' };
  }

  const remaining = summarizeSkiWindow(hours, opts.fromHour ?? null);
  // Late-day guard: if the remaining ski window is empty (e.g. it's 19:00),
  // fall back to the FULL window so headline numbers stay meaningful — and
  // flag it so the UI says "ساعات اسکی امروز گذشته" instead of showing GO.
  const lateDay = remaining.count === 0;
  const win = lateDay ? summarizeSkiWindow(hours, null) : remaining;

  // --- Derived context ---
  const warming = tempRise24h(data, dayIndex);
  // TRUE trailing 24h (may cross midnight) — not the calendar-day sum.
  const nowIndex = findNowIndex(data.hourly.time);
  const fresh24h = (() => {
    const trailing = freshSnow24h(data, dayIndex, nowIndex);
    if (isNum(trailing)) return trailing;
    if (isNum(day.snowSum)) return Math.round(day.snowSum * 10) / 10;
    return 0;
  })();
  const depthCm = isNum(win.snowDepthCm) ? Math.round(win.snowDepthCm) : isNum(day.snowSum) && day.snowSum > 0 ? null : 0;
  const depthKnown = isNum(win.snowDepthCm);

  // Refreeze inputs: prev-day max, night min (00-06), morning temp (07-09).
  const refreezeCtx = refreezeInputs(data, hours, dayIndex);
  const refreeze = detectRefreeze(refreezeCtx);

  const rainMm = r1(isNum(win.totalRainMm) ? win.totalRainMm : isNum(day.rainSum) ? day.rainSum : 0);
  const rainOnSnow = detectRainOnSnow({ rainMm, snowDepthCm: depthKnown ? depthCm : 0 });
  // Depth unknown + rain falling → we can neither confirm nor rule out
  // rain-on-snow. Say so instead of silently assuming "no snowpack".
  if (!depthKnown && rainMm >= FLAGS.rainOnSnow.rainMm) {
    rainOnSnow.unknown = true;
    rainOnSnow.unknownReason = 'عمق برف نامشخص — وضعیت باران روی برف قابل ارزیابی نیست';
  }
  const freezingRain = detectFreezingRain({
    precipMm: win.totalPrecipMm,
    tempC: win.avgTemp,
    humidity: win.maxHumidity,
  });

  // Temp trend: compare first-half vs second-half of the window.
  const tempTrend = windowTempTrend(win.hours);

  // --- Snow surface (estimate) ---
  const snow = estimateSnowSurface({
    tempC: win.avgTemp !== null ? r1(win.avgTemp) : null,
    rainMm,
    freshCm: fresh24h,
    refreeze: refreeze.likely,
    windMaxKmh: win.maxWind,
    snowRateMax: win.maxSnowRate,
    tempTrend,
  });

  // Freezing-level reading vs station altitude.
  const freezingLevel = isNum(win.avgFreezingLevel) ? Math.round(win.avgFreezingLevel) : null;
  const freezingReading = freezingLevelReading(freezingLevel, meta.alt);

  // --- Mountain risk (estimate) ---
  const risk = calculateMountainRisk({
    fresh24hCm: fresh24h,
    snowRateMax: win.maxSnowRate,
    gustKmh: win.maxGust,
    warming24h: warming,
    rainMm,
    depthCm: depthKnown ? depthCm : null,
    freezingLevelM: freezingLevel,
    stationAltM: meta.alt ?? null,
    visKm: win.minVisKm,
  });

  // --- Deterioration over the next hours (only meaningful for "today") ---
  const deteriorating = detectDeterioration(hours, opts.fromHour ?? null);

  // --- Safety (independent dimension) ---
  const safety = calculateSafetyScore(
    {
      gustKmh: win.maxGust,
      sustainedKmh: win.maxWind,
      visKm: win.minVisKm,
      snowRateMax: win.maxSnowRate,
      rainOnSnow,
      freezingRain,
      warming24h: warming,
      feelsMinC: win.minFeels,
      capeMax: win.maxCape,
      liMin: win.minLi,
      deteriorating,
    },
    risk
  );

  // --- Ski quality ---
  const ski = calculateSkiQuality({
    depthCm: depthKnown ? depthCm : null,
    fresh24hCm: fresh24h,
    surfaceCategory: snow.category,
    sustainedKmh: win.maxWind,
    gustKmh: win.maxGust,
    visKm: win.minVisKm,
    feelsLikeC: win.avgFeels,
    cloudPct: win.avgCloud,
    snowRateMax: win.maxSnowRate,
    rainMm,
    freezingRain: freezingRain.likely,
    capeMax: win.maxCape,
    liMin: win.minLi,
  });

  // --- Extras (kept from v2: lens, lift estimate, sun, fog) ---
  const lens = lensAdvice(win, day);
  const lift = liftAdvice(win.maxWind);

  return {
    ...base,
    date: day.date,
    windowCount: win.count,
    lateDay, // true when the ski window had already ended for "today"
    // headline numbers (null = unknown → UI shows N/A)
    temp: r0(win.avgTemp),
    tempMin: r0(day.tempMin),
    tempMax: r0(day.tempMax),
    feelsLike: r0(win.avgFeels),
    feelsMin: r0(win.minFeels),
    wind: r0(win.maxWind),
    windAvg: r0(win.avgWind),
    gust: r0(win.maxGust),
    windDir: windDirName(day.windDir) || windDirName(win.hours[Math.floor(win.hours.length / 2)]?.windDir),
    visKm: isNum(win.minVisKm) ? r1(win.minVisKm) : null,
    cloud: r0(win.avgCloud),
    humidity: r0(win.maxHumidity),
    precipMm: r1(win.totalPrecipMm),
    probMax: r0(day.probMax),
    rainMm,
    fresh24hCm: fresh24h,
    snowRateMax: r1(win.maxSnowRate),
    depthCm: depthKnown ? depthCm : null,
    depthKnown,
    cape: r0(win.maxCape),
    li: isNum(win.minLi) ? Math.round(win.minLi * 10) / 10 : null,
    uv: r0(day.uvMax),
    sunrise: hhmm(day.sunrise),
    sunset: hhmm(day.sunset),
    // engines
    snow,
    risk,
    safety,
    ski,
    // flags
    refreeze,
    rainOnSnow,
    freezingRain,
    windLoading: risk.windLoading,
    freezingLevel,
    freezingReading,
    warming24h: warming,
    tempTrend,
    deteriorating,
    // provenance (for honest disclosure in the UI)
    grid: gridInfo(data),
    heightCorrection: hc,
    // extras
    lens,
    lift,
    // raw-ish access for deeper layers (timeline/charts/best-window)
    _hours: hours,
    _day: day,
    _win: win,
  };
}

/** Combine the 3 station analyses into ONE resort-day analysis. */
export function analyzeResortDay(locationAnalyses = [], meta = {}) {
  const ok = locationAnalyses.filter((a) => a && !a.failed);
  const failed = locationAnalyses.filter((a) => !a || a.failed);
  const res = {
    resortId: meta.resortId || '',
    nameFa: meta.nameFa || '',
    fullNameFa: meta.fullNameFa || '',
    dayIndex: meta.dayIndex ?? 0,
    date: ok[0]?.date || '',
    locations: locationAnalyses,
    failed: ok.length === 0,
    partial: failed.length > 0 && ok.length > 0,
    failReason: ok.length === 0 ? 'داده‌ای برای این پیست دریافت نشد' : null,
  };
  if (res.failed) return res;

  const wsum = ok.reduce((s, a) => s + (ELEVATION_WEIGHTS[a.zone] ?? 1 / ok.length), 0) || 1;
  const wavg = (fn) => ok.reduce((s, a) => s + (ELEVATION_WEIGHTS[a.zone] ?? 1 / ok.length) * (fn(a) ?? 0), 0) / wsum;

  res.ski = Math.round(wavg((a) => a.ski.score));
  res.safety = Math.round(wavg((a) => a.safety.score));
  res.snowScore = Math.round(wavg((a) => a.snow.score));
  // Worst risk band across stations (conservative).
  const order = { low: 0, moderate: 1, elevated: 2, high: 3 };
  res.risk = ok.map((a) => a.risk).sort((x, y) => order[y.band] - order[x.band])[0];
  // Representative headline values (summit-first, then best available).
  const rep = ok.find((a) => a.zone === 'summit') || ok[0];
  res.temp = rep.temp;
  res.wind = rep.wind;
  res.gust = rep.gust;
  res.visKm = rep.visKm;
  res.fresh24hCm = Math.max(...ok.map((a) => a.fresh24hCm || 0));
  // Depth for the viability gate: the BEST available station, not only the
  // summit. A wind-scoured summit must not condemn a resort whose mid
  // station still has 60 cm of snow.
  res.depthCm = VERDICT.depthFrom === 'summit' ? rep.depthCm : bestDepth(ok);
  res.depthKnown = ok.some((a) => a.depthKnown);
  // Worst station safety — an independent floor for the verdict, so one
  // dangerous station can never be averaged away by two calm ones.
  res.minSafety = Math.min(...ok.map((a) => a.safety.score));
  res.minSafetyZone = ok.slice().sort((a, b) => a.safety.score - b.safety.score)[0]?.shortFa || null;
  res.hardStops = [...new Set(ok.flatMap((a) => a.safety.hardStops.map((h) => h.label)))];
  res.flags = [...new Set(ok.flatMap((a) => a.safety.flags.map((f) => f.label)))];
  return res;
}

/** Best (deepest) known snow depth across stations — null when unknown. */
function bestDepth(analyses = []) {
  const known = analyses.filter((a) => a && !a.failed && isNum(a.depthCm));
  if (!known.length) return null;
  return Math.max(...known.map((a) => a.depthCm));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function refreezeInputs(data, hours, dayIndex) {
  const prevDayMax = get(data.daily.temperature_2m_max, dayIndex - 1, null);
  const night = hours.filter((r) => isNum(r.hour) && r.hour >= 0 && r.hour <= 6).map((r) => r.temp).filter(isNum);
  const morning = hours.filter((r) => isNum(r.hour) && r.hour >= SKI_HOURS.start && r.hour <= 9).map((r) => r.temp).filter(isNum);
  return {
    prevDayMax,
    nightMin: night.length ? Math.min(...night) : null,
    morningTemp: morning.length ? morning[0] : null,
  };
}

function windowTempTrend(rows) {
  const temps = rows.map((r) => r.temp).filter(isNum);
  if (temps.length < 4) return null;
  const half = Math.floor(temps.length / 2);
  const a = temps.slice(0, half).reduce((s, v) => s + v, 0) / half;
  const b = temps.slice(half).reduce((s, v) => s + v, 0) / (temps.length - half);
  if (b - a >= 2) return 'warming';
  if (a - b >= 2) return 'cooling';
  return 'stable';
}

/**
 * Deterioration detection for "today": compares the remaining ski window
 * with the hours that follow it. Uses the same hourly score the timeline
 * shows, so the number the user sees matches the reason we give.
 *
 * @param {Array} hours full day rows
 * @param {number|null} fromHour current hour (null → not applicable)
 * @returns {boolean}
 */
export function detectDeterioration(hours = [], fromHour = null) {
  if (fromHour === null || !Array.isArray(hours) || !hours.length) return false;
  const scored = hours
    .filter((r) => isNum(r.hour))
    .map((r) => ({ hour: r.hour, s: hourlySkiScore(r, null).score }));
  const now = scored.filter((r) => r.hour >= fromHour && r.hour <= SKI_HOURS.end);
  const later = scored.filter((r) => r.hour > SKI_HOURS.end);
  if (now.length < 2 || later.length < 2) return false;
  const avg = (a) => a.reduce((s, r) => s + r.s, 0) / a.length;
  const drop = avg(now) - avg(later);
  return drop >= FLAGS.deterioration.skiDrop;
}

function freezingLevelReading(freezingLevelM, stationAltM) {
  if (!isNum(freezingLevelM)) return { text: null, cold: null };
  const fl = freezingLevelM.toLocaleString('fa-IR');
  if (!isNum(stationAltM)) {
    return { text: `سطح انجماد ${fl} متر`, cold: null };
  }
  const diff = stationAltM - freezingLevelM;
  if (diff >= 150) return { text: `سطح انجماد ${fl} متر — ایستگاه بالاتر از آن است (سردتر ❄)`, cold: true };
  if (diff <= -150) return { text: `سطح انجماد ${fl} متر — ایستگاه پایین‌تر از آن است (گرم‌تر 🌡)`, cold: false };
  return { text: `سطح انجماد ${fl} متر — نزدیک به ارتفاع ایستگاه`, cold: null };
}

function lensAdvice(win, day) {
  const cloud = isNum(win.avgCloud) ? win.avgCloud : 50;
  const vis = isNum(win.minVisKm) ? win.minVisKm : 10;
  const uv = isNum(day.uvMax) ? day.uvMax : 0;
  let idx = 4;
  if (vis < 1 || cloud > 85) idx = 1;
  else if (cloud > 55 || vis < 3) idx = 2;
  else if (cloud > 25) idx = 3;
  else if (uv >= 6) idx = 4;
  const l = LENS[idx];
  return { fa: l.fa, vlt: l.vlt, when: l.when, uv };
}

function liftAdvice(maxWind) {
  if (!isNum(maxWind)) return 'وضعیت تله‌ها نامشخص (بدون داده باد)';
  const b = LIFT_ESTIMATE.find((x) => maxWind <= x.max) || LIFT_ESTIMATE[LIFT_ESTIMATE.length - 1];
  return b.label;
}

/**
 * Road / access WEATHER estimate (never a claim about actual road status).
 * Uses the next `horizonH` hours from raw hourly arrays.
 */
export function analyzeRoad(data, horizonH = 6) {
  if (!data || !data.hourly || !Array.isArray(data.hourly.time) || !data.hourly.time.length) {
    return { failed: true, level: 'unknown', label: 'نامشخص', detail: 'داده مسیر موجود نیست' };
  }
  const h = data.hourly;
  const n = Math.min(horizonH, h.time.length);
  let minTemp = Infinity;
  let maxPrecip = 0;
  let maxSnow = 0;
  let minVisKm = Infinity;
  let maxHum = 0;
  for (let i = 0; i < n; i++) {
    const t = get(h.temperature_2m, i);
    if (isNum(t)) minTemp = Math.min(minTemp, t);
    const p = get(h.precipitation, i, 0);
    if (isNum(p)) maxPrecip = Math.max(maxPrecip, p);
    const s = get(h.snowfall, i, 0);
    if (isNum(s)) maxSnow = Math.max(maxSnow, s);
    const v = get(h.visibility, i);
    if (isNum(v)) minVisKm = Math.min(minVisKm, v / 1000);
    const hu = get(h.relative_humidity_2m, i);
    if (isNum(hu)) maxHum = Math.max(maxHum, hu);
  }
  const notes = [];
  let level = 'ok';
  if (minTemp !== Infinity && minTemp < 1.5 && maxHum > 85) {
    level = minTemp < 0 ? 'bad' : 'caution';
    notes.push(`احتمال یخ‌زدگی سطح جاده (دما ${Math.round(minTemp)}°، رطوبت ${Math.round(maxHum)}٪)`);
  }
  if (maxSnow >= 0.5) {
    level = 'bad';
    notes.push('بارش برف در مسیر');
  } else if (maxPrecip >= 1) {
    if (level === 'ok') level = 'caution';
    notes.push('بارش در مسیر');
  }
  if (minVisKm !== Infinity && minVisKm < 2) {
    if (level === 'ok') level = 'caution';
    notes.push(`دید محدود در مسیر (${Math.round(minVisKm * 10) / 10} کیلومتر)`);
  }
  if (!notes.length) notes.push('شرایط جوی مسیر عادی به نظر می‌رسد');
  const labels = { ok: 'عادی', caution: 'احتیاط', bad: 'نامساعد', unknown: 'نامشخص' };
  return {
    failed: false,
    level,
    label: labels[level],
    notes,
    minTemp: minTemp === Infinity ? null : Math.round(minTemp),
    disclaimer: 'این برآوردی از شرایط جوی مسیر است و وضعیت واقعی جاده را نشان نمی‌دهد.',
  };
}
