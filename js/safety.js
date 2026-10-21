/**
 * SnowF — Safety Engine + Weather-Related Mountain Risk (ESTIMATES).
 *
 * Two outputs:
 *  1. Safety score (0-100, higher = safer) with factor breakdown.
 *  2. Mountain-risk band (low/moderate/elevated/high) — a weather-based
 *     ESTIMATE. It is deliberately NOT a 1-5 EAWS avalanche scale and every
 *     consumer must show RISK.disclaimer next to it.
 *
 * Anti double-counting: the risk index influences safety through CAPS
 * (riskCaps), not additional subtractions.
 *
 * Pure module: no DOM, no network. Safe to unit-test in Node.
 */

import { SAFETY, RISK, FLAGS } from './config.js';
import { isNum } from './weather.js';

function bandMaxPoints(bands, value) {
  for (const b of bands) {
    if (value <= b.max) return b.points;
  }
  return bands[bands.length - 1].points;
}
function bandMinPoints(bands, value) {
  for (const b of bands) {
    if (value >= b.min) return b.points;
  }
  return bands[bands.length - 1].points;
}

/**
 * Mountain-risk estimate from weather signals.
 * @param {object} ctx { fresh24hCm, snowRateMax, gustKmh, warming24h,
 *                       rainMm, depthCm, freezingLevelM, stationAltM, visKm }
 */
export function calculateMountainRisk(ctx = {}) {
  let points = 0;
  const drivers = [];
  const push = (label, pts) => {
    points += pts;
    drivers.push({ label, points: pts });
  };

  const fresh = isNum(ctx.fresh24hCm) ? ctx.fresh24hCm : 0;
  const rate = isNum(ctx.snowRateMax) ? ctx.snowRateMax : 0;
  const gust = isNum(ctx.gustKmh) ? ctx.gustKmh : 0;

  // New-snow load.
  for (const b of RISK.fresh24h) {
    if (fresh >= b.min) {
      if (b.points > 0) push(`برف تازه ${Math.round(fresh)} سانتی‌متر در ۲۴ ساعت`, b.points);
      break;
    }
  }
  // Intensity.
  if (rate >= RISK.intensityRate.min) push(`شدت بارش بالا (بیش از ${RISK.intensityRate.min} سانتی‌متر بر ساعت)`, RISK.intensityRate.points);

  // Wind loading / drifted snow (flag, never asserted as "certain avalanche").
  const wl = RISK.windLoading;
  if (fresh >= wl.freshMin && gust >= wl.gustHigh) {
    push(`انباشت برف توسط باد (گاست ${Math.round(gust)} km/h)`, wl.highPoints);
  } else if (fresh >= wl.freshMin && gust >= wl.gustMid) {
    push(`احتمال انباشت برف توسط باد (گاست ${Math.round(gust)} km/h)`, wl.midPoints);
  }

  // Rapid warming.
  if (isNum(ctx.warming24h) && ctx.warming24h >= RISK.warming24h.min) {
    push(`گرم‌شدن سریع (${Math.round(ctx.warming24h)}° در ۲۴ ساعت)`, RISK.warming24h.points);
  }

  // Rain on snow.
  const rain = isNum(ctx.rainMm) ? ctx.rainMm : 0;
  if (rain >= RISK.rainOnSnow.rainMin && isNum(ctx.depthCm) && ctx.depthCm >= RISK.rainOnSnow.depthMin) {
    push(`باران روی برف (${rain} م‌م)`, RISK.rainOnSnow.points);
  }

  // Freezing level above the station → warmer / wetter snowpack.
  if (isNum(ctx.freezingLevelM) && isNum(ctx.stationAltM) && ctx.freezingLevelM > ctx.stationAltM) {
    push(`سطح انجماد (${Math.round(ctx.freezingLevelM)} م) بالاتر از ایستگاه`, RISK.freezingLevelAboveStation.points);
  }

  // Very low visibility (awareness / rescue consideration).
  if (isNum(ctx.visKm) && ctx.visKm < RISK.lowVisibility.maxKm) {
    push('دید بسیار محدود', RISK.lowVisibility.points);
  }

  const band = RISK.bands.find((b) => points <= b.max) || RISK.bands[RISK.bands.length - 1];
  const windLoading =
    fresh >= FLAGS.windLoading.freshMin && gust >= FLAGS.windLoading.gustMin;

  return {
    points,
    band: band.id,
    label: band.label,
    icon: band.icon,
    drivers,
    windLoading,
    estimated: true,
    disclaimer: RISK.disclaimer,
  };
}

/**
 * Safety score (0-100).
 * @param {object} ctx { gustKmh, sustainedKmh, visKm, snowRateMax,
 *     rainOnSnow: {active,severe}, freezingRain: {likely,strong},
 *     warming24h, feelsMinC, capeMax, liMin, deteriorating (bool) }
 * @param {object} risk — output of calculateMountainRisk (for caps)
 */
export function calculateSafetyScore(ctx = {}, risk = null) {
  const factors = [];
  const flags = [];
  const add = (key, label, points, detail = null) => {
    if (points !== 0 || detail) factors.push({ key, label, points, detail });
  };

  // Wind — gust primary; sustained-derived estimate as fallback.
  let gust = isNum(ctx.gustKmh) ? ctx.gustKmh : null;
  let gustEstimated = false;
  if (gust === null && isNum(ctx.sustainedKmh)) {
    gust = ctx.sustainedKmh * SAFETY.gustFallbackFactor;
    gustEstimated = true;
  }
  const windKnown = gust !== null;
  if (windKnown) {
    const pts = bandMaxPoints(SAFETY.gust, gust);
    add('gust', pts === 0 ? 'باد در محدوده امن' : `گاست ${Math.round(gust)} km/h${gustEstimated ? ' (تخمینی)' : ''}`, pts);
  } else {
    add('gust', 'داده باد موجود نیست', 0, 'سقف ایمنی به‌خاطر نبود داده باد');
  }

  // Visibility.
  const visKnown = isNum(ctx.visKm);
  if (visKnown) {
    const pts = bandMinPoints(SAFETY.visibilityKm, ctx.visKm);
    add('visibility', pts === 0 ? 'دید کافی' : `دید ${ctx.visKm} کیلومتر`, pts);
  } else {
    add('visibility', 'داده دید موجود نیست', 0, 'سقف ایمنی به‌خاطر نبود داده دید');
  }

  // Heavy snowfall rate.
  if (isNum(ctx.snowRateMax)) {
    const pts = bandMaxPoints(SAFETY.snowfallRateCmH, ctx.snowRateMax);
    if (pts !== 0) add('snow-rate', `شدت بارش ${ctx.snowRateMax} سانتی‌متر بر ساعت`, pts);
  }

  // Rain on snow.
  if (ctx.rainOnSnow && ctx.rainOnSnow.active) {
    const pts = ctx.rainOnSnow.severe ? SAFETY.rainOnSnow.points : SAFETY.rainOnSnow.mildPoints;
    add('rain-on-snow', 'باران روی برف', pts);
    flags.push({ id: 'rain-on-snow', label: '🌧️ باران روی برف — سطح لغزنده و سنگین' });
  }

  // Freezing rain (estimate).
  if (ctx.freezingRain && ctx.freezingRain.likely) {
    add('freezing-rain', ctx.freezingRain.label || 'احتمال باران یخ‌زده (برآورد)', SAFETY.freezingRain.points);
    flags.push({
      id: 'freezing-rain',
      label: ctx.freezingRain.strong ? '🧊 خطر جدی باران یخ‌زده (برآورد)' : '🧊 احتمال باران یخ‌زده (برآورد)',
    });
  }

  // Rapid warming.
  if (isNum(ctx.warming24h)) {
    const pts = bandMinPoints(SAFETY.warming24h, ctx.warming24h);
    if (pts !== 0) add('warming', `گرم‌شدن ${Math.round(ctx.warming24h)}° در ۲۴ ساعت`, pts);
  }

  // Extreme cold (feels-like minimum).
  if (isNum(ctx.feelsMinC)) {
    const pts = bandMinPoints(SAFETY.feelsLikeMin, ctx.feelsMinC);
    if (pts !== 0) add('cold', `سرمای شدید (احساس ${Math.round(ctx.feelsMinC)}°)`, pts);
  }

  // Convection — ONE combined factor.
  {
    const cape = isNum(ctx.capeMax) ? ctx.capeMax : 0;
    const li = isNum(ctx.liMin) ? ctx.liMin : 99;
    const b = SAFETY.convection.find((x) => cape >= x.cape || li <= x.li) || SAFETY.convection[SAFETY.convection.length - 1];
    if (b.points !== 0) {
      add('convection', `${b.label} (CAPE ${Math.round(cape)})`, b.points);
      flags.push({ id: 'convection', label: `⚡ ${b.label}` });
    }
  }

  // Sudden deterioration.
  if (ctx.deteriorating) {
    add('deterioration', SAFETY.deterioration.label, SAFETY.deterioration.points);
    flags.push({ id: 'deteriorating', label: '📉 شرایط در ساعات آینده بدتر می‌شود' });
  }

  let score = SAFETY.base + factors.reduce((s, f) => s + (f.points || 0), 0);

  // Risk-index CAP (not a subtraction → no double counting).
  let capApplied = null;
  if (risk && SAFETY.riskCaps[risk.band] !== undefined) {
    const cap = SAFETY.riskCaps[risk.band];
    if (score > cap) {
      capApplied = { band: risk.band, cap, label: `سقف ایمنی به‌خاطر ریسک ${risk.label} کوهستان` };
      score = cap;
    }
  }

  // Missing-critical-data CAPS: we cannot claim "safe" for factors we could
  // not verify. Wind and visibility are the two primary ski-safety inputs.
  if (!windKnown && score > SAFETY.missingWindCap) {
    capApplied = { band: 'missing-wind', cap: SAFETY.missingWindCap, label: 'سقف ایمنی به‌خاطر نبود داده باد' };
    score = SAFETY.missingWindCap;
  }
  if (!visKnown && score > SAFETY.missingVisCap) {
    capApplied = { band: 'missing-visibility', cap: SAFETY.missingVisCap, label: 'سقف ایمنی به‌خاطر نبود داده دید' };
    score = SAFETY.missingVisCap;
  }

  // Hard stops.
  const hardStops = [];
  if (gust !== null && gust > SAFETY.hardStops.gustKmh) {
    hardStops.push({ id: 'gust', label: `گاست توفنده ${Math.round(gust)} km/h` });
  }
  if (isNum(ctx.visKm) && ctx.visKm < SAFETY.hardStops.visibilityKm) {
    hardStops.push({ id: 'visibility', label: `دید بحرانی (${ctx.visKm} کیلومتر)` });
  }
  if (ctx.freezingRain && ctx.freezingRain.strong) {
    hardStops.push({ id: 'freezing-rain', label: 'احتمال قوی باران یخ‌زده' });
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, factors, flags, capApplied, hardStops, gustEstimated };
}

/** Human label for a safety score. */
export function safetyLabel(score) {
  if (!isNum(score)) return 'نامشخص';
  if (score >= 80) return 'امن';
  if (score >= 65) return 'قابل قبول';
  if (score >= 40) return 'نیازمند احتیاط';
  return 'ناامن';
}
