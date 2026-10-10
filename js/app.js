/**
 * SnowF — App shell: boot, state, data loading, events.
 * Read the pipeline: api → weather → analysis → recommendation → ui.
 */

import { APP, PROFILES, CACHE_TTL_MS } from './config.js';
import { loadResorts, resortIds } from './resorts.js';
import { getForecast, getRoadForecast, apiErrorMessage } from './api.js';
import { storeGet, storeSet } from './cache.js';
import { assessDataQuality, findNowIndex, isNum } from './weather.js';
import { analyzeLocationDay, analyzeResortDay, analyzeRoad } from './analysis.js';
import {
  decide, findBestWindow, bestElevation, explainWhy,
  confidenceFor, trendFromHourly, hourlySkiScore, VERDICTS,
} from './recommendation.js';
import { rankResorts, rankDays, snowOpportunity, findBestPick, compareTableRows } from './comparison.js';
import { renderHourlyChart, hasCharts, destroyHourlyChart } from './charts.js';
import * as UI from './ui.js';

// ---------------------------------------------------------------- state
const S = {
  resorts: {},
  order: [],
  resort: 'dizin',
  day: 0,
  profile: 'intermediate',
  favorites: [],
  compareOpen: false,
  snowOpen: false,
  wx: {}, // resortId -> [station results]
  road: {}, // resortId -> road result
  memo: new Map(),
  booted: false,
};

const $ = (id) => document.getElementById(id);
const memoKey = (r, d, p) => `${r}|${d}|${p}`;

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
  S.profile = storeGet('profile', 'intermediate');
  S.favorites = storeGet('favorites', []);
  S.resort = storeGet('resort', 'dizin');
  const url = new URLSearchParams(location.search);
  if (url.get('resort') && S.resorts[url.get('resort')]) S.resort = url.get('resort');
  if (url.get('day') !== null) {
    const d = Number(url.get('day'));
    if (Number.isInteger(d) && d >= 0 && d < APP.forecastDays) S.day = d;
  }
  if (url.get('profile') && PROFILES[url.get('profile')]) S.profile = url.get('profile');
  if (!S.resorts[S.resort]) S.resort = S.order[0];

  applyTheme(storeGet('theme', 'theme-snow'));
  renderControls();
  startClock();
  bindEvents();

  setLoading(true);
  await loadAll(false);
  setLoading(false);
  renderAll();
  loadRoad(S.resort); // non-blocking
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

// ---------------------------------------------------------------- data loading
async function loadAll(force) {
  S.memo.clear();
  const jobs = [];
  for (const id of S.order) {
    const resort = S.resorts[id];
    S.wx[id] = S.wx[id] || [];
    resort.locations.forEach((loc, i) => {
      jobs.push(
        getForecast(loc.lat, loc.lon, { force })
          .then((r) => { S.wx[id][i] = r; })
          .catch(() => { S.wx[id][i] = { error: true }; })
      );
    });
  }
  await Promise.all(jobs);
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

/** Full memoized analysis bundle for resort × day × profile. */
function analyze(resortId, day, profile) {
  const key = memoKey(resortId, day, profile);
  if (S.memo.has(key)) return S.memo.get(key);

  const resort = S.resorts[resortId];
  const nowH = nowHourTehran();
  const fromHour = day === 0 && nowH !== null ? nowH : null;

  const locs = resort.locations.map((loc, i) => {
    const st = stationData(resortId, i);
    const dq = st ? assessDataQuality(st.data) : { missingHourly: [], missingDaily: [], level: 'poor', total: 99 };
    const a = analyzeLocationDay(st ? st.data : null, day, loc, { profileId: profile, fromHour });
    a._dq = dq;
    a._updatedAt = st ? st.updatedAt : 0;
    a._stale = st ? !!st.stale : false;
    return a;
  });

  const resortA = analyzeResortDay(locs, { resortId, nameFa: resort.nameFa, dayIndex: day });
  const bundle = { resort, locs, resort: resortA, day, profile };

  if (!resortA.failed) {
    const verdict = decide(
      { ski: resortA.ski, safety: resortA.safety, depthCm: resortA.depthCm, hardStops: resortA.hardStops, riskBand: resortA.risk?.band },
      profile
    );
    bundle.verdict = verdict;
    bundle.verdictsByLoc = locs.map((a) =>
      a.failed
        ? null
        : decide({ ski: a.ski.score, safety: a.safety.score, depthCm: a.depthCm, hardStops: a.safety.hardStops, riskBand: a.risk.band }, profile)
    );

    // Best window from the best-elevation station (fallback: summit-first ok).
    const elev = bestElevation(locs);
    bundle.bestElev = elev;
    const winLoc = (elev.available && locs.find((a) => !a.failed && a.zone === elev.zone)) || locs.find((a) => !a.failed);
    const depthForHours = winLoc ? winLoc.depthCm : null;
    bundle.bestWindow = winLoc ? findBestWindow(winLoc._hours, fromHour, depthForHours) : { available: false };
    bundle.windowLoc = winLoc || null;

    // Timeline rows (best station, ski hours).
    bundle.timeline = winLoc
      ? winLoc._hours
          .filter((r) => isNum(r.hour) && r.hour >= 7 && r.hour <= 16)
          .map((r) => ({ hour: r.hour, temp: isNum(r.temp) ? Math.round(r.temp) : null, wind: isNum(r.wind) ? Math.round(r.wind) : null, snowfall: r.snowfall, rain: r.rain, cloud: r.cloud, score: hourlySkiScore(r, depthForHours).score }))
      : [];

    // Trend from summit (or best) hourly scores.
    const tLoc = locs.find((a) => !a.failed && a.zone === 'summit') || winLoc;
    bundle.trend = tLoc
      ? trendFromHourly(tLoc._hours.filter((r) => isNum(r.hour)).map((r) => ({ hour: r.hour, score: hourlySkiScore(r, tLoc.depthCm).score })), nowH)
      : { dir: 'unknown', label: 'روند نامشخص', detail: null };

    // Why (resort level, blended from representative factors).
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

    // Confidence.
    const missingVars = Math.min(9, locs.reduce((s, a) => s + (a._dq?.total || 0), 0));
    const stale = locs.some((a) => a._stale);
    const lateDay = locs.some((a) => !a.failed && a.lateDay);
    const contradiction =
      rep && isNum(rep.probMax) && rep.probMax >= 70 && (rep.fresh24hCm || 0) === 0 && (rep.precipMm || 0) === 0;
    bundle.confidence = confidenceFor({ dayIndex: day, missingVars, stale, contradiction, lateDay });
    bundle.lateDay = lateDay;
    bundle.dataQuality = worstDQ(locs.map((a) => a._dq));
    bundle.updatedAt = Math.max(...locs.map((a) => a._updatedAt || 0));
    bundle.stale = stale;

    // Snow opportunity (summit representative + persistence).
    bundle.snowOpp = buildOpportunity(resortId, day, profile);
  }

  S.memo.set(key, bundle);
  return bundle;
}

function worstDQ(dqs) {
  const order = { good: 0, limited: 1, poor: 2 };
  return dqs.slice().sort((a, b) => (order[b?.level] ?? 2) - (order[a?.level] ?? 2))[0] || { level: 'poor' };
}

function buildOpportunity(resortId, day) {
  const resort = S.resorts[resortId];
  const st = stationData(resortId, 0);
  if (!st) return { score: 0, label: 'نامشخص', factors: [], capped: false };
  const d = st.data.daily || {};
  const g = (arr, i) => (Array.isArray(arr) && typeof arr[i] === 'number' ? arr[i] : null);
  const fresh = g(d.snowfall_sum, day) ?? 0;
  const prob = g(d.precipitation_probability_max, day) ?? 0;
  const tmax = g(d.temperature_2m_max, day);
  const gust = g(d.wind_gusts_10m_max, day) ?? 0;
  const nextMax = g(d.temperature_2m_max, day + 1);
  void resort;
  return snowOpportunity({
    freshCm: fresh,
    probPct: prob,
    tempMaxC: tmax,
    gustKmh: gust,
    persistCold: nextMax !== null && nextMax <= 1,
  });
}

// ---------------------------------------------------------------- rendering
function renderControls() {
  $('resort-pills').innerHTML = UI.renderPills(S.resorts, S.order, { active: S.resort, favorites: S.favorites });
  $('profile-select').innerHTML = UI.renderProfileOptions(PROFILES, S.profile);
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
  if (offline || anyStale) {
    el.classList.remove('hidden');
    el.innerHTML = `<div class="banner banner-warn">⚠️ ${offline ? 'به اینترنت متصل نیستی — ' : ''}آخرین داده ذخیره‌شده نمایش داده می‌شود. ساعت داده هر بخش جداگانه مشخص است.</div>`;
  } else if (anyError) {
    el.classList.remove('hidden');
    el.innerHTML = `<div class="banner banner-warn">⚠️ دریافت داده بعضی ایستگاه‌ها ناموفق بود — بخش‌های دارای داده نمایش داده می‌شوند. <button class="underline font-black" data-action="retry">تلاش مجدد</button></div>`;
  } else {
    el.classList.add('hidden');
    el.innerHTML = '';
  }
}

function renderHero() {
  const ranked = rankResorts(
    S.order.map((id) => {
      const b = analyze(id, 0, S.profile);
      if (b.resort.failed) return null;
      return { ...b.resort, verdict: b.verdict, windowLabel: b.bestWindow.available ? `بهترین بازه ${UI.faNum(b.bestWindow.label)}` : null };
    }).filter(Boolean),
    S.profile
  );
  const dateStr = resortDate(ranked[0]?.resortId || S.order[0], 0);
  $('hero-body').innerHTML = UI.renderHero(ranked, {
    dateLabel: 'امروز' + (dateStr ? ` (${UI.fmtDayMonth(dateStr)})` : ''),
    profileLabel: (PROFILES[S.profile] || {}).label || '',
    stale: ranked.some((r) => (S.wx[r.resortId] || []).some((x) => x && x.stale)),
  });
}

function renderBestPickSection() {
  const cands = [];
  for (const id of S.order) {
    for (let d = 0; d < 7; d++) {
      const b = analyze(id, d, S.profile);
      if (b.resort.failed) continue;
      const rep = b.locs.find((a) => !a.failed && a.zone === 'summit') || b.locs.find((a) => !a.failed);
      cands.push({
        resortId: id, nameFa: b.resort.nameFa, dayIndex: d, date: b.resort.date,
        ski: b.resort.ski, safety: b.resort.safety, snowScore: b.resort.snowScore,
        fresh: b.resort.fresh24hCm, wind: b.resort.wind, gust: b.resort.gust, visKm: b.resort.visKm,
        depthCm: b.resort.depthCm, risk: b.resort.risk, hardStops: b.resort.hardStops,
        windowLabel: b.bestWindow.available ? UI.faNum(b.bestWindow.label) : null,
        prob: rep?.probMax ?? null,
      });
    }
  }
  const pick = findBestPick(cands, S.profile);
  const el = $('best-pick');
  // Never promote an AVOID day: if nothing in the window is at least CAUTION,
  // the CTA is not useful — the snow panel already says "no snow ahead".
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
    const b = analyze(S.resort, d, S.profile);
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
  const b = analyze(S.resort, S.day, S.profile);
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
    staleNote: 'اتصال را بررسی کن',
    lateDay: b.lateDay,
    dateLabel: `${UI.dayLabel(S.day, dateStr)}${dateStr ? ` • ${UI.fmtFull(dateStr)}` : ''}`,
  });
}

function renderForecast() {
  const days = [];
  const rankable = [];
  for (let d = 0; d < APP.forecastDays; d++) {
    const b = analyze(S.resort, d, S.profile);
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
      depthCm: b.resort.depthCm,
      risk: b.resort.risk,
      hardStops: b.resort.hardStops,
    });
  }
  // Mark the single best day (real verdict + blend, same rules as everywhere).
  const top = rankDays(rankable, S.profile, 1)[0];
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
  const b = analyze(S.resort, S.day, S.profile);
  const el = $('analysis');
  if (b.resort.failed) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  const dateStr = b.resort.date || resortDate(S.resort, S.day);
  el.classList.remove('hidden');
  el.innerHTML = UI.renderAnalysisPanel({
    verdict: b.verdict,
    why: b.why,
    confidence: b.confidence,
    dataQuality: b.dataQuality,
    risk: b.resort.risk,
    updatedAt: b.updatedAt,
    stale: b.stale,
    resortName: b.resort.nameFa,
    dateLabel: `${UI.dayLabel(S.day, dateStr)}${dateStr ? `، ${UI.fmtDayMonth(dateStr)}` : ''}`,
    skiFactors: b.skiFactors,
    safetyFactors: b.safetyFactors,
  });
}

function renderComparePanel() {
  const el = $('compare-panel');
  const ranked = rankResorts(
    S.order.map((id) => {
      const b = analyze(id, S.day, S.profile);
      if (b.resort.failed) return null;
      return { ...b.resort, verdict: b.verdict };
    }).filter(Boolean),
    S.profile
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
    const b = analyze(S.resort, d, S.profile);
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
  // Prefer verdict-first ranking; require some snow opportunity to show.
  const top = rankDays(days, S.profile, 3)
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
  $('footer-meta').textContent = `حالت: ${(PROFILES[S.profile] || {}).label || ''} • افق: ${APP.forecastDays} روز • منبع: ${APP.dataSource}`;
}

// ---------------------------------------------------------------- actions
function syncUrl() {
  try {
    const p = new URLSearchParams({ resort: S.resort, day: String(S.day), profile: S.profile });
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
  $('profile-select').addEventListener('change', (e) => {
    S.profile = e.target.value;
    storeSet('profile', S.profile);
    S.memo.clear();
    renderAll();
  });
  document.querySelectorAll('.theme-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      applyTheme(btn.dataset.theme);
      storeSet('theme', btn.dataset.theme);
    });
  });
  window.addEventListener('online', () => renderAll());
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
}

function selectResort(id) {
  if (!S.resorts[id] || id === S.resort) {
    if (S.resorts[id]) renderAll();
    return;
  }
  S.resort = id;
  S.day = 0;
  storeSet('resort', id);
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

async function retryLoad() {
  setLoading(true);
  $('global-error').classList.add('hidden');
  await loadAll(true);
  setLoading(false);
  renderAll();
  loadRoad(S.resort);
}

function openChart(locIdx) {
  const b = analyze(S.resort, S.day, S.profile);
  const a = b.locs[locIdx];
  if (!a || a.failed) {
    UI.toast('داده ساعتی موجود نیست');
    return;
  }
  const dateStr = b.resort.date;
  $('modal-title').textContent = `نمودار ساعتی — ${a.nameFa}${dateStr ? ` (${UI.fmtDayMonth(dateStr)})` : ''}`;
  const canvas = $('hourly-chart');
  const ok = renderHourlyChart(canvas, a._hours, a.depthCm);
  if (!ok) {
    UI.toast(hasCharts() ? 'خطا در رسم نمودار' : 'نمودار نیاز به اینترنت دارد (CDN)');
    return;
  }
  $('hourly-modal').classList.remove('hidden');
  $('hourly-modal').classList.add('flex');
}

function closeModal() {
  $('hourly-modal').classList.add('hidden');
  $('hourly-modal').classList.remove('flex');
  destroyHourlyChart();
}

async function shareCurrent() {
  const b = analyze(S.resort, S.day, S.profile);
  const dateStr = b.resort.date || '';
  const v = b.verdict || { label: '' };
  const text = b.resort.failed
    ? `❄️ برف‌کو — وضعیت پیست‌ها`
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
  const tick = () => {
    try {
      $('live-clock').textContent = new Intl.DateTimeFormat('fa-IR', {
        timeZone: APP.timezone, weekday: 'long', year: 'numeric', month: 'long',
        day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      }).format(new Date());
    } catch { /* ignore */ }
  };
  tick();
  setInterval(tick, 1000);
}

function setupAutoRefresh() {
  setInterval(async () => {
    if (document.hidden) return;
    await loadAll(false);
    renderAll();
    loadRoad(S.resort);
  }, CACHE_TTL_MS);
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
  // Race guard: boot() awaits API calls, so the window 'load' event may have
  // already fired by the time we register the listener.
  if (document.readyState === 'complete') go();
  else window.addEventListener('load', go, { once: true });
}

// Debug handle (factors etc. inspectable from console).
window.SnowF = { state: S, analyze, VERDICTS, version: '3.0.0' };

document.addEventListener('DOMContentLoaded', boot);
