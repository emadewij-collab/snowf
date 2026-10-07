/**
 * SnowF — Ski Quality Engine (0-100).
 *
 * Additive model from a neutral base. Every physical factor contributes
 * EXACTLY ONCE (see config.js design rules):
 *   - wind: single "effective wind" = max(sustained, gust * GUST_WEIGHT)
 *   - snow: depth (viability) + fresh 24h (freshness) + surface (condition)
 *   - instability: ONE combined CAPE + Lifted-Index factor
 *
 * Profile nudges are small, additive and recorded as explainable factors.
 * Profiles NEVER touch safety — safety lives in safety.js.
 *
 * Pure module: no DOM, no network. Safe to unit-test in Node.
 */

import { SKI, PROFILE_NUDGES } from './config.js';
import { isNum } from './weather.js';

function bandMin(bands, value, fallbackLabel = '') {
  for (const b of bands) {
    if (value >= b.min) return b;
  }
  return bands[bands.length - 1] || { points: 0, label: fallbackLabel };
}

function bandMax(bands, value) {
  for (const b of bands) {
    if (value <= b.max) return b;
  }
  return bands[bands.length - 1];
}

/**
 * @param {object} ctx — aggregated ski-window context:
 *   { depthCm, fresh24hCm, surfaceCategory, sustainedKmh, gustKmh,
 *     visKm, feelsLikeC, cloudPct, snowRateMax, rainMm,
 *     freezingRain (bool), capeMax, liMin }
 * @param {string} profileId — casual | intermediate | advanced | powder
 * @returns {{ score, factors, effWind, missing: string[] }}
 */
export function calculateSkiQuality(ctx = {}, profileId = 'intermediate') {
  const factors = [];
  const missing = [];
  const add = (key, label, points, detail = null) => {
    if (points !== 0 || detail) factors.push({ key, label, points, detail });
    else factors.push({ key, label, points });
  };
  const req = (name, v) => {
    if (!isNum(v)) missing.push(name);
    return isNum(v) ? v : null;
  };

  let score = SKI.base;

  // 1) Snow depth — operational viability.
  const depth = req('depthCm', ctx.depthCm);
  if (depth !== null) {
    const b = bandMin(SKI.depth, depth);
    score += b.points;
    add('depth', `${b.label} (${Math.round(depth)} سانتی‌متر)`, b.points);
  } else {
    add('depth', 'عمق برف نامشخص', 0, 'داده موجود نیست');
  }

  // 2) Fresh snow in trailing 24h — freshness bonus.
  const fresh = isNum(ctx.fresh24hCm) ? ctx.fresh24hCm : 0;
  if (!isNum(ctx.fresh24hCm)) missing.push('fresh24hCm');
  {
    const b = bandMin(SKI.fresh, fresh);
    score += b.points;
    add('fresh', fresh > 0 ? `${b.label} (${Math.round(fresh)} سانتی‌متر)` : b.label, b.points);
  }

  // 3) Snow surface condition — single factor from the snow module.
  {
    const cat = ctx.surfaceCategory || 'unknown';
    const s = SKI.surface[cat] || SKI.surface.unknown;
    score += s.points;
    add('surface', s.label, s.points);
  }

  // 4) Wind — SINGLE effective-wind factor (anti double-counting).
  const sustained = isNum(ctx.sustainedKmh) ? ctx.sustainedKmh : 0;
  const gust = isNum(ctx.gustKmh) ? ctx.gustKmh : 0;
  if (!isNum(ctx.sustainedKmh) && !isNum(ctx.gustKmh)) missing.push('wind');
  const effWind = Math.max(sustained, gust * SKI.GUST_WEIGHT);
  {
    const b = bandMax(SKI.wind, effWind);
    score += b.points;
    const detail =
      isNum(ctx.sustainedKmh) || isNum(ctx.gustKmh)
        ? `باد ${isNum(ctx.sustainedKmh) ? Math.round(ctx.sustainedKmh) : '—'} / گاست ${isNum(ctx.gustKmh) ? Math.round(ctx.gustKmh) : '—'} km/h`
        : 'داده باد موجود نیست';
    add('wind', sustained || gust ? `${b.label} (مؤثر ≈${Math.round(effWind)})` : b.label, b.points, detail);
  }

  // 5) Visibility (comfort side).
  const vis = req('visKm', ctx.visKm);
  if (vis !== null) {
    const b = bandMin(SKI.visibilityKm, vis);
    score += b.points;
    add('visibility', `${b.label} (${vis} کیلومتر)`, b.points);
  } else {
    add('visibility', 'دید نامشخص', 0, 'داده موجود نیست');
  }

  // 6) Feels-like temperature (comfort side; extremes → Safety).
  const feels = req('feelsLikeC', ctx.feelsLikeC);
  if (feels !== null) {
    const b = SKI.feelsLike.find((x) => feels >= x.min && feels <= x.max) || SKI.feelsLike[SKI.feelsLike.length - 1];
    score += b.points;
    add('temp', `${b.label} (احساس ${Math.round(feels)}°)`, b.points);
  } else {
    add('temp', 'دما نامشخص', 0, 'داده موجود نیست');
  }

  // 7) Cloud cover (flat light). Small effect by design.
  if (isNum(ctx.cloudPct)) {
    const b = bandMax(SKI.cloudPct, ctx.cloudPct);
    score += b.points;
    add('cloud', `${b.label} (${Math.round(ctx.cloudPct)}٪)`, b.points);
  } else {
    missing.push('cloudPct');
    add('cloud', 'ابری نامشخص', 0, 'داده موجود نیست');
  }

  // 8) Ongoing precipitation during ski hours (comfort side).
  const snowRate = isNum(ctx.snowRateMax) ? ctx.snowRateMax : 0;
  {
    const b = bandMax(SKI.ongoingSnowRateCmH, snowRate);
    if (b.points !== 0) {
      score += b.points;
      add('ongoing-snow', b.label, b.points);
    }
  }
  const rainMm = isNum(ctx.rainMm) ? ctx.rainMm : 0;
  if (rainMm >= SKI.ongoingRainMm.threshold) {
    score += SKI.ongoingRainMm.points;
    add('ongoing-rain', `${SKI.ongoingRainMm.label} (${rainMm} م‌م)`, SKI.ongoingRainMm.points);
  }
  if (ctx.freezingRain) {
    score += SKI.ongoingFreezingRain.points;
    add('freezing-rain', SKI.ongoingFreezingRain.label, SKI.ongoingFreezingRain.points);
  }

  // 9) Instability — ONE combined CAPE + LI factor.
  {
    const cape = isNum(ctx.capeMax) ? ctx.capeMax : 0;
    const li = isNum(ctx.liMin) ? ctx.liMin : 99;
    const b = SKI.instability.find((x) => cape >= x.cape || li <= x.li) || SKI.instability[SKI.instability.length - 1];
    if (b.points !== 0) {
      score += b.points;
      add('instability', `${b.label} (CAPE ${Math.round(cape)})`, b.points);
    }
  }

  // 10) Profile nudges — quality-side preference only.
  applyProfileNudges(profileId, { fresh, vis, feels, effWind, sustained }, factors);

  // Final total recomputed from the recorded factors (single source of truth).
  score = SKI.base + factors.reduce((s, f) => s + (f.points || 0), 0);

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, factors, effWind: Math.round(effWind * 10) / 10, missing };
}

function applyProfileNudges(profileId, { fresh, vis, feels, effWind }, factors) {
  const nudges = PROFILE_NUDGES[profileId] || [];
  const push = (key, label, points) => factors.push({ key, label, points, profile: profileId });
  for (const n of nudges) {
    switch (n.when) {
      case 'cold':
        if (isNum(feels) && feels < -10) push('nudge', n.label, n.points);
        break;
      case 'goodVis':
        if (isNum(vis) && vis >= 5) push('nudge', n.label, n.points);
        break;
      case 'windy':
        if (isNum(effWind) && effWind > 25) push('nudge', n.label, n.points);
        break;
      case 'breezy':
        if (isNum(effWind) && effWind >= 20 && effWind <= 38) push('nudge', n.label, n.points);
        break;
      case 'lowVisOk':
        if (isNum(vis) && vis >= 2 && vis < 5) push('nudge', n.label, n.points);
        break;
      case 'coldOk':
        if (isNum(feels) && feels >= -17 && feels < -10) push('nudge', n.label, n.points);
        break;
      case 'deepFresh':
        if (isNum(fresh) && fresh >= 10) push('nudge', n.label, n.points);
        break;
      case 'someFresh':
        if (isNum(fresh) && fresh >= 5 && fresh < 10) push('nudge', n.label, n.points);
        break;
      case 'noFresh':
        if (!isNum(fresh) || fresh < 2) push('nudge', n.label, n.points);
        break;
      default:
        break;
    }
  }
}

/** Human label for a ski-quality score. */
export function skiQualityLabel(score) {
  if (!isNum(score)) return 'نامشخص';
  if (score >= 80) return 'عالی';
  if (score >= 65) return 'خوب';
  if (score >= 50) return 'متوسط';
  if (score >= 35) return 'ضعیف';
  return 'خیلی ضعیف';
}
