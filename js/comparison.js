/**
 * SnowF — Comparison & "best of" engines.
 *  - rankResorts: "امروز کجا بریم؟"
 *  - rankDays: best ski days ahead for one resort
 *  - snowOpportunity: is a snowy day worth waiting for?
 *  - findBestPick: "اگر فقط یک روز فرصت داری" (resort × day in one shot)
 *
 * Ranking is lexicographic by verdict first (go > caution > avoid), THEN by
 * a combined quality/safety blend — a dangerous powder day can never outrank
 * a safe good day.
 *
 * Every candidate may carry `minSafety` / `minSafetyZone` (the worst station
 * of that resort-day). The verdict engine treats it as an independent floor,
 * so a resort with one dangerous station cannot be crowned on its average.
 *
 * Pure module: no DOM, no network. Safe to unit-test in Node.
 */

import { OPPORTUNITY } from './config.js';
import { isNum } from './weather.js';
import { decide } from './recommendation.js';

const VERDICT_ORDER = { go: 0, caution: 1, avoid: 2 };

/** Combined resort-day number used only to order WITHIN the same verdict. */
function blendScore(ski, safety) {
  const q = isNum(ski) ? ski : 0;
  const s = isNum(safety) ? safety : 0;
  return Math.round(q * 0.6 + s * 0.4);
}

/** Build the verdict for one candidate row (shared by every ranking). */
function verdictFor(row) {
  return decide({
    ski: row.ski,
    safety: row.safety,
    minSafety: row.minSafety,
    minSafetyZone: row.minSafetyZone,
    depthCm: row.depthCm,
    hardStops: row.hardStops,
    riskBand: row.risk?.band,
  });
}

/** Attach verdict + blend + medal to a list of rows, sorted best-first. */
function rankRows(list = []) {
  const rows = list
    .filter((r) => r && !r.failed)
    .map((r) => {
      const d = r.verdict && r.verdict.verdict ? r.verdict : verdictFor(r);
      return { ...r, verdict: d, blend: blendScore(r.ski, r.safety) };
    })
    .sort((a, b) => VERDICT_ORDER[a.verdict.verdict] - VERDICT_ORDER[b.verdict.verdict] || b.blend - a.blend);
  const medals = ['🥇', '🥈', '🥉'];
  rows.forEach((r, i) => {
    r.medal = medals[i] || `${i + 1}.`;
    r.rank = i + 1;
  });
  return rows;
}

/**
 * Rank analyzed resort-days for "where should we go?".
 * @param {Array} list of analyzeResortDay outputs (+ verdict attached by caller or here)
 */
export function rankResorts(list = []) {
  return rankRows(list);
}

/**
 * Rank future days for ONE resort (best ski days ahead).
 * @param {Array} days array of { dayIndex, date, ski, safety, snowScore, fresh, wind, visKm, depthCm, risk, hardStops }
 */
export function rankDays(days = [], topN = 3) {
  return rankRows(days).slice(0, topN);
}

/**
 * Snow Opportunity index (0-100): should a snow-watcher get excited?
 * Heavy snow + strong wind is CAPPED (wind-affected, not dreamy).
 */
export function snowOpportunity(ctx = {}) {
  const factors = [];
  let score = 0;
  const fresh = isNum(ctx.freshCm) ? ctx.freshCm : 0;
  const prob = isNum(ctx.probPct) ? ctx.probPct : 0;
  const tempMax = isNum(ctx.tempMaxC) ? ctx.tempMaxC : null;
  const gust = isNum(ctx.gustKmh) ? ctx.gustKmh : 0;

  for (const b of OPPORTUNITY.freshFcstCm) {
    if (fresh >= b.min) {
      score += b.points;
      if (b.points > 0) factors.push({ label: `پیش‌بینی ${Math.round(fresh)} سانتی‌متر برف`, points: b.points });
      break;
    }
  }
  for (const b of OPPORTUNITY.probability) {
    if (prob >= b.min) {
      score += b.points;
      if (b.points > 0) factors.push({ label: `احتمال بارش ${Math.round(prob)}٪`, points: b.points });
      break;
    }
  }
  if (tempMax !== null && tempMax <= OPPORTUNITY.tempOk.max) {
    score += OPPORTUNITY.tempOk.points;
    factors.push({ label: 'دمای مناسب بارش برف', points: OPPORTUNITY.tempOk.points });
  }
  for (const b of OPPORTUNITY.windOk) {
    if (gust <= b.max) {
      score += b.points;
      if (b.points !== 0) factors.push({ label: `باد/گاست ${Math.round(gust)} km/h`, points: b.points });
      break;
    }
  }
  if (ctx.persistCold) {
    score += OPPORTUNITY.persistence.points;
    factors.push({ label: 'ماندگاری برف (هوای سرد ادامه‌دار)', points: OPPORTUNITY.persistence.points });
  }

  let capped = false;
  const wa = OPPORTUNITY.windAffected;
  if (fresh >= wa.freshMin && gust >= wa.gustMin && score > OPPORTUNITY.windAffectedCap) {
    score = OPPORTUNITY.windAffectedCap;
    capped = true;
    factors.push({ label: 'سقف: برف سنگین همراه باد شدید (بادخورده)', points: 0 });
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const label = score >= 70 ? 'عالی — ارزش برنامه‌ریزی دارد' : score >= 50 ? 'خوب' : score >= 30 ? 'متوسط' : 'کم';
  return { score, label, factors, capped };
}

/**
 * "If you have just ONE day": scan resorts × days(0..maxDay) and return the
 * single best (resort, day) + top 3 reasons.
 * @param {Array} candidates [{ resortId, nameFa, dayIndex, date, ski, safety, snowScore, fresh, wind, gust, visKm, depthCm, risk, hardStops, window }]
 */
export function findBestPick(candidates = []) {
  const rows = rankRows(candidates);
  if (!rows.length) return null;
  const best = rows[0];
  const reasons = [];
  if (isNum(best.fresh) && best.fresh >= 5) reasons.push(`❄️ ${Math.round(best.fresh)} سانتی‌متر برف تازه`);
  else if (isNum(best.snowScore) && best.snowScore >= 65) reasons.push('❄️ کیفیت خوب برف');
  if (isNum(best.wind) && best.wind <= 25) reasons.push(`💨 باد مناسب (${Math.round(best.wind)} km/h)`);
  if (isNum(best.visKm) && best.visKm >= 8) reasons.push('👁️ دید خوب');
  if (isNum(best.safety) && best.safety >= 80) reasons.push(`🛡 ایمنی بالا (${best.safety}/۱۰۰)`);
  if (isNum(best.ski) && best.ski >= 75) reasons.push(`🎿 کیفیت اسکی ${best.ski}/۱۰۰`);
  if (!reasons.length) reasons.push(`بهترین ترکیب موجود (امتیاز ${best.blend})`);
  return { ...best, reasons: reasons.slice(0, 3) };
}

/** Rows for the professional comparison table. */
export function compareTableRows(ranked = []) {
  return ranked.map((r) => ({
    resortId: r.resortId,
    nameFa: r.nameFa,
    medal: r.medal,
    verdict: r.verdict,
    ski: r.ski,
    safety: r.safety,
    minSafety: r.minSafety,
    snow: r.snowScore,
    wind: r.wind,
    gust: r.gust,
    visKm: r.visKm,
    fresh: r.fresh24hCm,
    depth: r.depthCm,
    risk: r.risk,
  }));
}
