/**
 * SnowF — Snow Surface Quality Engine (ESTIMATE).
 *
 * Answers: "given that snow exists, what is its likely surface condition?"
 * It deliberately does NOT consider snow depth (depth = viability, scored in
 * Ski Quality) and does NOT claim certainty. Every output carries the
 * "estimate" framing required by the product spec.
 *
 * Pure module: no DOM, no network. Safe to unit-test in Node.
 */

import { SNOW, FLAGS } from './config.js';
import { isNum } from './weather.js';

const SURFACE_LABELS = {
  powder: 'پودر ❄',
  fresh: 'تازه ❄',
  packed: 'کوبیده و مناسب',
  firm: 'سفت',
  windAffected: 'بادخورده',
  refrozen: 'احتمالاً یخ‌زده',
  wet: 'خیس / آبکی',
  poor: 'نامناسب',
  unknown: 'نامشخص',
};

/**
 * @param {object} ctx
 *   { tempC, rainMm, freshCm, refreeze, windMaxKmh, snowRateMax,
 *     tempTrend: 'warming'|'cooling'|'stable'|null }
 * @returns {{ score, category, label, estimated: true, factors }}
 */
export function estimateSnowSurface(ctx = {}) {
  const factors = [];
  const add = (key, label, points, detail = null) => {
    if (points !== 0) factors.push({ key, label, points, detail });
  };

  let score = SNOW.base;
  const tempC = isNum(ctx.tempC) ? ctx.tempC : null;
  const rainMm = isNum(ctx.rainMm) ? ctx.rainMm : 0;
  const freshCm = isNum(ctx.freshCm) ? ctx.freshCm : 0;
  const windMax = isNum(ctx.windMaxKmh) ? ctx.windMaxKmh : 0;

  // Fresh snow rebuilds the surface (freshness, not depth).
  if (freshCm >= SNOW.freshGood.min) add('fresh', `برف تازه ${Math.round(freshCm)} سانتی‌متر`, SNOW.freshGood.points);
  else if (freshCm >= SNOW.freshSome.min) add('fresh', `برف تازه ${Math.round(freshCm)} سانتی‌متر`, SNOW.freshSome.points);
  else if (freshCm <= 0) add('no-fresh', 'بدون برف تازه اخیر', 0);

  // Ideal cold, dry window.
  if (tempC !== null && tempC >= SNOW.idealTemp.min && tempC <= SNOW.idealTemp.max) {
    add('ideal-temp', 'دمای ایده‌آل برای حفظ برف', SNOW.idealTemp.points);
  }

  // Rain destroys surface quality fast.
  if (rainMm >= SNOW.rainWet.min) {
    add('rain', `${SNOW.rainWet.label} (${rainMm} م‌م)`, SNOW.rainWet.points);
  }
  // Warm air softens / melts.
  if (tempC !== null && tempC > SNOW.warmMelt.min) {
    add('melt', `${SNOW.warmMelt.label} (${tempC}°)`, SNOW.warmMelt.points);
  } else if (tempC !== null && tempC > SNOW.warmSoft.min) {
    add('soft', `${SNOW.warmSoft.label} (${tempC}°)`, SNOW.warmSoft.points);
  }
  // Refreeze after melt → hard / icy crust likely.
  if (ctx.refreeze) add('refreeze', SNOW.refreeze.label, SNOW.refreeze.points);

  // Wind scouring.
  const scour = SNOW.windScour.find((b) => windMax <= b.max) || { points: 0 };
  if (scour.points !== 0) add('wind', `باد شدید (${Math.round(windMax)} km/h)`, scour.points);

  // Very heavy ongoing snowfall → deep, tiring, unconsolidated.
  if (isNum(ctx.snowRateMax) && ctx.snowRateMax >= SNOW.heavyOngoingSnow.rate) {
    add('heavy-snow', 'برف سنگینِ در حال بارش', SNOW.heavyOngoingSnow.points);
  }

  // Warming trend after snowfall degrades powder quickly.
  if (ctx.tempTrend === 'warming' && freshCm >= 4) {
    add('warming', 'روند گرم‌شدن بعد از بارش', -4);
  }

  for (const f of factors) score += f.points;
  score = Math.max(0, Math.min(100, Math.round(score)));

  const category = classifySurface({ score, tempC, rainMm, freshCm, windMax, refreeze: !!ctx.refreeze });

  return {
    score,
    category,
    label: SURFACE_LABELS[category] || SURFACE_LABELS.unknown,
    estimated: true,
    factors,
  };
}

function classifySurface({ score, tempC, rainMm, freshCm, windMax, refreeze }) {
  const wet = rainMm >= SNOW.rainWet.min || (tempC !== null && tempC > SNOW.warmMelt.min);
  if (wet) return 'wet';
  if (refreeze && (tempC === null || tempC <= 0)) return 'refrozen';
  const p = SNOW.powder;
  if (freshCm >= p.freshMin && (tempC === null || tempC <= p.tempMax) && windMax <= p.windMax && score >= 70) {
    return 'powder';
  }
  if (freshCm >= SNOW.freshSome.min && score >= 62) return 'fresh';
  if (windMax > 50) return 'windAffected';
  if (score >= 62) return 'packed';
  if (score >= 40) return 'firm';
  if (score > 0) return 'poor';
  return 'unknown';
}

/**
 * Refreeze / hard-snow likelihood (ESTIMATE):
 * previous day thawed (max > ~0.5°), night froze (min < -1°),
 * and the morning is still below freezing.
 *
 * @returns {{ likely: boolean, label: string|null, detail: string|null }}
 */
export function detectRefreeze({ prevDayMax = null, nightMin = null, morningTemp = null } = {}) {
  const f = FLAGS.refreeze;
  const thawed = isNum(prevDayMax) && prevDayMax > f.prevDayMaxAbove;
  const froze = isNum(nightMin) && nightMin < f.nightMinBelow;
  const stillCold = isNum(morningTemp) && morningTemp < f.morningBelow;

  if (!isNum(prevDayMax) || !isNum(nightMin) || !isNum(morningTemp)) {
    return { likely: false, label: null, detail: null };
  }
  if (thawed && froze && stillCold) {
    return {
      likely: true,
      label: 'احتمال یخ‌زدگی / برف سفت',
      detail: `دیروز دما تا ${Math.round(prevDayMax)}° بالا رفته و شب تا ${Math.round(nightMin)}° پایین آمده`,
    };
  }
  return { likely: false, label: null, detail: null };
}

/**
 * Rain-on-snow detection (ESTIMATE).
 * @returns {{ active: boolean, severe: boolean, label: string|null }}
 */
export function detectRainOnSnow({ rainMm = 0, snowDepthCm = 0 } = {}) {
  const f = FLAGS.rainOnSnow;
  const rain = isNum(rainMm) ? rainMm : 0;
  const depth = isNum(snowDepthCm) ? snowDepthCm : 0;
  if (rain >= f.rainMm && depth >= f.depthCm) {
    return {
      active: true,
      severe: rain >= f.severeRainMm,
      label: rain >= f.severeRainMm ? '🌧️ باران قابل توجه روی برف' : '🌧️ باران خفیف روی برف (برآورد)',
    };
  }
  return { active: false, severe: false, label: null };
}

/**
 * Freezing-rain likelihood (ESTIMATE — never asserted as certain).
 * Heuristic: precipitation falling while surface temp hovers around 0°C
 * with very moist air. Open-Meteo has no direct freezing-rain variable
 * on this endpoint, so this is explicitly an estimate.
 */
export function detectFreezingRain({ precipMm = 0, tempC = null, humidity = null } = {}) {
  const f = FLAGS.freezingRain;
  const precip = isNum(precipMm) ? precipMm : 0;
  if (!isNum(tempC)) return { likely: false, strong: false, label: null };
  const inWindow = tempC >= f.tempMin && tempC <= f.tempMax;
  const wetAir = !isNum(humidity) || humidity >= f.humidityMin;
  if (precip >= f.precipMin && inWindow && wetAir) {
    const strong = precip >= 2;
    return {
      likely: true,
      strong,
      label: strong ? '🌧️🧊 احتمال قوی باران یخ‌زده (برآورد)' : '🌧️🧊 احتمال باران یخ‌زده (برآورد)',
    };
  }
  return { likely: false, strong: false, label: null };
}
