/**
 * SnowF — Recommendation Engine (Explainable Decision Engine).
 *
 * Produces the final verdict (GO / CAUTION / AVOID) plus:
 *  - best ski-time window for the day (from hourly scores)
 *  - best elevation (summit / mid / low) with reason
 *  - "why" explanation (pros / cons / notes)
 *  - confidence + trend
 *
 * THE SAFETY OVERRIDE (hard rule): if safety is low, the verdict can NEVER
 * be GO — no matter how good the snow/quality is. The resort verdict is
 * additionally floored by the WORST station, so one dangerous station can
 * never be averaged away by two calm ones.
 *
 * Pure module: no DOM, no network. Safe to unit-test in Node.
 */

import { VERDICT, SKI_HOURS, CONFIDENCE, FLAGS, SAFETY, MODEL } from './config.js';
import { isNum, feelsLike, r0, inSkiWindow, haversineKm } from './weather.js';

export const VERDICTS = {
  go: { id: 'go', icon: '🟢', label: 'مناسب برای اسکی', short: 'برو' },
  caution: { id: 'caution', icon: '🟡', label: 'قابل اسکی با احتیاط', short: 'احتیاط' },
  avoid: { id: 'avoid', icon: '🔴', label: 'نامناسب برای اسکی', short: 'نرو' },
};

/**
 * Final verdict for a resort-day (or location-day — same shape).
 * Single mode (no user profiles): one fixed, documented gate.
 *
 * @param {object} a
 *   { ski, safety, depthCm, risk }  — resort-level numbers
 *   { minSafety, minSafetyZone }    — worst station (independent safety floor)
 *   { hardStops }                   — any hard stop anywhere in the resort
 */
export function decide(a = {}) {
  const ski = num(a.ski);
  const safety = num(a.safety);
  const minSafety = num(a.minSafety);
  const depth = isNum(a.depthCm) ? a.depthCm : null;
  const hardStops = a.hardStops || a.safetyHardStops || [];
  const riskBand = a.risk?.band || a.riskBand || 'low';

  const gate = {
    safetyMin: VERDICT.safetyCautionBelow,
    qualityMin: VERDICT.qualityCautionBelow,
    stationSafetyMin: SAFETY.stationSafetyFloor.cautionBelow,
  };
  const reasons = [];
  let verdict = 'go';

  // 1) Hard stops → AVOID, always.
  if (hardStops.length) {
    return {
      verdict: 'avoid',
      ...VERDICTS.avoid,
      reasons: hardStops.map((h) => (typeof h === 'string' ? h : h.label)),
      safetyGate: true,
      gate,
    };
  }
  // 2) Safety override → AVOID.
  if (isNum(safety) && safety < VERDICT.safetyAvoidBelow) {
    reasons.push(`ایمنی پایین (${safety}/۱۰۰)`);
    return { verdict: 'avoid', ...VERDICTS.avoid, reasons, safetyGate: true, gate };
  }
  // 2b) Worst-station safety floor → AVOID, even if the average looks fine.
  if (isNum(minSafety) && minSafety < SAFETY.stationSafetyFloor.avoidBelow) {
    const where = a.minSafetyZone ? ` (${a.minSafetyZone})` : '';
    reasons.push(`ایمنی یکی از ایستگاه‌ها بسیار پایین است${where} (${minSafety}/۱۰۰)`);
    return { verdict: 'avoid', ...VERDICTS.avoid, reasons, safetyGate: true, gate };
  }
  // 3) No snow → AVOID (likely thin cover / closed).
  if (depth !== null && depth < VERDICT.minDepthCm) {
    reasons.push(`برف ناکافی (${depth} سانتی‌متر) — احتمال بسته بودن پیست`);
    return { verdict: 'avoid', ...VERDICTS.avoid, reasons, safetyGate: false, gate };
  }
  // 4) Terrible quality → AVOID.
  if (isNum(ski) && ski < VERDICT.qualityAvoidBelow) {
    reasons.push(`کیفیت خیلی پایین (${ski}/۱۰۰)`);
    return { verdict: 'avoid', ...VERDICTS.avoid, reasons, safetyGate: false, gate };
  }
  // 5) Safety caution zone → at most CAUTION.
  if (isNum(safety) && safety < gate.safetyMin) {
    reasons.push(`ایمنی ${safety}/۱۰ — برای رأی «برو» حداقل ${gate.safetyMin} لازم است`);
    verdict = 'caution';
  }
  // 5b) Worst-station safety floor → at most CAUTION.
  if (isNum(minSafety) && minSafety < gate.stationSafetyMin) {
    const where = a.minSafetyZone ? ` (${a.minSafetyZone})` : '';
    reasons.push(`ایمنی ضعیف‌ترین ایستگاه${where} (${minSafety}/۱۰۰) — حداقل ${gate.stationSafetyMin} لازم است`);
    verdict = 'caution';
  }
  // 6) Quality caution zone → at most CAUTION.
  if (isNum(ski) && ski < gate.qualityMin) {
    reasons.push(`کیفیت متوسط (${ski}/۱۰۰)`);
    verdict = 'caution';
  }
  // 7) Elevated mountain risk caps enthusiasm.
  if ((riskBand === 'elevated' || riskBand === 'high') && verdict === 'go') {
    reasons.push(`ریسک جوی کوهستان: ${riskBand === 'high' ? 'خیلی بالا' : 'بالا'} (برآورد)`);
    verdict = 'caution';
  }

  if (verdict === 'go') reasons.push('ترکیب کیفیت و ایمنی مناسب است');
  return {
    verdict,
    ...VERDICTS[verdict],
    reasons,
    safetyGate: verdict !== 'go' && ((isNum(safety) && safety < gate.safetyMin) || (isNum(minSafety) && minSafety < gate.stationSafetyMin)),
    gate,
  };
}

function num(v) {
  if (isNum(v)) return v;
  if (v && isNum(v.score)) return v.score;
  return null;
}

// ---------------------------------------------------------------------------
// Hourly ski score + best window
// ---------------------------------------------------------------------------

/**
 * Lightweight hourly score (0-100) for the daytime timeline.
 * Uses the same anti-double-counting principles (single effective wind).
 */
export function hourlySkiScore(h = {}, depthCm = null) {
  let s = 60;
  const notes = [];
  const effWind = Math.max(isNum(h.wind) ? h.wind : 0, (isNum(h.gust) ? h.gust : 0) * 0.65);

  if (effWind <= 15) s += 6;
  else if (effWind <= 25) s += 0;
  else if (effWind <= 35) { s -= 10; notes.push('باد'); }
  else if (effWind <= 45) { s -= 20; notes.push('باد شدید'); }
  else { s -= 30; notes.push('باد توفنده'); }

  const vis = isNum(h.visKm) ? h.visKm : null;
  if (vis === null) { /* unknown — no nudge */ }
  else if (vis >= 8) s += 4;
  else if (vis >= 3) s += 0;
  else if (vis >= 1) { s -= 10; notes.push('دید کم'); }
  else { s -= 20; notes.push('دید بحرانی'); }

  const feels = feelsLike(h.temp, h.appTemp, h.wind);
  if (isNum(feels)) {
    if (feels >= -9 && feels <= 0) s += 8;
    else if (feels >= -13 && feels < -9) s += 3;
    else if (feels < -17) { s -= 8; notes.push('سرمای شدید'); }
    else if (feels > 2) { s -= 6; notes.push('گرما'); }
  }

  const snowRate = isNum(h.snowfall) ? h.snowfall : 0;
  const rain = isNum(h.rain) ? h.rain : 0;
  if (rain >= 0.5) { s -= 12; notes.push('باران'); }
  else if (rain > 0) { s -= 5; notes.push('نم‌باران'); }
  else if (snowRate >= 2) { s -= 8; notes.push('برف سنگین'); }
  else if (snowRate >= 0.8) { s -= 3; notes.push('برف متوسط'); }
  else if (snowRate >= 0.1) { s += 3; }

  if (isNum(h.cloud) && h.cloud > 85 && snowRate > 0.3) s -= 4;
  if (h.isDay === 0) { s -= 4; notes.push('تاریکی'); }
  if (depthCm !== null && depthCm < 8) s -= 15;

  return { score: Math.max(0, Math.min(100, Math.round(s))), effWind: Math.round(effWind), notes };
}

/**
 * Best contiguous ski window within SKI_HOURS.
 * The window is HALF-OPEN: `start` inclusive, `end` exclusive, so a window
 * of 07:00–16:00 contains the hourly rows 07:00 … 15:00 and is labelled
 * "07:00 تا 16:00" (never one hour past the end).
 *
 * @param {Array} hours normalized hour rows (full day)
 * @param {number|null} fromHour skip past hours for "today"
 * @param {number|null} depthCm
 */
export function findBestWindow(hours = [], fromHour = null, depthCm = null, window = SKI_HOURS) {
  const rows = hours
    .filter((r) => inSkiWindow(r.hour, window) && (fromHour === null || r.hour >= fromHour))
    .map((r) => ({ ...r, hs: hourlySkiScore(r, depthCm) }));
  if (!rows.length) {
    return { available: false, reason: 'ساعت‌های اسکی امروز گذشته است — فردا را بررسی کن' };
  }
  // Best contiguous block of >= minWindowHours (max average).
  let best = null;
  const minLen = Math.min(window.minWindowHours, rows.length);
  for (let len = rows.length; len >= minLen; len--) {
    for (let i = 0; i + len <= rows.length; i++) {
      const slice = rows.slice(i, i + len);
      const avg = slice.reduce((s, r) => s + r.hs.score, 0) / len;
      // Prefer longer windows slightly (stability): tiny bonus per extra hour.
      const adj = avg + len * 0.4;
      if (!best || adj > best.adj) {
        best = { start: slice[0].hour, end: slice[slice.length - 1].hour + 1, avg: Math.round(avg), adj, slice };
      }
    }
    if (best && len <= 4) break; // don't search tiny fragments once a good block exists
  }
  const why = windowReasons(best.slice);
  return {
    available: true,
    start: best.start,
    end: best.end,
    label: `${pad(best.start)}:00 تا ${pad(best.end)}:00`, // latin digits; UI converts via faNum()
    avgScore: best.avg,
    hours: rows.map((r) => ({ hour: r.hour, score: r.hs.score, notes: r.hs.notes })),
    why,
  };
}

function pad(h) {
  return String(h).padStart(2, '0');
}

function windowReasons(slice = []) {
  const why = [];
  if (!slice.length) return why;
  const avgWind = avg(slice.map((r) => r.hs.effWind));
  const minVis = Math.min(...slice.map((r) => (isNum(r.visKm) ? r.visKm : 99)));
  const totalSnow = slice.reduce((s, r) => s + (isNum(r.snowfall) ? r.snowfall : 0), 0);
  const totalRain = slice.reduce((s, r) => s + (isNum(r.rain) ? r.rain : 0), 0);
  if (avgWind !== null && avgWind <= 20) why.push(`باد مناسب (حدود ${Math.round(avgWind)} km/h)`);
  else if (avgWind !== null) why.push(`باد حدود ${Math.round(avgWind)} km/h`);
  if (minVis >= 8) why.push('دید خوب');
  else if (minVis < 3) why.push('دید محدود');
  if (totalRain >= 0.5) why.push('همراه با باران');
  else if (totalSnow >= 1) why.push(`حدود ${Math.round(totalSnow * 10) / 10} سانتی‌متر برف در همین بازه`);
  else if (totalSnow > 0) why.push('ته‌نشست خفیف برف');
  return why;
}

function avg(a) {
  const b = a.filter(isNum);
  return b.length ? b.reduce((s, v) => s + v, 0) / b.length : null;
}

// ---------------------------------------------------------------------------
// Best elevation
// ---------------------------------------------------------------------------

/**
 * Pick the best station for the day + explain the gap.
 *
 * HONESTY NOTE: Open-Meteo serves a ~11 km grid. Two stations of the same
 * resort frequently land in the SAME grid cell, in which case they share
 * wind, cloud and precipitation and differ only by the interpolated
 * temperature. We detect that and say so instead of presenting an
 * artefact as a real elevation difference.
 */
export function bestElevation(locationAnalyses = []) {
  const ok = locationAnalyses.filter((a) => a && !a.failed);
  if (!ok.length) return { available: false, reason: 'داده‌ای موجود نیست' };
  // Rank by ski score, but a station with avoid-level safety can't win.
  const ranked = ok
    .map((a) => {
      const d = decide(
        { ski: a.ski.score, safety: a.safety.score, depthCm: a.depthCm, hardStops: a.safety.hardStops, riskBand: a.risk.band }
      );
      return { a, d, rank: (d.verdict === 'avoid' ? -1000 : d.verdict === 'caution' ? -100 : 0) + a.ski.score + a.safety.score / 10 };
    })
    .sort((x, y) => y.rank - x.rank);
  const winner = ranked[0];
  const runner = ranked[1];
  const reasons = [];
  if (runner) {
    const dw = winner.a.wind ?? 99;
    const dr = runner.a.wind ?? 99;
    if (dr - dw >= 10) reasons.push(`باد کمتر نسبت به ${runner.a.shortFa} (${r0(dw)} در برابر ${r0(dr)} km/h)`);
    const vw = winner.a.visKm ?? 0;
    const vr = runner.a.visKm ?? 0;
    if (vw - vr >= 2) reasons.push(`دید بهتر نسبت به ${runner.a.shortFa}`);
    const sw = winner.a.snow.score;
    const sr = runner.a.snow.score;
    if (sw - sr >= 10) reasons.push(`کیفیت برف بهتر (${winner.a.snow.label})`);
    if (!reasons.length) {
      reasons.push(
        winner.d.verdict === 'avoid'
          ? 'هیچ ایستگاهی شرایط مناسب ندارد — تفاوت‌ها جزئی است'
          : `بهترین ترکیب شاخص‌ها (کیفیت ${winner.a.ski.score}، ایمنی ${winner.a.safety.score})`
      );
    }
  } else {
    reasons.push('تنها ایستگاه دارای داده');
  }
  return {
    available: true,
    zone: winner.a.zone,
    nameFa: winner.a.nameFa,
    shortFa: winner.a.shortFa,
    verdict: winner.d.verdict,
    reasons,
    /** True when the stations share a model grid cell (weak signal). */
    sharedCell: sharedGridCell(ok),
    ranking: ranked.map((r) => ({ zone: r.a.zone, shortFa: r.a.shortFa, ski: r.a.ski.score, safety: r.a.safety.score, verdict: r.d.verdict })),
  };
}

/**
 * Do the given stations resolve to the SAME model grid cell (or so close
 * together that they are effectively one measurement)?
 *
 * If so, their wind/precipitation are literally the same numbers and the
 * "best elevation" ranking carries no independent information.
 *
 * A pair counts as non-independent when EITHER:
 *   • both land in the same model grid cell, OR
 *   • they are closer than MODEL.independenceKm horizontally AND closer
 *     than MODEL.independenceM in altitude.
 */
export function sharedGridCell(analyses = []) {
  const ok = (analyses || []).filter((a) => a && !a.failed);
  if (ok.length < 2) return false;

  const cellOf = (a) =>
    a.grid && isNum(a.grid.lat) && isNum(a.grid.lon)
      ? `${a.grid.lat.toFixed(3)},${a.grid.lon.toFixed(3)}`
      : null;

  for (let i = 0; i < ok.length; i++) {
    for (let j = i + 1; j < ok.length; j++) {
      const ci = cellOf(ok[i]);
      const cj = cellOf(ok[j]);
      if (ci && cj && ci === cj) return true; // same cell

      // Different cells, but too close to be independent readings.
      const dKm = haversineKm(ok[i].grid?.lat, ok[i].grid?.lon, ok[j].grid?.lat, ok[j].grid?.lon);
      const dAlt = isNum(ok[i].alt) && isNum(ok[j].alt) ? Math.abs(ok[i].alt - ok[j].alt) : null;
      if (isNum(dKm) && isNum(dAlt) && dKm < MODEL.independenceKm && dAlt < MODEL.independenceM) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// "Why?" explainer
// ---------------------------------------------------------------------------

/** Build pros / cons / notes from recorded score factors. */
export function explainWhy({ ski = null, safety = null, snow = null, risk = null, flags = [], depthCm = null } = {}) {
  const pros = [];
  const cons = [];
  const notes = [];
  const pushFactor = (f, icon) => {
    const pts = f.points || 0;
    const line = pts !== 0 ? `${f.label} (${pts > 0 ? '+' : ''}${pts})` : f.label;
    (pts >= 0 ? pros : cons).push(`${icon} ${line}`);
  };

  if (ski) {
    const sorted = [...ski.factors].filter((f) => (f.points || 0) !== 0)
      .sort((a, b) => Math.abs(b.points || 0) - Math.abs(a.points || 0));
    for (const f of sorted.slice(0, 7)) {
      if ((f.points || 0) > 0) pushFactor(f, '✅');
      else pushFactor(f, '⚠️');
    }
  }
  if (safety) {
    for (const f of safety.factors) {
      if ((f.points || 0) <= -10) cons.push(`🛡 ${f.label} (${f.points})`);
    }
    if (safety.capApplied) cons.push(`🛡 ${safety.capApplied.label} (سقف ${safety.capApplied.cap})`);
    for (const h of safety.hardStops || []) cons.push(`🔴 ${h.label || h}`);
  }
  if (snow) {
    notes.push(`❄ کیفیت سطح برف (برآورد): ${snow.label} — ${snow.score}/۱۰۰`);
  }
  if (risk) {
    notes.push(`${risk.icon} ریسک جوی کوهستان (برآورد): ${risk.label}`);
  }
  for (const fl of flags) notes.push(fl);
  if (depthCm !== null && depthCm < FLAGS.noSnowDepth) {
    notes.push(`⚠️ پوشش برف کم (${depthCm} سانتی‌متر) — پیش از حرکت از باز بودن پیست مطمئن شو`);
  }
  return { pros: pros.slice(0, 6), cons: cons.slice(0, 6), notes: notes.slice(0, 6) };
}

// ---------------------------------------------------------------------------
// Confidence + trend
// ---------------------------------------------------------------------------

/**
 * Confidence in a recommendation (data completeness + horizon). NOT a probability.
 * @param {object} o { dayIndex, missingVars, stale, contradiction, lateDay, sharedCell }
 */
export function confidenceFor({ dayIndex = 0, missingVars = 0, stale = false, contradiction = false, lateDay = false, sharedCell = false } = {}) {
  const band = CONFIDENCE.horizon.find((b) => dayIndex <= b.maxDay) || CONFIDENCE.horizon[CONFIDENCE.horizon.length - 1];
  let pct = band.base;
  const notes = [];
  const missPenalty = Math.min(missingVars * CONFIDENCE.missingVarPenalty, CONFIDENCE.missingVarMaxPenalty);
  if (missPenalty > 0) {
    pct -= missPenalty;
    notes.push(`${missingVars} متغیر کلیدی ناقص است`);
  }
  if (stale) {
    pct -= CONFIDENCE.stalePenalty;
    notes.push('داده ذخیره‌شده (غیربه‌روز)');
  }
  if (contradiction) {
    pct -= CONFIDENCE.contradictionPenalty;
    notes.push('سیگنال‌های متناقض در داده‌ها');
  }
  if (lateDay) {
    pct -= CONFIDENCE.stalePenalty;
    notes.push('ساعات اسکی امروز کامل نیست');
  }
  if (sharedCell) {
    pct -= CONFIDENCE.sharedCellPenalty;
    notes.push('داده‌ی ایستگاه‌ها کاملاً مستقل از هم نیست');
  }
  pct = Math.max(5, Math.min(98, Math.round(pct)));
  const label = pct >= 75 ? 'بالا' : pct >= 55 ? 'متوسط' : 'کم';
  return { pct, label, notes };
}

/**
 * Short-term trend from "now" vs +3h/+6h hourly scores.
 * @param {Array<{score:number}>} scored rows ordered by hour
 * @param {number} nowHour current local hour
 */
export function trendFromHourly(scored = [], nowHour = null) {
  if (!scored.length || nowHour === null) return { dir: 'unknown', label: 'روند نامشخص', detail: null };
  const at = (h) => scored.find((r) => r.hour === h)?.score;
  const now = at(nowHour) ?? at(nowHour + 1) ?? scored[0]?.score;
  const later = at(nowHour + 6) ?? at(nowHour + 5) ?? at(nowHour + 4) ?? scored[scored.length - 1]?.score;
  if (!isNum(now) || !isNum(later)) return { dir: 'unknown', label: 'روند نامشخص', detail: null };
  const d = later - now;
  if (d >= FLAGS.deterioration.skiDrop) return { dir: 'improving', label: '📈 شرایط در حال بهتر شدن است', detail: `حدود ${d} امتیاز بهبود تا ۶ ساعت آینده` };
  if (d <= -FLAGS.deterioration.skiDrop) return { dir: 'deteriorating', label: '📉 شرایط در حال بدتر شدن است', detail: `حدود ${-d} امتیاز افت تا ۶ ساعت آینده` };
  return { dir: 'stable', label: '➡ شرایط تقریباً پایدار است', detail: null };
}
