/**
 * SnowF — App shell: boot, state, data loading, events.
 * Pipeline: api → weather → analysis → recommendation → ui.
 *
 * Data strategy (stale-while-revalidate + progressive paint):
 *  - Opening the site NEVER blocks on the network: whatever is in the local
 *    cache is painted immediately (with its timestamp).
 *  - Each station is rendered as soon as IT arrives — the page fills in
 *    instead of waiting for the slowest of 12 requests.
 *  - If the cache is older than TTL, a background refresh runs silently and
 *    the UI re-renders when fresher data lands (toast + timestamp update).
 *  - Reopening within TTL makes ZERO API requests.
 */

import { APP, CACHE_TTL_MS, MODEL } from './config.js';
import { loadResorts, resortIds } from './resorts.js';
import { getForecast, getRoadForecast, wxCacheKey, apiErrorMessage } from './api.js';
import { storeGet, storeSet, cacheGet, cacheClear } from './cache.js';
import { assessDataQuality, findNowIndex, isNum, inSkiWindow, gridInfo } from './weather.js';
import { analyzeLocationDay, analyzeResortDay, analyzeRoad } from './analysis.js';
import {
  decide, findBestWindow, bestElevation, explainWhy,
  confidenceFor, trendFromHourly, hourlySkiScore, VERDICTS, sharedGridCell,
} from './recommendation.js';
import { rankResorts, rankDays, snowOpportunity, findBestPick, compareTableRows } from './comparison.js';
import { renderHourlyChart, ensureChart, destroyHourlyChart } from './charts.js';
import * as UI from './ui.js';

// ---------------------------------------------------------------- state
const S = {
  resorts: {},
  order: [],
  resort: 'dizin',
  day: 0,
  heroMode: 'today', // today | tomorrow | week
  analysisMode: 'today', // today | tomorrow | week
  favorites: [],
  compareOpen: false,
  snowOpen: false,
  wx: {}, // resortId -> [station results {data, updatedAt, stale, grid} | {error}]
  road: {}, // resortId -> road result
  memo: new Map(),
  lastFetchAt: 0,
  booted: false,
  pending: 0, // in-flight station requests
  stalePainted: false,
};

const $ = (id) => document.getElementById(id);
const memoKey = (r, d) => `${r}|${d}`;
const WEEK_DAYS = 7;

// ---------------------------------------------------------------- boot
async function boot() {
  try {
    S.resorts = await loadResorts();
  } catch {
    S.resorts = {};
  }
  S.order = resortIds(S.resorts);
  if (!S.order.length) {
    fatal('اطلاعات پیست‌ها بارگذاری نشد.');
    return;
  }

  // Prefs + URL.
  S.heroMode = storeGet('heroMode', 'today');
  S.analysisMode = storeGet('analysisMode', 'today');
  S.favorites = storeGet('favorites', []);
  S.resort = storeGet('resort', 'dizin');
  const url = new URLSearchParams(location.search);
  if (url.get('resort') && S.resorts[url.get('resort')]) S.resort = url.get('resort');
  if (url.get('day') !== null) {
    const d = Number(url.get('day'));
    if (Number.isInteger(d) && d >= 0 && d < APP.forecastDays) S.day = d;
  }
  if (!S.resorts[S.resort]) S.resort = S.order[0];

  applyTheme(storeGet('theme', 'theme-snow'));
  renderControls();
  startClock();
  bindEvents();

  // 1) Paint immediately from cache (no network block).
  const hasAnyCache = S.order.some((id) =>
    S.resorts[id].locations.some((loc) => cacheGet(wxCacheKey(loc.lat, loc.lon)).hit)
  );
  if (!hasAnyCache) setLoading(true);
  // Each station is painted the moment it lands — never block on the slowest.
  await loadAll(false, () => scheduleRender());
  if (!hasAnyCache) setLoading(false);
  S.lastFetchAt = Date.now();
  renderAll();
  loadRoad(S.resort); // non-blocking

  // 2) Background revalidation if data is stale.
  if (S.stalePainted) scheduleBackgroundRefresh();

  setupAutoRefresh();
  registerSW();
  S.booted = true;
  UI.refreshIcons();
}

function setLoading(on) {
  $('loading').classList.toggle('hidden', !on);
  $('loading').classList.toggle('flex', on);
}

function fatal(msg) {
  $('global-error').classList.remove('hidden');
  $('global-error').innerHTML = `<div class="banner banner-bad justify-center">${UI.esc(msg)}</div>`;
}

// ---------------------------------------------------------------- rendering scheduler
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  const run = () => {
    renderQueued = false;
    if (!S.booted && !S.order.length) return;
    renderAll();
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 0);
}

// ---------------------------------------------------------------- data loading (SWR)
/**
 * Fill S.wx for every station.
 *  - fresh cache → used, no request
 *  - stale cache → used IMMEDIATELY (flagged), background refresh later
 *  - empty cache → real network fetch (painted progressively)
 *
 * @param {boolean} force bypass the cache
 * @param {Function} onStation called whenever a station's data changes
 */
async function loadAll(force, onStation) {
  S.memo.clear();
  S.stalePainted = false;
  let hadStale = false;
  const jobs = [];
  for (const id of S.order) {
    const resort = S.resorts[id];
    S.wx[id] = S.wx[id] || [];
    resort.locations.forEach((loc, i) => {
      if (!force) {
        const c = cacheGet(wxCacheKey(loc.lat, loc.lon));
        if (c.hit) {
          S.wx[id][i] = { data: c.data, updatedAt: c.updatedAt, stale: c.stale, grid: gridInfo(c.data) };
          if (c.stale) { S.stalePainted = true; hadStale = true; }
          return;
        }
      }
      S.pending += 1;
      jobs.push(
        getForecast(loc.lat, loc.lon, { force })
          .then((r) => {
            S.wx[id][i] = { data: r.data, updatedAt: r.updatedAt, stale: !!r.stale, grid: r.grid };
            invalidateMemo(id);
            onStation && onStation(id, i);
          })
          .catch(() => { S.wx[id][i] = { error: true }; })
          .finally(() => {
            S.pending -= 1;
            if (S.pending === 0) setLoading(false);
          })
      );
    });
  }
  if (jobs.length) await Promise.all(jobs);
  if (jobs.length) S.lastFetchAt = Date.now();
  return hadStale;
}

/** Drop memoized analyses of one resort (its data just changed). */
function invalidateMemo(resortId) {
  for (const key of [...S.memo.keys()]) {
    if (key.startsWith(`${resortId}|`)) S.memo.delete(key);
  }
}

/** Silent refresh while data is older than TTL; re-renders when fresher lands. */
function scheduleBackgroundRefresh() {
  setTimeout(async () => {
    if (!document.hidden) await refreshInBackground();
  }, 1200);
}

let refreshing = false;
async function refreshInBackground() {
  if (refreshing) return; // never overlap two background refreshes
  refreshing = true;
  try {
    const before = Math.max(0, ...(S.order.flatMap((id) => (S.wx[id] || []).map((r) => (r && !r.error ? r.updatedAt : 0)))));
    await loadAll(true, () => scheduleRender());
    const after = Math.max(0, ...(S.order.flatMap((id) => (S.wx[id] || []).map((r) => (r && !r.error ? r.updatedAt : 0)))));
    if (after > before) {
      renderAll();
      loadRoad(S.resort);
      UI.toast(`به‌روزرسانی شد — ${UI.fmtTime(after)}`);
    } else {
      renderStaleBanner();
    }
  } finally {
    refreshing = false;
  }
}

async function loadRoad(resortId) {
  const resort = S.resorts[resortId];
  if (!resort?.road) return;
  try {
    S.road[resortId] = await getRoadForecast(resort.road.lat, resort.road.lon);
  } catch {
    S.road[resortId] = { error: true };
  }
  renderRoadPanel();
}

// ---------------------------------------------------------------- analysis access
function stationData(resortId, locIdx) {
  const r = (S.wx[resortId] || [])[locIdx];
  return r && !r.error ? r : null;
}

function nowHourTehran() {
  try {
    const h = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: APP.timezone }).format(new Date());
    return Number(h) % 24;
  } catch {
    return null;
  }
}

/** Full memoized analysis bundle for resort × day. */
function analyze(resortId, day) {
  const key = memoKey(resortId, day);
  if (S.memo.has(key)) return S.memo.get(key);

  const resort = S.resorts[resortId];
  const nowH = nowHourTehran();
  const fromHour = day === 0 && nowH !== null ? nowH : null;

  const locs = resort.locations.map((loc, i) => {
    const st = stationData(resortId, i);
    const dq = st ? assessDataQuality(st.data) : { missingHourly: [], missingDaily: [], level: 'poor', total: 99 };
    const a = analyzeLocationDay(st ? st.data : null, day, loc, { fromHour });
    a._dq = dq;
    a._updatedAt = st ? st.updatedAt : 0;
    a._stale = st ? !!st.stale : false;
    if (st && st.grid) a.grid = st.grid;
    return a;
  });

  const resortA = analyzeResortDay(locs, { resortId, nameFa: resort.nameFa, fullNameFa: resort.fullNameFa, dayIndex: day });
  const bundle = { resortMeta: resort, locs, resort: resortA, day };

  if (!resortA.failed) {
    const verdict = decide({
      ski: resortA.ski,
      safety: resortA.safety,
      minSafety: resortA.minSafety,
      minSafetyZone: resortA.minSafetyZone,
      depthCm: resortA.depthCm,
      hardStops: resortA.hardStops,
      riskBand: resortA.risk?.band,
    });
    bundle.verdict = verdict;
    bundle.verdictsByLoc = locs.map((a) =>
      a.failed ? null : decide({ ski: a.ski.score, safety: a.safety.score, depthCm: a.depthCm, hardStops: a.safety.hardStops, riskBand: a.risk.band })
    );

    const elev = bestElevation(locs);
    bundle.bestElev = elev;
    const winLoc = (elev.available && locs.find((a) => !a.failed && a.zone === elev.zone)) || locs.find((a) => !a.failed);
    const depthForHours = winLoc ? winLoc.depthCm : null;
    bundle.bestWindow = winLoc ? findBestWindow(winLoc._hours, fromHour, depthForHours) : { available: false };
    bundle.windowLoc = winLoc || null;

    bundle.timeline = winLoc
      ? winLoc._hours
          .filter((r) => inSkiWindow(r.hour))
          .map((r) => ({ hour: r.hour, temp: isNum(r.temp) ? Math.round(r.temp) : null, wind: isNum(r.wind) ? Math.round(r.wind) : null, snowfall: r.snowfall, rain: r.rain, cloud: r.cloud, score: hourlySkiScore(r, depthForHours).score }))
      : [];

    const tLoc = locs.find((a) => !a.failed && a.zone === 'summit') || winLoc;
    bundle.trend = tLoc
      ? trendFromHourly(tLoc._hours.filter((r) => isNum(r.hour)).map((r) => ({ hour: r.hour, score: hourlySkiScore(r, tLoc.depthCm).score })), nowH)
      : { dir: 'unknown', label: 'روند نامشخص', detail: null };

    const rep = locs.find((a) => !a.failed && a.zone === 'summit') || locs.find((a) => !a.failed);
    bundle.why = explainWhy({
      ski: rep ? { factors: rep.ski.factors } : null,
      safety: rep ? { factors: rep.safety.factors, hardStops: rep.safety.hardStops, capApplied: rep.safety.capApplied } : null,
      snow: rep ? { label: rep.snow.label, score: rep.snow.score } : null,
      risk: resortA.risk,
      flags: resortA.flags,
      depthCm: resortA.depthCm,
    });
    bundle.skiFactors = rep ? rep.ski.factors : [];
    bundle.safetyFactors = rep ? rep.safety.factors : [];

    const missingVars = Math.min(9, locs.reduce((s, a) => s + (a._dq?.total || 0), 0));
    const stale = locs.some((a) => a._stale);
    const lateDay = locs.some((a) => !a.failed && a.lateDay);
    const contradiction = rep && isNum(rep.probMax) && rep.probMax >= 70 && (rep.fresh24hCm || 0) === 0 && (rep.precipMm || 0) === 0;
    // Stations that share a model grid cell are not independent readings.
    const sharedCell = sharedGridCell(locs);
    bundle.sharedCell = sharedCell;
    bundle.confidence = confidenceFor({ dayIndex: day, missingVars, stale, contradiction, lateDay, sharedCell });
    bundle.dataQuality = worstDQ(locs.map((a) => a._dq));
    bundle.updatedAt = Math.max(...locs.map((a) => a._updatedAt || 0));
    bundle.stale = stale;
    bundle.lateDay = lateDay;

    bundle.snowOpp = buildOpportunity(resortId, day);
  }

  S.memo.set(key, bundle);
  return bundle;
}

function worstDQ(dqs) {
  const order = { good: 0, limited: 1, poor: 2 };
  return dqs.slice().sort((a, b) => (order[b?.level] ?? 2) - (order[a?.level] ?? 2))[0] || { level: 'poor' };
}

function buildOpportunity(resortId, day) {
  const st = stationData(resortId, 0);
  if (!st) return { score: 0, label: 'نامشخص', factors: [], capped: false };
  const d = st.data.daily || {};
  const g = (arr, i) => (Array.isArray(arr) && typeof arr[i] === 'number' ? arr[i] : null);
  const fresh = g(d.snowfall_sum, day) ?? 0;
  const prob = g(d.precipitation_probability_max, day) ?? 0;
  const tmax = g(d.temperature_2m_max, day);
  const gust = g(d.wind_gusts_10m_max, day) ?? 0;
  const nextMax = g(d.temperature_2m_max, day + 1);
  return snowOpportunity({
    freshCm: fresh,
    probPct: prob,
    tempMaxC: tmax,
    gustKmh: gust,
    persistCold: nextMax !== null && nextMax <= 1,
  });
}

// ---------------------------------------------------------------- week candidates
/** (resort × day, 0..6) candidates with everything a ranking needs. */
function weekCandidates() {
  const cands = [];
  for (const id of S.order) {
    for (let d = 0; d < WEEK_DAYS; d++) {
      const b = analyze(id, d);
      if (b.resort.failed) continue;
      const rep = b.locs.find((a) => !a.failed && a.zone === 'summit') || b.locs.find((a) => !a.failed);
      cands.push({
        resortId: id, nameFa: b.resort.nameFa, dayIndex: d, date: b.resort.date,
        ski: b.resort.ski, safety: b.resort.safety, minSafety: b.resort.minSafety, minSafetyZone: b.resort.minSafetyZone,
        snowScore: b.resort.snowScore, fresh: b.resort.fresh24hCm, wind: b.resort.wind, gust: b.resort.gust, visKm: b.resort.visKm,
        depthCm: b.resort.depthCm, risk: b.resort.risk, hardStops: b.resort.hardStops,
        windowLabel: b.bestWindow.available ? b.bestWindow.label : null,
        prob: rep?.probMax ?? null,
      });
    }
  }
  return cands;
}

// ---------------------------------------------------------------- rendering
function renderControls() {
  $('resort-pills').innerHTML = UI.renderPills(S.resorts, S.order, { active: S.resort, favorites: S.favorites });
}

function resortDate(resortId, day) {
  for (let i = 0; i < 3; i++) {
    const st = stationData(resortId, i);
    const t = st?.data?.daily?.time?.[day];
    if (t) return t;
  }
  return '';
}

function renderAll() {
  syncUrl();
  renderStaleBanner();
  renderHero();
  renderBestPickSection();
  renderControls();
  renderDaySelector();
  renderDetail();
  renderForecast();
  renderAnalysis();
  if (S.compareOpen) renderComparePanel();
  if (S.snowOpen) renderSnowPanel();
  renderFooterMeta();
  UI.refreshIcons();
}

function renderStaleBanner() {
  const el = $('stale-banner');
  const anyStale = S.order.some((id) => (S.wx[id] || []).some((r) => r && !r.error && r.stale));
  const anyError = S.order.some((id) => (S.wx[id] || []).some((r) => r && r.error));
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  let latest = 0;
  for (const id of S.order) for (const r of S.wx[id] || []) if (r && !r.error && r.updatedAt > latest) latest = r.updatedAt;
  if (offline || anyStale) {
    el.classList.remove('hidden');
    const t = latest ? UI.fmtTime(latest) : '—';
    el.innerHTML = `<div class="banner banner-warn">⚠️ ${offline ? 'آفلاین — ' : ''}داده‌های ذخیره‌شده نمایش داده می‌شوند (آخرین دریافت: ${t})${offline ? '' : ' — به‌روزرسانی در پس‌زمینه…'}. پیش‌بینی تازه فقط با اینترنت ممکن است.</div>`;
  } else if (anyError) {
    el.classList.remove('hidden');
    el.innerHTML = `<div class="banner banner-warn">⚠️ ${UI.esc(apiErrorMessage())} بخش‌های دارای داده نمایش داده می‌شوند. <button class="underline font-black" data-action="retry">تلاش مجدد</button></div>`;
  } else {
    el.classList.add('hidden');
    el.innerHTML = '';
  }
}

function renderHero() {
  const mode = S.heroMode;
  if (mode === 'week') {
    // Best resort per day of the coming week + single best (resort, day).
    const perDay = [];
    for (let d = 0; d < WEEK_DAYS; d++) {
      const ranked = rankResorts(
        S.order.map((id) => {
          const b = analyze(id, d);
          if (b.resort.failed) return null;
          return { ...b.resort, verdict: b.verdict, windowLabel: b.bestWindow.available ? b.bestWindow.label : null };
        }).filter(Boolean)
      );
      if (!ranked.length) continue;
      const best = ranked[0];
      perDay.push({
        dayIndex: d,
        label: UI.dayLabel(d, best.date),
        dateShort: best.date ? UI.fmtDayMonth(best.date) : '',
        resortId: best.resortId,
        nameFa: best.nameFa,
        verdict: best.verdict.verdict,
        ski: best.ski,
        safety: best.safety,
        blend: best.blend,
        windowLabel: best.windowLabel,
      });
    }
    const weekBest = findBestPick(weekCandidates());
    const allAvoid = perDay.length > 0 && perDay.every((r) => r.verdict === 'avoid');
    $('hero-body').innerHTML = UI.renderHero({
      mode, weekRows: perDay, weekBest: weekBest && weekBest.verdict.verdict !== 'avoid' ? weekBest : null, allAvoid,
    });
    return;
  }
  const day = mode === 'tomorrow' ? 1 : 0;
  const ranked = rankResorts(
    S.order.map((id) => {
      const b = analyze(id, day);
      if (b.resort.failed) return null;
      return { ...b.resort, verdict: b.verdict, windowLabel: b.bestWindow.available ? b.bestWindow.label : null };
    }).filter(Boolean)
  );
  const dateStr = ranked.length ? resortDate(ranked[0].resortId, day) : resortDate(S.order[0], day);
  const stale = ranked.some((r) => (S.wx[r.resortId] || []).some((x) => x && x.stale));
  $('hero-body').innerHTML = UI.renderHero({
    mode,
    ranked,
    dateLabel: day === 0 ? `امروز${dateStr ? ` (${UI.fmtDayMonth(dateStr)})` : ''}` : `فردا${dateStr ? ` (${UI.fmtDayMonth(dateStr)})` : ''}`,
    stale,
  });
}

function renderBestPickSection() {
  const cands = weekCandidates();
  const pick = findBestPick(cands);
  const el = $('best-pick');
  if (!pick || pick.verdict.verdict === 'avoid') {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  el.classList.remove('hidden');
  el.innerHTML = UI.renderBestPick(pick, { dateStr: pick.date });
}

function renderDaySelector() {
  const wrap = $('day-selector-wrap');
  const days = [];
  const idxs = [0, 1, 2, 3, 4, 5, 6];
  if (S.day > 6) idxs.push(S.day);
  for (const d of idxs) {
    const b = analyze(S.resort, d);
    const dateStr = b.resort.date || resortDate(S.resort, d);
    days.push({
      dayIndex: d,
      label: UI.dayLabel(d, dateStr),
      dateShort: dateStr ? UI.fmtDayMonth(dateStr) : '',
      verdict: b.verdict?.verdict || 'caution',
    });
  }
  $('day-selector').innerHTML = UI.renderDaySelector(days, S.day);
  wrap.classList.remove('hidden');
}

function renderDetail() {
  const b = analyze(S.resort, S.day);
  const dateStr = b.resort.date || resortDate(S.resort, S.day);
  $('resort-detail').innerHTML = UI.renderResortDetail({
    resort: b.resort,
    analysis: b.resort,
    verdict: b.verdict,
    verdictsByLoc: b.verdictsByLoc,
    bestWindow: b.bestWindow,
    bestElev: b.bestElev,
    why: b.why,
    confidence: b.confidence,
    trend: b.trend,
    snowOpp: b.snowOpp,
    timeline: b.timeline,
    stale: b.stale,
    updatedAt: b.updatedAt,
    staleNote: 'به‌روزرسانی نشده',
    lateDay: b.lateDay,
    sharedCell: b.sharedCell,
    dateLabel: `${UI.dayLabel(S.day, dateStr)}${dateStr ? ` • ${UI.fmtFull(dateStr)}` : ''}`,
  });
}

function renderForecast() {
  const days = [];
  const rankable = [];
  for (let d = 0; d < APP.forecastDays; d++) {
    const b = analyze(S.resort, d);
    if (b.resort.failed) continue;
    const rep = b.locs.find((a) => !a.failed && a.zone === 'summit') || b.locs.find((a) => !a.failed);
    days.push({
      dayIndex: d,
      label: UI.dayLabel(d, b.resort.date),
      dateShort: b.resort.date ? UI.fmtDayMonth(b.resort.date) : '',
      verdict: b.verdict.verdict,
      ski: b.resort.ski,
      safety: b.resort.safety,
      fresh: Math.round(b.resort.fresh24hCm || 0),
      tmin: rep?.tempMin ?? null,
      tmax: rep?.tempMax ?? null,
      opp: b.snowOpp?.score ?? null,
      isBest: false,
    });
    rankable.push({
      dayIndex: d,
      ski: b.resort.ski,
      safety: b.resort.safety,
      minSafety: b.resort.minSafety,
      minSafetyZone: b.resort.minSafetyZone,
      depthCm: b.resort.depthCm,
      risk: b.resort.risk,
      hardStops: b.resort.hardStops,
    });
  }
  const top = rankDays(rankable, 1)[0];
  if (top) {
    const f = days.find((d) => d.dayIndex === top.dayIndex);
    if (f) f.isBest = true;
  }
  if (!days.length) {
    $('forecast').classList.add('hidden');
    return;
  }
  $('forecast').classList.remove('hidden');
  $('forecast-resort').textContent = `— ${S.resorts[S.resort].nameFa}`;
  $('forecast-strip').innerHTML = UI.renderForecastStrip(days, S.day);
}

function renderAnalysis() {
  const el = $('analysis');
  if (S.analysisMode === 'week') {
    const days = [];
    const rankable = [];
    for (let d = 0; d < WEEK_DAYS; d++) {
      const b = analyze(S.resort, d);
      if (b.resort.failed) continue;
      days.push({
        dayIndex: d,
        label: UI.dayLabel(d, b.resort.date),
        dateShort: b.resort.date ? UI.fmtDayMonth(b.resort.date) : '',
        verdict: b.verdict.verdict,
        ski: b.resort.ski,
        safety: b.resort.safety,
        fresh: Math.round(b.resort.fresh24hCm || 0),
        windowLabel: b.bestWindow.available ? b.bestWindow.label : null,
      });
      rankable.push({
        dayIndex: d,
        ski: b.resort.ski,
        safety: b.resort.safety,
        minSafety: b.resort.minSafety,
        minSafetyZone: b.resort.minSafetyZone,
        depthCm: b.resort.depthCm,
        risk: b.resort.risk,
        hardStops: b.resort.hardStops,
      });
    }
    const top = rankDays(rankable, 1)[0];
    // Never crown a day with ⭐ when it is not actually a GO — honesty rule.
    if (top && top.verdict.verdict !== 'avoid') {
      const f = days.find((d) => d.dayIndex === top.dayIndex);
      if (f) f.isBest = true;
    }
    el.classList.remove('hidden');
    el.innerHTML = UI.renderAnalysisWeek({ resortName: S.resorts[S.resort].nameFa, days, mode: S.analysisMode });
    return;
  }
  const day = S.analysisMode === 'tomorrow' ? 1 : 0;
  const b = analyze(S.resort, day);
  if (b.resort.failed) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  const dateStr = b.resort.date || resortDate(S.resort, day);
  el.classList.remove('hidden');
  el.innerHTML = UI.renderAnalysisPanel({
    verdict: b.verdict,
    why: b.why,
    confidence: b.confidence,
    dataQuality: b.dataQuality,
    risk: b.resort.risk,
    updatedAt: b.updatedAt,
    stale: b.stale,
    sharedCell: b.sharedCell,
    resortName: b.resort.nameFa,
    dateLabel: `${UI.dayLabel(day, dateStr)}${dateStr ? `، ${UI.fmtDayMonth(dateStr)}` : ''}`,
    ski: b.resort.ski,
    safety: b.resort.safety,
    minSafety: b.resort.minSafety,
    minSafetyZone: b.resort.minSafetyZone,
    skiFactors: b.skiFactors,
    safetyFactors: b.safetyFactors,
    mode: S.analysisMode,
  });
}

function renderComparePanel() {
  const el = $('compare-panel');
  const ranked = rankResorts(
    S.order.map((id) => {
      const b = analyze(id, S.day);
      if (b.resort.failed) return null;
      return { ...b.resort, verdict: b.verdict };
    }).filter(Boolean)
  );
  const dateStr = resortDate(S.resort, S.day);
  el.innerHTML = UI.renderCompare(compareTableRows(ranked), {
    dateLabel: `${UI.dayLabel(S.day, dateStr)}${dateStr ? ` • ${UI.fmtFull(dateStr)}` : ''}`,
  });
  el.classList.remove('hidden');
  UI.refreshIcons();
}

function renderSnowPanel() {
  const el = $('snow-panel');
  const days = [];
  for (let d = 0; d < APP.forecastDays; d++) {
    const b = analyze(S.resort, d);
    if (b.resort.failed) continue;
    days.push({
      dayIndex: d,
      label: UI.dayLabel(d, b.resort.date),
      dateShort: b.resort.date ? UI.fmtDayMonth(b.resort.date) : '',
      ski: b.resort.ski,
      safety: b.resort.safety,
      fresh: Math.round(b.resort.fresh24hCm || 0),
      depthCm: b.resort.depthCm,
      risk: b.resort.risk,
      hardStops: b.resort.hardStops,
      opp: b.snowOpp?.score ?? 0,
    });
  }
  const icon = { go: '🟢', caution: '🟡', avoid: '🔴' };
  const top = rankDays(days, 3)
    .map((d) => ({ ...d, verdictIcon: icon[d.verdict.verdict] || '', medal: d.medal }))
    .filter((d) => d.opp >= 25 || d.fresh >= 3);
  el.innerHTML = UI.renderSnowPanel({ resortName: S.resorts[S.resort].nameFa, days: top });
  el.classList.remove('hidden');
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  UI.refreshIcons();
}

function renderRoadPanel() {
  const el = $('road-panel');
  const r = S.road[S.resort];
  if (!r || r.error) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  const road = analyzeRoad(r.data, 6);
  el.innerHTML = UI.renderRoad(road, S.resorts[S.resort]?.road?.nameFa || '');
  el.classList.remove('hidden');
  UI.refreshIcons();
}

function renderFooterMeta() {
  $('footer-meta').textContent = `افق: ${APP.forecastDays} روز • منبع: ${APP.dataSource} (${MODEL.name}) • کش محلی: ${Math.round(CACHE_TTL_MS / 60000)} دقیقه`;
  const v = $('app-version');
  if (v) v.textContent = `SnowF v${APP.version}`;
}

// ---------------------------------------------------------------- actions
function syncUrl() {
  try {
    const p = new URLSearchParams({ resort: S.resort, day: String(S.day) });
    history.replaceState(null, '', `${location.pathname}?${p.toString()}`);
  } catch { /* ignore */ }
}

function bindEvents() {
  document.addEventListener('click', onClick);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });
  $('hourly-modal').addEventListener('click', (e) => {
    if (e.target.id === 'hourly-modal') closeModal();
  });
  $('btn-close-modal').addEventListener('click', closeModal);
  $('btn-compare').addEventListener('click', () => {
    S.compareOpen = !S.compareOpen;
    if (S.compareOpen) {
      renderComparePanel();
      $('compare-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      $('compare-panel').classList.add('hidden');
    }
  });
  $('btn-snow').addEventListener('click', () => {
    S.snowOpen = !S.snowOpen;
    if (S.snowOpen) renderSnowPanel();
    else $('snow-panel').classList.add('hidden');
  });
  $('btn-share').addEventListener('click', shareCurrent);
  document.querySelectorAll('.theme-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      applyTheme(btn.dataset.theme);
      storeSet('theme', btn.dataset.theme);
    });
  });
  window.addEventListener('online', () => refreshInBackground());
  window.addEventListener('offline', () => renderStaleBanner());
}

function onClick(e) {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  const action = t.dataset.action;
  if (action === 'select-resort') selectResort(t.dataset.resort);
  else if (action === 'goto-resort') {
    selectResort(t.dataset.resort);
    $('resort-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else if (action === 'goto-resort-day') {
    S.day = Number(t.dataset.day) || 0;
    selectResort(t.dataset.resort);
    $('resort-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else if (action === 'goto-pick') {
    S.day = Number(t.dataset.day) || 0;
    selectResort(t.dataset.resort);
    $('resort-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else if (action === 'select-day') selectDay(Number(t.dataset.day));
  else if (action === 'toggle-fav') toggleFav(t.dataset.resort);
  else if (action === 'open-chart') openChart(Number(t.dataset.loc));
  else if (action === 'close-compare') {
    S.compareOpen = false;
    $('compare-panel').classList.add('hidden');
  } else if (action === 'retry') retryLoad();
  else if (action === 'share-resort') shareCurrent();
  else if (action === 'hero-mode') {
    S.heroMode = t.dataset.mode;
    storeSet('heroMode', S.heroMode);
    renderHero();
  } else if (action === 'analysis-mode') {
    S.analysisMode = t.dataset.mode;
    storeSet('analysisMode', S.analysisMode);
    renderAnalysis();
  }
}

function selectResort(id) {
  if (!S.resorts[id]) return;
  if (id !== S.resort) {
    S.resort = id;
    S.day = 0;
    storeSet('resort', id);
  }
  renderAll();
  loadRoad(id);
}

function selectDay(d) {
  if (!Number.isInteger(d) || d < 0 || d >= APP.forecastDays) return;
  S.day = d;
  renderAll();
  $('resort-detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function toggleFav(id) {
  if (!S.resorts[id]) return;
  const i = S.favorites.indexOf(id);
  if (i >= 0) S.favorites.splice(i, 1);
  else S.favorites.push(id);
  storeSet('favorites', S.favorites);
  renderControls();
  UI.refreshIcons();
  UI.toast(i >= 0 ? 'از علاقه‌مندی‌ها حذف شد' : '⭐ به علاقه‌مندی‌ها اضافه شد');
}

/** Retry: drop the cached payloads entirely (they may be corrupt) and refetch. */
async function retryLoad() {
  setLoading(true);
  $('global-error').classList.add('hidden');
  cacheClear();
  await loadAll(true, () => scheduleRender());
  setLoading(false);
  renderAll();
  loadRoad(S.resort);
}

async function openChart(locIdx) {
  const b = analyze(S.resort, S.day);
  const a = b.locs[locIdx];
  if (!a || a.failed) {
    UI.toast('داده ساعتی موجود نیست');
    return;
  }
  UI.toast('در حال بارگذاری نمودار...');
  try {
    await ensureChart();
  } catch {
    UI.toast('نمودار فقط با اتصال به اینترنت بارگذاری می‌شود');
    return;
  }
  const dateStr = b.resort.date;
  $('modal-title').textContent = `نمودار ساعتی — ${a.nameFa}${dateStr ? ` (${UI.fmtDayMonth(dateStr)})` : ''}`;
  const canvas = $('hourly-chart');
  const ok = renderHourlyChart(canvas, a._hours, a.depthCm);
  if (!ok) {
    UI.toast('خطا در رسم نمودار');
    return;
  }
  $('hourly-modal').classList.remove('hidden');
  $('hourly-modal').classList.add('flex');
  // Move focus into the dialog so keyboard users are not left behind.
  const close = $('btn-close-modal');
  if (close) close.focus();
}

function closeModal() {
  $('hourly-modal').classList.add('hidden');
  $('hourly-modal').classList.remove('flex');
  destroyHourlyChart();
}

async function shareCurrent() {
  const b = analyze(S.resort, S.day);
  const dateStr = b.resort.date || '';
  const v = b.verdict || { label: '' };
  const text = b.resort.failed
    ? '❄️ برف‌کو — وضعیت پیست‌ها'
    : `❄️ ${b.resort.nameFa} — ${UI.dayLabel(S.day, dateStr)}${dateStr ? ` ${UI.fmtDayMonth(dateStr)}` : ''}\n🎿 کیفیت ${UI.faNum(b.resort.ski)} • 🛡 ایمنی ${UI.faNum(b.resort.safety)}\n${v.icon || ''} ${v.label || ''}${b.bestWindow?.available ? `\n⏰ ${UI.faNum(b.bestWindow.label)}` : ''}\n— از طریق برف‌کو`;
  const url = location.href;
  try {
    if (navigator.share) {
      await navigator.share({ title: 'برف‌کو', text, url });
      return;
    }
    throw new Error('no-share');
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    try {
      await navigator.clipboard.writeText(`${text}\n${url}`);
      UI.toast('متن در حافظه کپی شد ✓');
    } catch {
      UI.toast('اشتراک‌گذاری ممکن نشد');
    }
  }
}

// ---------------------------------------------------------------- chrome
function applyTheme(theme) {
  document.body.classList.remove('theme-snow', 'theme-sun', 'theme-night', 'theme-aurora');
  document.body.classList.add(theme);
}

function startClock() {
  const dateEl = $('live-date');
  const timeEl = $('live-time');
  if (!dateEl || !timeEl) return;
  const tick = () => {
    // Date and time live in two separate elements so the bidi algorithm can
    // never interleave them (see UI.formatClock).
    const { date, time } = UI.formatClock(new Date(), APP.timezone);
    dateEl.textContent = date;
    timeEl.textContent = time;
  };
  tick();
  setInterval(tick, 1000);
}

/** Age (ms) of the OLDEST station dataset currently held. */
function oldestDataAge() {
  let latest = 0;
  for (const id of S.order) {
    for (const r of S.wx[id] || []) if (r && !r.error && r.updatedAt > latest) latest = r.updatedAt;
  }
  return latest ? Date.now() - latest : Infinity;
}

function setupAutoRefresh() {
  // While the tab is open: quietly refresh when data is older than TTL.
  // Checked every 60s; costs nothing while data is fresh (no requests).
  // This also retries the one-shot background revalidation if it was
  // skipped (tab hidden / timer throttled) right after a stale paint.
  setInterval(async () => {
    if (document.hidden) return;
    if (oldestDataAge() < CACHE_TTL_MS) return;
    await refreshInBackground();
  }, 60 * 1000);
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
  if (!window.isSecureContext && !isLocal) return;
  const go = () => {
    navigator.serviceWorker.register('./service-worker.js').catch((e) => {
      console.warn('SW registration failed:', e);
    });
  };
  if (document.readyState === 'complete') go();
  else window.addEventListener('load', go, { once: true });
}

// Debug handle (factors etc. inspectable from console).
window.SnowF = { state: S, analyze, VERDICTS, version: APP.version };

document.addEventListener('DOMContentLoaded', boot);
