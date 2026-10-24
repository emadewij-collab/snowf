/**
 * SnowF — UI rendering (string builders + tiny DOM helpers).
 * All user-facing text is Persian (RTL). Numbers use Persian digits.
 */

import { APP, RISK, MODEL } from './config.js';
import { VERDICTS } from './recommendation.js';
import { safetyLabel } from './safety.js';
import { isNum } from './weather.js';

// ---------------------------------------------------------------- formatting
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Persian-digit number (null/NaN → '—'). */
export function faNum(v, decimals = null) {
  if (v === null || v === undefined || v === '' || (typeof v === 'number' && !isNum(v))) return '—';
  let s = typeof v === 'number' ? (decimals !== null ? v.toFixed(decimals) : String(Math.round(v * 10) / 10)) : String(v);
  s = s.replace(/[0-9]/g, (d) => FA_DIGITS[d]).replace(/-/g, '−');
  return s;
}

const fmtTemp = (v) => (v === null || v === undefined ? '—' : `${faNum(Math.round(v))}°`);
const fmtKmh = (v) => (v === null || v === undefined ? '—' : `${faNum(Math.round(v))} km/h`);
const fmtCm = (v) => (v === null || v === undefined ? '—' : `${faNum(Math.round(v))} cm`);
// Visibility is a model estimate — don't imply false precision (41.9 → ۴۲).
const fmtKm = (v) => (v === null || v === undefined ? '—' : `${faNum(Math.round(v))} km`);
const fmtPct = (v) => (v === null || v === undefined ? '—' : `${faNum(Math.round(v))}٪`);

function parseDay(dateStr) {
  if (typeof dateStr !== 'string' || dateStr.length < 10) return new Date();
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}
function fmtWeekday(dateStr) {
  return new Intl.DateTimeFormat('fa-IR', { weekday: 'long', timeZone: APP.timezone }).format(parseDay(dateStr));
}
export function fmtDayMonth(dateStr) {
  return new Intl.DateTimeFormat('fa-IR', { day: 'numeric', month: 'long', timeZone: APP.timezone }).format(parseDay(dateStr));
}
export function fmtFull(dateStr) {
  return new Intl.DateTimeFormat('fa-IR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: APP.timezone }).format(parseDay(dateStr));
}
export function dayLabel(dayIndex, dateStr) {
  if (dayIndex === 0) return 'امروز';
  if (dayIndex === 1) return 'فردا';
  return dateStr ? fmtWeekday(dateStr) : '';
}
export function fmtTime(dateMs) {
  return new Intl.DateTimeFormat('fa-IR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: APP.timezone }).format(new Date(dateMs));
}

/**
 * Split "now" into a Persian DATE and a separate TIME.
 *
 * Why not one string: `Intl` with fa-IR renders the date as
 * "۱۴۰۵ مهر ۲۹, چهارشنبه ساعت ۱۳:۰۸:۰۷" — the year comes first (not the
 * natural Persian day-month-year order) and the date and the time are
 * welded together by the literal "ساعت". Inside a bidi context that
 * scrambles visually. So we assemble the parts ourselves and keep the two
 * values in two separate elements (the time in an LTR isolate).
 *
 * @returns {{ date: string, time: string }}
 */
export function formatClock(date = new Date(), timeZone = APP.timezone) {
  try {
    const parts = new Intl.DateTimeFormat('fa-IR', {
      timeZone,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
    // Natural Persian order: weekday, day, month, year.
    const dateText = [get('weekday'), get('day'), get('month'), get('year')].filter(Boolean).join(' ');
    // Some ICU builds render midnight as hour 24 — normalise to 00.
    const rawHour = get('hour');
    const hour = rawHour === '24' || rawHour === '۲۴' ? '۰۰' : rawHour;
    const timeText = [hour, get('minute'), get('second')].filter(Boolean).join(':');
    return { date: dateText, time: timeText };
  } catch {
    return { date: '', time: '' };
  }
}

// ---------------------------------------------------------------- primitives
/** CSS class for a score badge (gradient background). */
function scoreClass(score) {
  if (!isNum(score)) return 'score-medium';
  if (score >= 80) return 'score-excellent';
  if (score >= 65) return 'score-good';
  if (score >= 50) return 'score-medium';
  if (score >= 35) return 'score-poor';
  return 'score-danger';
}

/** Persian quality label for a ski score. */
function skiLabel(score) {
  if (!isNum(score)) return 'نامشخص';
  if (score >= 80) return 'عالی';
  if (score >= 65) return 'خوب';
  if (score >= 50) return 'متوسط';
  if (score >= 35) return 'ضعیف';
  return 'خیلی ضعیف';
}

function verdictBadge(v, size = '') {
  const meta = VERDICTS[v] || VERDICTS.caution;
  return `<span class="verdict-${meta.id} px-3 py-1 rounded-full font-black ${size}">${meta.icon} ${meta.label}</span>`;
}

/** Compact gradient badge for a score + its Persian label. */
function scoreBadge(icon, score, text) {
  return `<span class="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-black text-white ${scoreClass(score)}">${icon} ${faNum(score)}<span class="opacity-90 font-bold">${esc(text)}</span></span>`;
}

function barRow(label, value, cls = 'bar-ski') {
  const v = isNum(value) ? Math.max(0, Math.min(100, value)) : 0;
  const low = isNum(value) && value < 40 ? 'bar-low' : '';
  return `
    <div>
      <div class="flex justify-between text-xs font-bold mb-1"><span>${label}</span><span class="tnum">${faNum(value)}<span class="opacity-60">/۱۰۰</span></span></div>
      <div class="score-bar"><span class="${cls} ${low}" style="width:${v}%"></span></div>
    </div>`;
}

export function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2600);
}

export function refreshIcons() {
  try {
    if (typeof window !== 'undefined' && window.lucide) window.lucide.createIcons();
  } catch { /* icons are decorative */ }
}

// ---------------------------------------------------------------- hero
const HERO_TABS = [
  { id: 'today', label: 'امروز' },
  { id: 'tomorrow', label: 'فردا' },
  { id: 'week', label: 'این هفته' },
];

function segTabs(items, active, action, ariaLabel = 'انتخاب حالت') {
  return `<div class="seg" role="tablist" aria-label="${ariaLabel}">` +
    items.map((i) => `<button role="tab" aria-selected="${i.id === active}" class="${i.id === active ? 'active' : ''}" data-action="${action}" data-mode="${i.id}">${i.label}</button>`).join('') +
    `</div>`;
}

/**
 * Hero payload:
 *  today/tomorrow: { mode, ranked, dateLabel, stale }
 *  week:           { mode, weekRows, weekBest, allAvoid }
 */
export function renderHero({ mode, ranked = [], dateLabel = '', stale = false, weekRows = [], weekBest = null, allAvoid = false } = {}) {
  const title = mode === 'tomorrow' ? '🏔️ فردا کجا بریم؟' : mode === 'week' ? '📅 این هفته کجا و چه روزی؟' : '🏔️ امروز کجا بریم؟';
  const head = `<div class="flex items-center justify-between gap-3 flex-wrap mb-4">
    <h2 class="section-title !mb-0">${title}</h2>
    ${segTabs(HERO_TABS, mode, 'hero-mode')}
  </div>`;

  if (mode === 'week') {
    return head + renderHeroWeek(weekRows, weekBest, allAvoid);
  }

  if (!ranked.length) {
    return head + `<div class="banner banner-bad">⚠️ داده‌ای برای بررسی پیست‌ها موجود نیست.</div>`;
  }
  const top = ranked[0];
  const v = top.verdict || { verdict: 'caution' };
  const allAvoid2 = ranked.every((r) => (r.verdict?.verdict || 'avoid') === 'avoid');
  const rows = ranked
    .map((r) => {
      const safetyWarn = isNum(r.safety) && r.safety < 65 ? ' <span title="ایمنی نیازمند احتیاط">⚠️</span>' : '';
      return `
      <button class="rank-row ${!allAvoid2 && r.rank === 1 ? 'top' : ''}" data-action="goto-resort" data-resort="${esc(r.resortId)}" aria-label="نمایش ${esc(r.nameFa)}">
        <span class="text-xl">${allAvoid2 ? '❄️' : r.medal}</span>
        <span class="font-black flex-1">${esc(r.nameFa)}</span>
        <span class="text-xs opacity-70 tnum">🎿 ${faNum(r.ski)} • 🛡 ${faNum(r.safety)}${safetyWarn}</span>
        <span class="text-lg">${(VERDICTS[r.verdict.verdict] || {}).icon || ''}</span>
      </button>`;
    })
    .join('');

  if (allAvoid2) {
    const reasons = (top.verdict?.reasons || []).slice(0, 2).join(' • ');
    return head + `
    <div class="verdict-avoid rounded-2xl p-5 text-white">
      <div class="text-2xl font-black">❄️ برای ${mode === 'tomorrow' ? 'فردا' : 'امروز'} هیچ پیست پیشنهاد نمی‌شود</div>
      <div class="text-sm leading-6 opacity-95 mt-2">
        ${esc(reasons || 'شرایط جوی مساعد نیست')}. رفتن توصیه نمی‌شود.
        برای روزهای دیگر، حالت «این هفته» و دکمه‌ی «کی برف میاد؟» را ببینید.
      </div>
    </div>
    <div class="flex flex-col gap-2 mt-3">${rows}</div>
    <p class="meta-line mt-3 text-center">شاخص‌ها برآوردی‌اند و دقت علمی ندارند</p>`;
  }

  return head + `
    <div class="verdict-${v.verdict} rounded-2xl p-4 md:p-5 text-white mb-4">
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div class="text-xs opacity-80 font-bold mb-1">🥇 بهترین انتخاب ${esc(dateLabel)}</div>
          <button class="text-3xl font-black hover:underline" data-action="goto-resort" data-resort="${esc(top.resortId)}">${esc(top.nameFa)}</button>
          <div class="mt-1 font-bold">${v.icon} ${v.label || ''}</div>
        </div>
        <div class="text-left bg-white/20 px-4 py-2 rounded-2xl">
          <div class="text-3xl font-black tnum">${faNum(top.blend)}</div>
          <div class="text-xs opacity-80">شاخص اولویت /۱۰</div>
        </div>
      </div>
      <div class="grid grid-cols-3 gap-2 mt-4 text-center text-sm">
        <div class="bg-white/15 rounded-xl p-2"><div class="text-xs opacity-80">🎿 کیفیت اسکی</div><div class="font-black tnum">${faNum(top.ski)}</div></div>
        <div class="bg-white/15 rounded-xl p-2"><div class="text-xs opacity-80">🛡 ایمنی</div><div class="font-black tnum">${faNum(top.safety)}${isNum(top.safety) && top.safety < 65 ? ' ⚠️' : ''}</div></div>
        <div class="bg-white/15 rounded-xl p-2"><div class="text-xs opacity-80">❄️ کیفیت برف</div><div class="font-black tnum">${faNum(top.snowScore)}</div></div>
      </div>
      <div class="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-sm font-bold">
        <span>🌨️ تازه: ${fmtCm(top.fresh24hCm)}</span>
        <span>💨 باد: ${fmtKmh(top.wind)}</span>
        <span>👁️ دید: ${fmtKm(top.visKm)}</span>
        ${top.windowLabel ? `<span>⏰ ${esc(top.windowLabel)}</span>` : ''}
      </div>
      ${v.safetyGate ? `<div class="mt-3 text-sm font-bold bg-black/25 rounded-xl px-3 py-2">🛡 شاخص کیفیت خوب است، اما ایمنی اجازه‌ی «برو» نمی‌دهد — جزئیات را ببینید.</div>` : ''}
      ${!v.safetyGate && isNum(top.safety) && top.safety < 65 ? `<div class="mt-3 text-sm font-bold bg-black/25 rounded-xl px-3 py-2">🛡 ایمنی: نیازمند احتیاط (${faNum(top.safety)}) — رتبه‌ی بالا به‌تنهایی تضمین ایمنی نیست.</div>` : ''}
      ${stale ? `<div class="mt-2 text-xs opacity-80">⚠️ بر اساس آخرین داده‌ی ذخیره‌شده</div>` : ''}
      <div class="mt-2 text-xs opacity-75">شاخص‌ها برآوردی‌اند؛ عدد دقیق به معنای دقت علمی نیست.</div>
    </div>
    <div class="flex flex-col gap-2">${rows}</div>
    <div class="mt-3 text-center">
      <button class="btn btn-ghost text-sm" data-action="goto-resort" data-resort="${esc(top.resortId)}">نمایش جزئیات ${esc(top.nameFa)} ←</button>
    </div>`;
}

/** Week view: best resort per day + the single best (resort, day). */
function renderHeroWeek(weekRows = [], weekBest = null, allAvoid = false) {
  if (!weekRows.length) {
    return `<div class="banner banner-bad">⚠️ داده‌ای برای هفته موجود نیست.</div>`;
  }
  const best = allAvoid
    ? `<div class="verdict-avoid rounded-2xl p-4 md:p-5 text-white mb-4">
        <div class="text-xl font-black">❄️ در این هفته هیچ روز مناسبی پیدا نشد</div>
        <div class="text-sm leading-6 opacity-95 mt-1">برای برف، «کی برف میاد؟» را تا ۱۶ روز آینده چک کنید.</div>
      </div>`
    : weekBest
    ? `
    <div class="verdict-${weekBest.verdict.verdict} rounded-2xl p-4 md:p-5 text-white mb-4">
      <div class="text-xs opacity-80 font-bold mb-1">⭐ بهترین روز هفته • ${weekBest.verdict.icon} ${esc(weekBest.verdict.label || '')}</div>
      <button class="text-2xl font-black hover:underline" data-action="goto-resort-day" data-resort="${esc(weekBest.resortId)}" data-day="${weekBest.dayIndex}">
        📍 ${esc(weekBest.nameFa)} — 📅 ${esc(fmtFull(weekBest.date))}
      </button>
      ${weekBest.windowLabel ? `<div class="font-bold mt-1">⏰ ساعت پیشنهادی: ${esc(weekBest.windowLabel)}</div>` : ''}
      <div class="flex flex-wrap gap-2 mt-2 text-xs font-bold">
        ${(weekBest.reasons || []).map((r) => `<span class="bg-white/15 rounded-lg px-2 py-1">${esc(r)}</span>`).join('')}
      </div>
    </div>`
    : '';
  const rows = weekRows
    .map((r) => `
      <button class="rank-row" data-action="goto-resort-day" data-resort="${esc(r.resortId)}" data-day="${r.dayIndex}" aria-label="نمایش ${esc(r.nameFa)} در ${esc(r.label)}">
        <span class="font-bold w-28 text-right shrink-0">${esc(r.label)}<span class="block text-xs opacity-60 font-normal">${esc(r.dateShort)}</span></span>
        <span class="font-black flex-1">${esc(r.nameFa)}</span>
        <span class="text-xs opacity-70 tnum">🎿 ${faNum(r.ski)} • 🛡 ${faNum(r.safety)}</span>
        <span class="text-lg">${(VERDICTS[r.verdict] || {}).icon || ''}</span>
      </button>`)
    .join('');
  return `${best}
    <div class="flex flex-col gap-2">${rows}</div>
    <p class="meta-line mt-3 text-center">برای هر روز، بهترین پیست هفته انتخاب شده • شاخص‌ها برآوردی‌اند</p>`;
}

// ---------------------------------------------------------------- best pick
export function renderBestPick(pick, { dateStr = '' } = {}) {
  if (!pick) return '';
  const v = pick.verdict || {};
  return `
    <div class="glass-card rounded-3xl p-5 relative overflow-hidden">
      <div class="absolute top-0 left-0 w-full h-1.5 bg-gradient-to-l from-amber-400 via-orange-500 to-pink-500"></div>
      <h2 class="section-title">⏳ اگر فقط یک روز فرصت داری</h2>
      <button class="w-full text-right verdict-${v.verdict || 'caution'} rounded-2xl p-4" data-action="goto-pick" data-resort="${esc(pick.resortId)}" data-day="${pick.dayIndex}">
        <div class="text-sm opacity-90 font-bold">پیشنهاد سیستم</div>
        <div class="text-2xl font-black mt-1">📍 ${esc(pick.nameFa)} — 📅 ${esc(fmtFull(dateStr || pick.date))}</div>
        ${pick.windowLabel ? `<div class="font-bold mt-1">⏰ ساعت پیشنهادی: ${esc(pick.windowLabel)}</div>` : ''}
        <ul class="mt-2 text-sm font-bold flex flex-col gap-1">
          ${(pick.reasons || []).map((r) => `<li>${esc(r)}</li>`).join('')}
        </ul>
      </button>
      <p class="meta-line mt-2">بر اساس ترکیب کیفیت، ایمنی و برف در ۷ روز آینده • ${esc(v.label || '')}</p>
    </div>`;
}

// ---------------------------------------------------------------- controls
export function renderPills(resorts = {}, ids = [], { active = '', favorites = [] } = {}) {
  return ids
    .map((id) => {
      const r = resorts[id];
      if (!r) return '';
      const fav = favorites.includes(id);
      return `
      <span class="inline-flex items-center">
        <button class="resort-pill ${id === active ? 'active' : ''}" role="tab" aria-selected="${id === active}" data-action="select-resort" data-resort="${esc(id)}">${esc(r.nameFa)}</button>
        <button class="star-btn ${fav ? 'fav' : ''}" data-action="toggle-fav" data-resort="${esc(id)}" title="${fav ? 'حذف از علاقه‌مندی' : 'علاقه‌مندی'}" aria-label="${fav ? 'حذف از علاقه‌مندی' : 'افزودن به علاقه‌مندی'} ${esc(r.nameFa)}" aria-pressed="${fav}">${fav ? '⭐' : '☆'}</button>
      </span>`;
    })
    .join('');
}

export function renderDaySelector(days = [], selected = 0) {
  const dot = { go: '#22c55e', caution: '#f59e0b', avoid: '#ef4444' };
  return days
    .map((d) => {
      const v = d.verdict || 'caution';
      return `
      <button class="day-btn ${d.dayIndex === selected ? 'active' : ''}" role="tab" aria-selected="${d.dayIndex === selected}" data-action="select-day" data-day="${d.dayIndex}">
        <span class="text-xs opacity-80">${esc(d.label)}</span>
        <span class="text-sm font-black whitespace-nowrap">${esc(d.dateShort)}</span>
        <span class="verdict-dot" style="background:${dot[v] || dot.caution}" title="${esc((VERDICTS[v] || {}).label || '')}"></span>
      </button>`;
    })
    .join('');
}

// ---------------------------------------------------------------- technical layer
/**
 * The technical layer: everything about HOW the numbers were produced.
 * Deliberately collapsed — the primary view stays about the decision,
 * not about the model grid.
 *
 * @param {object} t
 *   { source, model, gridKm, sharedCell, stations[], minSafety, minSafetyZone,
 *     dataQuality, missingCount, updatedAt, stale }
 */
export function renderTechnicalDetails(t = {}, { label = '' } = {}) {
  const stations = t.stations || [];
  const dq = t.dataQuality?.level;
  const dqLabel = dq === 'good' ? 'خوب' : dq === 'limited' ? 'محدود' : 'ضعیف';

  return `
  <details class="snowf-details">
    <summary>🔧 جزئیات فنی محاسبه${label ? ` — ${esc(label)}` : ''}</summary>
    <div class="details-body text-sm leading-7">
      <p><b>منبع داده:</b> ${esc(t.source || APP.dataSource)} — مدل <span dir="ltr">${esc(t.model || MODEL.name)}</span> با شبکه‌ی حدود ${faNum(t.gridKm ?? MODEL.gridKm)} کیلومتر.</p>

      <p class="mt-2"><b>تصحیح ارتفاع:</b> دمای مدل به ارتفاع واقعی هر ایستگاه منتقل می‌شود (نرخ گرادیان ۶٫۵ درجه بر کیلومتر). این تنها متغیری است که مدل در شبکه‌ی درشت به‌ازای ارتفاع تفکیک می‌کند.</p>
      ${stations.length ? `
      <div class="mt-2 overflow-x-auto">
        <table class="compare-table" style="min-width: 420px">
          <thead><tr class="opacity-70">
            <th class="p-2 text-right">ایستگاه</th><th class="p-2">ارتفاع</th>
            <th class="p-2">ارتفاع DEM</th><th class="p-2">اصلاح دما</th>
          </tr></thead>
          <tbody>
            ${stations.map((s) => `
            <tr>
              <td class="p-2 text-right font-bold">${esc(s.nameFa)}</td>
              <td class="p-2 tnum">${faNum(s.alt)} m</td>
              <td class="p-2 tnum opacity-70">${s.demAlt === null ? '—' : faNum(s.demAlt) + ' m'}</td>
              <td class="p-2 tnum">${s.delta === null ? '<span class="opacity-50">—</span>' : `${s.delta > 0 ? '+' : '−'}${faNum(Math.abs(s.delta), 1)}°C`}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>` : ''}

      ${t.sharedCell ? `
      <p class="mt-2"><b>⚠️ محدودیت شبکه:</b> بعضی از ایستگاه‌های این پیست در یک سلول از شبکه‌ی مدل می‌افتند. در آن سلول، باد و بارشِ ایستگاه‌ها یکسان است و فقط دما تفکیک می‌شود — پس «بهترین ارتفاع» در چنین پیستی نشانه‌ی داده‌ی مستقل نیست.</p>` : ''}

      ${isNum(t.minSafety) && t.minSafety < 55 ? `
      <p class="mt-2"><b>کف ایمنی:</b> رأی نهایی علاوه بر میانگین پیست، با ضعیف‌ترین ایستگاه هم محدود می‌شود${t.minSafetyZone ? ` (${esc(t.minSafetyZone)})` : ''}: <span class="tnum">${faNum(t.minSafety)}/۱۰۰</span>.</p>` : ''}

      <p class="mt-2"><b>کیفیت داده:</b> ${esc(dqLabel)}${isNum(t.missingCount) ? ` — ${faNum(t.missingCount)} متغیر کلیدی ناقص` : ''}${t.updatedAt ? ` • آخرین دریافت: ${esc(fmtTime(t.updatedAt))}${t.stale ? ' (ذخیره‌شده)' : ''}` : ''}</p>
      ${(t.confidenceNotes || []).length ? `<p class="mt-1"><b>پایه توصیه پایین‌تر است چون:</b> ${esc(t.confidenceNotes.join(' • '))}</p>` : ''}
    </div>
  </details>`;
}

// ---------------------------------------------------------------- resort detail
export function renderResortDetail(ctx = {}) {
  const { resort, analysis, verdict, bestWindow, bestElev, why, confidence, trend, snowOpp, stale, updatedAt, lateDay, technical, technicalLabel } = ctx;
  if (!analysis || analysis.failed) {
    return `<div class="glass-card rounded-3xl p-6 text-center">
      <div class="text-4xl mb-2">⚠️</div>
      <p class="font-black">داده‌ای برای ${esc(resort?.nameFa || 'این پیست')} دریافت نشد</p>
      <p class="text-sm opacity-70 mt-1">${esc(analysis?.failReason || '')}</p>
      <button class="btn btn-primary mt-4" data-action="retry">تلاش مجدد</button>
    </div>`;
  }
  const v = verdict || { verdict: 'caution', icon: '🟡', label: '' };
  const headLabel = v.verdict === 'avoid' && v.safetyGate ? '🔴 شرایط ایمنی نامناسب' : `${v.icon} ${v.label}`;
  const summary = plainSummary({ resort, verdict: v, bestWindow });

  // Best-elevation station first; the rest collapse behind a toggle.
  const cards = (analysis.locations || [])
    .map((a, i) => ({ a, i, html: a && !a.failed ? stationCard(a, resort, i, ctx) : failedStationCard(a, i) }));
  const bestIdx = bestElev?.available ? (analysis.locations || []).findIndex((a) => a && !a.failed && a.zone === bestElev.zone) : 0;
  const firstIdx = bestIdx >= 0 ? bestIdx : cards.length ? cards.findIndex((c) => c.a && !c.a.failed) : -1;
  const first = cards[firstIdx]?.html || cards[0]?.html || '';
  const rest = cards.filter((_, k) => k !== firstIdx).map((c) => c.html);

  return `
  <div class="fade-in">
    <div class="verdict-${v.verdict} rounded-3xl p-5 md:p-6 mb-6">
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div class="text-sm opacity-90 font-bold">${esc(ctx.dateLabel || '')} • ${esc(resort.fullNameFa || resort.nameFa)}</div>
          <div class="text-2xl md:text-3xl font-black mt-1">${esc(headLabel)}</div>
          <div class="text-base font-bold mt-2 opacity-95">${esc(summary)}</div>
        </div>
        <div class="flex gap-2">
          <button class="bg-white/20 hover:bg-white/30 rounded-xl px-3 py-2 text-sm font-black" data-action="share-resort">اشتراک ↗</button>
        </div>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4">
        <div class="bg-white/15 rounded-2xl p-3">${barRow('🎿 شاخص کیفیت اسکی', analysis.ski, 'bar-ski')}</div>
        <div class="bg-white/15 rounded-2xl p-3">${barRow('🛡 شاخص ایمنی', analysis.safety, 'bar-safety')}</div>
        <div class="bg-white/15 rounded-2xl p-3">${barRow('❄️ شاخص کیفیت برف (برآورد)', analysis.snowScore, 'bar-snow')}</div>
      </div>
      <p class="text-xs opacity-75 mt-2">شاخص‌ها برآوردی‌اند. ۸۰+ خوب • ۶۵+ قابل قبول • ۵۰+ متوسط • کمتر از ۳۵ نامناسب</p>
      ${stale ? `<div class="mt-2 text-xs font-bold">⚠️ آخرین داده ذخیره‌شده (${esc(fmtTime(updatedAt))}) — ${esc(ctx.staleNote || '')}</div>` : ''}
      ${lateDay ? `<div class="mt-2 text-sm font-bold bg-black/25 rounded-xl px-3 py-2">🌙 ساعات اسکی امروز تقریباً گذشته است — این تحلیل بر اساس کل روز است؛ برای برنامه‌ریزی، روزهای آینده را ببین.</div>` : ''}
    </div>

    <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
      <div class="glass-card p-4">
        <h3 class="font-black mb-2">⏰ بهترین بازه امروز</h3>
        ${bestWindow?.available
          ? `<div class="text-xl font-black accent-text tnum">${esc(faNum(bestWindow.label))}</div>
             <div class="text-xs opacity-70 mt-1">میانگین شاخص ساعتی: ${faNum(bestWindow.avgScore)}</div>
             <ul class="why-list mt-2">${(bestWindow.why || []).map((w) => `<li>• ${esc(w)}</li>`).join('')}</ul>`
          : `<p class="text-sm opacity-70">${esc(bestWindow?.reason || 'نامشخص')}</p>`}
      </div>
      <div class="glass-card p-4">
        <h3 class="font-black mb-2">🏔️ بهترین ارتفاع</h3>
        ${bestElev?.available
          ? `<div class="text-xl font-black accent-text">${esc(bestElev.nameFa)}</div>
             <ul class="why-list mt-2">${(bestElev.reasons || []).map((w) => `<li>• ${esc(w)}</li>`).join('')}</ul>
             <div class="flex gap-1 mt-2 flex-wrap">${(bestElev.ranking || []).map((r) => `<span class="pill text-xs">${esc(r.shortFa)}: <b class="tnum">${faNum(r.ski)}</b></span>`).join('')}</div>`
          : `<p class="text-sm opacity-70">نامشخص</p>`}
      </div>
      <div class="glass-card p-4">
        <h3 class="font-black mb-2">📊 روند و فرصت برف</h3>
        <p class="text-sm font-bold">${esc(trend?.label || 'روند نامشخص')}</p>
        ${trend?.detail ? `<p class="text-xs opacity-70">${esc(trend.detail)}</p>` : ''}
        <div class="mt-3">${barRow('فرصت برف', snowOpp?.score ?? 0, 'bar-opp')}</div>
        <p class="text-xs opacity-70 mt-1">${esc(snowOpp?.label || '')}</p>
      </div>
    </div>

    <div class="glass-card p-4 mb-6">
      <h3 class="font-black mb-3">🕐 تایم‌لاین ساعات اسکی (۷ تا ۱۶)</h3>
      ${renderTimeline(ctx.timeline || [], bestWindow)}
      <p class="meta-line mt-2">نوار زیر هر ساعت = شاخص آن ساعت (سبز: خوب، قرمز: ضعیف) • ستون پررنگ = بازه پیشنهادی</p>
    </div>

    <div class="mb-6">${renderTechnicalDetails(technical, { label: technicalLabel })}</div>

    <div>${first}</div>
    ${rest.length ? `
    <details class="snowf-details my-4">
      <summary>ایستگاه‌های دیگر (${faNum(rest.length)})</summary>
      <div class="details-body">
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">${rest.join('')}</div>
      </div>
    </details>` : ''}
  </div>`;
}

/** Plain-language one-liner: what a beginner should read first. */
function plainSummary({ resort, verdict, bestWindow }) {
  const name = resort?.nameFa || 'پیست';
  if (verdict.verdict === 'avoid') {
    const reason = (verdict.reasons || [])[0] || 'شرایط مساعد نیست';
    return verdict.safetyGate
      ? `${name}: ایمنی پایین است — رفتن توصیه نمی‌شود.`
      : `${name}: ${reason} — رفتن توصیه نمی‌شود.`;
  }
  if (verdict.verdict === 'caution') {
    const win = bestWindow?.available ? ` بهترین بازه: ${bestWindow.label}.` : '';
    return `${name}: قابل اسکی است ولی با احتیاط.${win}`;
  }
  const win = bestWindow?.available ? ` بهترین بازه: ${bestWindow.label}.` : '';
  return `${name}: شرایط مناسب است.${win}`;
}

function windStatus(w) {
  if (!isNum(w)) return 'نامشخص';
  if (w <= 20) return 'ایده‌آل';
  if (w <= 35) return 'قابل قبول';
  if (w <= 50) return 'نامناسب';
  return 'خطرناک';
}

function failedStationCard(a, i) {
  return `<div class="glass-card rounded-3xl p-5 text-center opacity-80">
    <div class="text-3xl mb-2">📡</div>
    <p class="font-black text-sm">ایستگاه ${faNum(i + 1)}: داده دریافت نشد</p>
    <p class="text-xs opacity-60 mt-1">${esc(a?.failReason || 'خطای موقت')}</p>
  </div>`;
}

function stationCard(a, resort, locIdx, ctx) {
  const v = ctx.verdictsByLoc?.[locIdx] || { verdict: 'caution', icon: '🟡', label: 'نامشخص' };
  const riskCls = { low: 'risk-low', moderate: 'risk-moderate', elevated: 'risk-elevated', high: 'risk-high' }[a.risk.band] || 'risk-moderate';
  const flagPills = [];
  if (a.refreeze?.likely) flagPills.push(`<span class="pill pill-warn text-xs">🧊 ${esc(a.refreeze.label)}</span>`);
  if (a.rainOnSnow?.active) flagPills.push(`<span class="pill pill-bad text-xs">${esc(a.rainOnSnow.label)}</span>`);
  if (a.rainOnSnow?.unknown) flagPills.push(`<span class="pill pill-warn text-xs">🌧️ ${esc(a.rainOnSnow.unknownReason)}</span>`);
  if (a.freezingRain?.likely) flagPills.push(`<span class="pill pill-bad text-xs">${esc(a.freezingRain.label)}</span>`);
  if (a.windLoading) flagPills.push(`<span class="pill pill-warn text-xs">🌬️ انباشت برف با باد (برآورد)</span>`);

  return `
  <article class="glass-card rounded-3xl overflow-hidden">
    <div class="p-4 verdict-${v.verdict} text-white">
      <div class="flex justify-between items-center mb-2">
        <span class="text-xl font-black">${v.icon} ${v.label}</span>
        <span class="text-left bg-white/20 px-3 py-1 rounded-full"><span class="text-xl font-black tnum">${faNum(a.ski.score)}</span><span class="text-xs opacity-80">/۱۰۰</span></span>
      </div>
      <div class="flex gap-2 text-xs font-bold">
        <span class="bg-white/15 rounded-lg px-2 py-1">🎿 ${faNum(a.ski.score)}</span>
        <span class="bg-white/15 rounded-lg px-2 py-1">🛡 ${faNum(a.safety.score)}</span>
        <span class="bg-white/15 rounded-lg px-2 py-1">❄️ ${faNum(a.snow.score)}</span>
      </div>
    </div>

    <div class="px-5 py-3 flex justify-between items-center border-b" style="border-color: var(--border)">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-xl accent-bg flex items-center justify-center shadow-lg" style="color: var(--accent-contrast)">
          <i data-lucide="mountain" class="w-5 h-5" aria-hidden="true"></i>
        </div>
        <div>
          <h3 class="font-black">${esc(a.nameFa)}</h3>
          <span class="text-xs opacity-60 tnum dir-ltr">${faNum(a.alt)}m</span>
        </div>
      </div>
      <button class="btn btn-ghost text-xs px-3" data-action="open-chart" data-loc="${locIdx}" aria-label="نمودار ساعتی ${esc(a.nameFa)}">📈 ساعتی</button>
    </div>

    ${flagPills.length ? `<div class="px-5 pt-3 flex flex-wrap gap-1">${flagPills.join('')}</div>` : ''}

    <div class="p-5 text-center">
      <div class="text-5xl font-black dir-ltr mb-1 tnum">${faNum(a.temp)}°</div>
      <div class="flex justify-center gap-3 text-sm opacity-60 dir-ltr mb-2 tnum">
        <span>↓${faNum(a.tempMin)}°</span><span>↑${faNum(a.tempMax)}°</span>
      </div>
      <div class="inline-flex items-center gap-2 soft-card px-3 py-1.5 text-sm">
        <span>احساس دما: <b class="tnum">${faNum(a.feelsLike)}°</b></span>
      </div>
    </div>

    <div class="grid grid-cols-4 gap-px border-y text-center" style="border-color: var(--border); background: var(--border)">
      ${statCell('wind', fmtKmh(a.wind).replace(' km/h', ''), 'km/h باد')}
      ${statCell('eye', a.visKm === null ? '—' : faNum(a.visKm, 1), 'km دید')}
      ${statCell('snowflake', a.fresh24hCm === null ? '—' : faNum(a.fresh24hCm), 'cm تازه')}
      ${statCell('cloud', a.cloud === null ? '—' : fmtPct(a.cloud), 'ابر')}
    </div>

    <div class="p-4 flex flex-col gap-2 text-sm">
      <div class="soft-card p-3 flex items-center justify-between gap-2">
        <div><div class="font-black">💨 ${esc(windStatus(a.wind))} <span class="tnum text-xs opacity-70">(${fmtKmh(a.wind)}${a.gust !== null ? `، گاست ${faNum(a.gust)}` : ''})</span></div>
        <div class="text-xs opacity-70 mt-1">${a.windDir ? `جهت: ${esc(a.windDir)} • ` : ''}${esc(a.lift)}</div></div>
      </div>
      <div class="soft-card p-3">
        <div class="font-black">❄️ ${esc(a.snow.label)} <span class="text-xs opacity-60">(برآورد)</span></div>
        <div class="text-xs opacity-70 mt-1">عمق برف: <b class="tnum">${a.depthCm === null ? 'نامشخص' : fmtCm(a.depthCm)}</b> • برف تازه ۲۴ ساعته: <b class="tnum">${fmtCm(a.fresh24hCm)}</b></div>
      </div>
      <div class="soft-card p-3">
        <div class="flex items-center justify-between gap-2">
          <div class="font-black text-sm">⛰️ ریسک جوی کوهستان <span class="text-xs opacity-60">(برآورد)</span></div>
          <span class="${riskCls} px-2 py-0.5 rounded-full text-xs font-black">${a.risk.icon} ${esc(a.risk.label)}</span>
        </div>
        ${(a.risk.drivers || []).slice(0, 2).map((d) => `<div class="text-xs opacity-70 mt-1">• ${esc(d.label)}</div>`).join('')}
      </div>
      <div class="soft-card p-3 text-xs flex flex-wrap gap-x-4 gap-y-1 justify-between">
        <span>🕶️ لنز: <b>${esc(a.lens.fa)}</b> <span class="opacity-60 dir-ltr">(${esc(a.lens.vlt)})</span></span>
        <span>☀️ UV <b class="tnum">${faNum(a.uv)}</b></span>
        <span>🌅 <b class="tnum">${esc(a.sunrise ? faNum(a.sunrise) : '—')}</b></span>
        <span>🌇 <b class="tnum">${esc(a.sunset ? faNum(a.sunset) : '—')}</b></span>
      </div>
      ${a.freezingReading?.text ? `<div class="soft-card p-3 text-xs"><span>${esc(a.freezingReading.text)}</span></div>` : ''}
      ${(v.reasons || []).length ? `<div class="text-xs font-bold opacity-80">علت: ${esc(v.reasons.join(' • '))}</div>` : ''}
    </div>
  </article>`;
}

function statCell(icon, value, unit) {
  return `<div class="p-3" style="background: var(--bg-soft)">
    <i data-lucide="${icon}" class="w-4 h-4 mx-auto opacity-50 mb-1" aria-hidden="true"></i>
    <div class="text-lg font-black tnum">${value}</div>
    <div class="text-xs opacity-60">${unit}</div>
  </div>`;
}

function renderTimeline(rows = [], bestWindow = null) {
  if (!rows.length) return '<p class="text-sm opacity-60">داده ساعتی موجود نیست.</p>';
  const inWin = (h) => bestWindow?.available && h >= bestWindow.start && h < bestWindow.end;
  return `<div class="timeline" role="list" aria-label="تایم‌لاین ساعتی">` + rows
    .map((r) => {
      const snowIcon = (r.snowfall || 0) >= 0.5 ? '🌨️' : (r.rain || 0) >= 0.3 ? '🌧️' : (r.cloud || 0) > 70 ? '☁️' : (r.cloud || 0) > 30 ? '⛅' : '☀️';
      const pct = Math.max(0, Math.min(100, r.score ?? 0));
      const color = pct >= 65 ? '#22c55e' : pct >= 45 ? '#f59e0b' : '#ef4444';
      return `<div class="tl-cell ${inWin(r.hour) ? 'best' : ''}" role="listitem">
        <div class="font-black tnum">${faNum(String(r.hour).padStart(2, '0'))}:۰۰</div>
        <div class="text-base">${snowIcon}</div>
        <div class="tnum font-bold">${faNum(r.temp)}°</div>
        <div class="opacity-70 tnum">💨${faNum(r.wind)}</div>
        <div class="tl-bar"><span style="width:${pct}%;background:${color}"></span></div>
        <div class="font-black tnum" style="color:${color}">${faNum(r.score)}</div>
      </div>`;
    })
    .join('') + `</div>`;
}

// ---------------------------------------------------------------- forecast
export function renderForecastStrip(days = [], selected = 0) {
  if (!days.length) return '<p class="text-sm opacity-60">داده پیش‌بینی موجود نیست.</p>';
  const icon = { go: '🟢', caution: '🟡', avoid: '🔴' };
  return days
    .map((d) => `
      <button class="fc-card ${d.dayIndex === selected ? 'selected' : ''} ${d.isBest ? 'best' : ''}" data-action="select-day" data-day="${d.dayIndex}" aria-label="${esc(d.label)} ${esc(d.dateShort)}">
        <div class="text-xs font-bold opacity-70">${d.isBest ? '⭐ ' : ''}${esc(d.label)}</div>
        <div class="text-xs font-black">${esc(d.dateShort)}</div>
        <div class="text-xl my-1">${icon[d.verdict] || '⚪'}</div>
        <div class="text-xs tnum font-bold">🎿${faNum(d.ski)} 🛡${faNum(d.safety)}</div>
        <div class="text-xs opacity-70 tnum mt-1">❄️${faNum(d.fresh)}cm • ↓${faNum(d.tmin)}° ↑${faNum(d.tmax)}°</div>
      </button>`)
    .join('');
}

// ---------------------------------------------------------------- analysis
const ANALYSIS_TABS = [
  { id: 'today', label: 'امروز' },
  { id: 'tomorrow', label: 'فردا' },
  { id: 'week', label: 'هفته' },
];

export function renderAnalysisPanel(ctx = {}) {
  const { verdict, why, confidence, dataQuality, risk, updatedAt, stale, resortName, dateLabel, skiFactors, safetyFactors, mode = 'today', technical } = ctx;
  const v = verdict || { verdict: 'caution', icon: '🟡', label: '' };
  const dqLabel = dataQuality?.level === 'good' ? '✅ خوب' : dataQuality?.level === 'limited' ? '⚠️ محدود' : '🔴 ضعیف';
  return `
  <div class="glass-card rounded-3xl p-5 md:p-6 relative overflow-hidden">
    <div class="absolute top-0 left-0 w-full h-1.5 bg-gradient-to-l from-purple-500 via-pink-500 to-orange-500"></div>
    <div class="flex items-center justify-between gap-3 flex-wrap mb-3">
      <div class="flex items-center gap-3 flex-wrap">
        <h2 class="section-title !mb-0">🧭 تحلیل تصمیم <span class="text-sm font-bold opacity-60">— ${esc(resortName || '')}، ${esc(dateLabel || '')}</span></h2>
        ${verdictBadge(v.verdict, 'text-sm')}
      </div>
      ${segTabs(ANALYSIS_TABS, mode, 'analysis-mode')}
    </div>
    ${(isNum(ctx.ski) || isNum(ctx.safety)) ? `
    <div class="flex flex-wrap gap-2 mb-3">
      ${isNum(ctx.ski) ? scoreBadge('🎿', ctx.ski, skiLabel(ctx.ski)) : ''}
      ${isNum(ctx.safety) ? scoreBadge('🛡', ctx.safety, safetyLabel(ctx.safety)) : ''}
    </div>` : ''}
    ${(isNum(ctx.minSafety) && isNum(ctx.safety) && ctx.minSafety < ctx.safety) ? `
    <div class="soft-card p-3 mb-3 text-sm">
      <b>⚠️ یکی از ایستگاه‌های این پیست شرایط ناامن‌تری دارد</b> (${esc(ctx.minSafetyZone || '')}: <span class="tnum">${faNum(ctx.minSafety)}/۱۰۰</span>) —
      به همین دلیل رأی نهایی با بدترین ایستگاه هم محدود می‌شود.
    </div>` : ''}
    <div class="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
      <div class="soft-card p-3">
        <h3 class="font-black text-sm mb-2">✅ نقاط قوت</h3>
        <ul class="why-list">${(why?.pros || []).map((x) => `<li>${esc(x)}</li>`).join('') || '<li class="opacity-60">—</li>'}</ul>
      </div>
      <div class="soft-card p-3">
        <h3 class="font-black text-sm mb-2">⚠️ نقاط ضعف</h3>
        <ul class="why-list">${(why?.cons || []).map((x) => `<li>${esc(x)}</li>`).join('') || '<li class="opacity-60">—</li>'}</ul>
      </div>
      <div class="soft-card p-3">
        <h3 class="font-black text-sm mb-2">📌 نکات</h3>
        <ul class="why-list">${(why?.notes || []).map((x) => `<li>${esc(x)}</li>`).join('') || '<li class="opacity-60">—</li>'}</ul>
      </div>
    </div>
    <details class="snowf-details mb-2">
      <summary>🔍 جزئیات شاخص‌ها (چرا این عدد؟)</summary>
      <div class="details-body">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div><h4 class="font-black text-sm mb-1">🎿 کیفیت اسکی</h4>${factorList(skiFactors)}</div>
          <div><h4 class="font-black text-sm mb-1">🛡 ایمنی</h4>${factorList(safetyFactors)}</div>
        </div>
      </div>
    </details>
    <div class="flex flex-wrap gap-2 text-xs">
      <span class="pill">🎯 پایه توصیه: <b>${esc(confidence?.label || 'نامشخص')}</b> <span class="opacity-70 tnum">(${faNum(confidence?.pct)}٪)</span></span>
      <span class="pill">📡 کیفیت داده: <b>${dqLabel}</b></span>
      <span class="pill">⛰️ ریسک جوی: <b>${risk?.icon || ''} ${esc(risk?.label || '')}</b> (برآورد)</span>
    </div>
    <p class="meta-line mt-2">«پایه توصیه» احتمال درست بودن پیش‌بینی نیست؛ فقط نشان می‌دهد داده‌های موجود چقدر کامل و تازه بوده‌اند.</p>
    ${(confidence?.notes || []).length ? `<p class="meta-line mt-1">پایه پایین‌تر است چون: ${esc(confidence.notes.join(' • '))}</p>` : ''}
    <p class="meta-line mt-1">⚠️ ${esc(RISK.disclaimer)}</p>
  </div>`;
}

/** Week mode: 7-day decision table for ONE resort. */
export function renderAnalysisWeek({ resortName = '', days = [], mode = 'week' } = {}) {
  const icon = { go: '🟢', caution: '🟡', avoid: '🔴' };
  const allAvoid = days.length > 0 && days.every((d) => d.verdict === 'avoid');
  const caption = allAvoid
    ? 'هیچ روزی این هفته رأی «برو» نگرفت — برای برف، «کی برف میاد؟» را تا ۱۶ روز آینده ببینید.'
    : '⭐ بهترین روز هفته (بر اساس رأی + ترکیب شاخص‌ها) • ریسک و ایمنی در رأی لحاظ شده‌اند';
  const body = days.length
    ? `<div class="compare-wrap" style="border-radius:14px;border:1px solid var(--border)">
      <table class="compare-table">
        <thead><tr class="opacity-70">
          <th class="p-3">روز</th><th class="p-3">رأی</th><th class="p-3">🎿 کیفیت</th>
          <th class="p-3">🛡 ایمنی</th><th class="p-3">🌨️ تازه</th><th class="p-3">⏰ بهترین بازه</th>
        </tr></thead>
        <tbody>
          ${days.map((d) => `
          <tr class="${d.isBest ? 'best-row' : ''}">
            <td class="p-3 font-black whitespace-nowrap">${d.isBest ? '⭐ ' : ''}${esc(d.label)} <span class="block text-xs opacity-60 font-normal">${esc(d.dateShort)}</span></td>
            <td class="p-3 text-lg" title="${esc((VERDICTS[d.verdict] || {}).label || '')}">${icon[d.verdict] || ''}</td>
            <td class="p-3 tnum font-bold">${faNum(d.ski)}</td>
            <td class="p-3 tnum font-bold">${faNum(d.safety)}</td>
            <td class="p-3 tnum font-bold">${faNum(d.fresh)} cm</td>
            <td class="p-3 tnum text-xs font-bold whitespace-nowrap">${d.windowLabel ? esc(faNum(d.windowLabel)) : '—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <p class="meta-line mt-2">${esc(caption)}</p>`
    : `<p class="text-sm opacity-60">داده‌ای برای هفته موجود نیست.</p>`;
  return `
  <div class="glass-card rounded-3xl p-5 md:p-6 relative overflow-hidden">
    <div class="absolute top-0 left-0 w-full h-1.5 bg-gradient-to-l from-purple-500 via-pink-500 to-orange-500"></div>
    <div class="flex items-center justify-between gap-3 flex-wrap mb-4">
      <h2 class="section-title !mb-0">🧭 تحلیل هفته — ${esc(resortName || '')}</h2>
      ${segTabs(ANALYSIS_TABS, mode, 'analysis-mode')}
    </div>
    ${body}
  </div>`;
}

function factorList(factors = []) {
  if (!factors?.length) return '<p class="text-xs opacity-60">—</p>';
  return factors
    .map((f) => {
      const cls = (f.points || 0) > 0 ? 'factor-plus' : (f.points || 0) < 0 ? 'factor-minus' : 'factor-zero';
      const pts = (f.points || 0) > 0 ? `+${faNum(f.points)}` : faNum(f.points || 0);
      return `<div class="factor-row"><span>${esc(f.label)}</span><span class="${cls} tnum">${pts}</span></div>`;
    })
    .join('');
}

// ---------------------------------------------------------------- compare
export function renderCompare(rows = [], { dateLabel = '' } = {}) {
  if (!rows.length) return `<div class="banner banner-bad">⚠️ داده‌ای برای مقایسه موجود نیست.</div>`;
  const icon = { go: '🟢', caution: '🟡', avoid: '🔴' };
  const hiSki = Math.max(...rows.map((r) => r.ski ?? -1));
  const hiSafety = Math.max(...rows.map((r) => r.safety ?? -1));
  const hiSnow = Math.max(...rows.map((r) => r.snow ?? -1));
  const hiFresh = Math.max(...rows.map((r) => r.fresh ?? -1));
  const loWind = Math.min(...rows.map((r) => (isNum(r.wind) ? r.wind : 9999)));
  const cell = (v, isBest, fmt) => `<td class="p-4 tnum font-bold ${isBest ? 'best-cell' : ''}">${fmt(v)}</td>`;
  return `
  <div class="glass-card rounded-3xl overflow-hidden">
    <div class="p-4 bg-gradient-to-l from-purple-500 to-pink-500 text-white">
      <div class="flex items-center justify-between gap-2">
        <div><h2 class="font-black text-xl">⚖️ مقایسه پیست‌ها</h2><span class="text-xs opacity-80">${esc(dateLabel)}</span></div>
        <button class="p-2 rounded-full hover:bg-white/20" data-action="close-compare" aria-label="بستن مقایسه">✕</button>
      </div>
    </div>
    <div class="compare-wrap">
      <table class="compare-table">
        <thead><tr class="opacity-70">
          <th class="p-4 font-bold">پیست</th><th class="p-4">رأی</th><th class="p-4">🎿 کیفیت</th>
          <th class="p-4">🛡 ایمنی</th><th class="p-4">❄️ برف</th><th class="p-4">💨 باد</th>
          <th class="p-4">👁️ دید</th><th class="p-4">🌨️ تازه</th><th class="p-4">⛰️ ریسک</th>
        </tr></thead>
        <tbody>
          ${rows.map((r) => `
          <tr>
            <td class="p-4 font-black whitespace-nowrap">${r.medal || ''} <button class="hover:underline" data-action="goto-resort" data-resort="${esc(r.resortId)}">${esc(r.nameFa)}</button></td>
            <td class="p-4 text-lg" title="${esc(r.verdict?.label || '')}">${icon[r.verdict?.verdict] || ''}</td>
            ${cell(r.ski, r.ski === hiSki, (x) => faNum(x))}
            ${cell(r.safety, r.safety === hiSafety, (x) => faNum(x))}
            ${cell(r.snow, r.snow === hiSnow, (x) => faNum(x))}
            ${cell(r.wind, r.wind === loWind, (x) => (isNum(x) ? `${faNum(x)}` : '—'))}
            ${cell(r.visKm, false, (x) => (isNum(x) ? faNum(x, 1) : '—'))}
            ${cell(r.fresh, r.fresh === hiFresh, (x) => faNum(x))}
            <td class="p-4 text-sm font-bold whitespace-nowrap">${r.risk?.icon || ''} ${esc(r.risk?.label || '—')}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <p class="meta-line p-3">بهترین هر ستون پررنگ‌تر است • ریسک = برآورد جوی، نه گزارش رسمی بهمن</p>
  </div>`;
}

// ---------------------------------------------------------------- snow panel
export function renderSnowPanel({ resortName = '', days = [] } = {}) {
  if (!days.length) {
    return `<div class="glass-card p-5 rounded-2xl text-center">
      <p class="font-black">تا ۱۶ روز آینده، برف قابل توجهی پیش‌بینی نمی‌شود</p>
      <p class="text-sm opacity-60 mt-1">هوا سرد می‌ماند ولی بارش برفی در پیش نیست — برنامه‌ی خوبی برای استراحت یا نگهداری تجهیزات است ❄️</p>
    </div>`;
  }
  // If every listed day has measurable snow we can say "snow days";
  // otherwise they are only days with a chance of snow.
  const allMeasured = days.every((d) => d.fresh > 0);
  const title = allMeasured ? '🎉 بهترین روزهای برفی' : '❄️ روزهای با احتمال برف';
  const subtitle = allMeasured
    ? 'مرتب‌شده بر اساس مقدار برفِ پیش‌بینی‌شده (فقط ساعت‌های زیر صفر) + شرایط باد و دما'
    : 'بارش قطعی نیست — فقط احتمال آن بالاست. مرتب‌شده بر اساس احتمال بارش برفی';  return `
  <div class="glass-card p-5 rounded-2xl relative overflow-hidden" style="background: linear-gradient(135deg, #0ea5e9, #6366f1); color: #fff;">
    <div class="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
      <div class="snow-particle"></div><div class="snow-particle"></div><div class="snow-particle"></div>
      <div class="snow-particle"></div><div class="snow-particle"></div><div class="snow-particle"></div>
    </div>
    <div class="text-center mb-4 relative z-10">
      <p class="text-white/80 text-sm mb-1">${title} ${esc(resortName)}</p>
      <p class="text-xs text-white/70">${esc(subtitle)}</p>
    </div>
    <div class="grid grid-cols-1 md:grid-cols-3 gap-3 relative z-10">
      ${days.map((d) => `
        <button class="bg-white/15 backdrop-blur-sm rounded-xl p-3 border border-white/25 text-center hover:bg-white/25 transition-colors" data-action="select-day" data-day="${d.dayIndex}">
          <div class="font-black">${d.medal} ${esc(d.label)}</div>
          <div class="text-xs opacity-80 mb-2">${esc(d.dateShort)}</div>
          <div class="bg-white rounded-lg py-2 mb-2">
            ${d.fresh >= 1
              ? `<span class="text-2xl font-black text-sky-600 tnum">${faNum(d.fresh)}</span>
                 <span class="text-xs text-gray-600 block">سانتی‌متر برف</span>`
              : d.fresh > 0
              ? `<span class="text-2xl font-black text-sky-600 tnum">زیر ۱</span>
                 <span class="text-xs text-gray-600 block">سانتی‌متر برف</span>`
              : `<span class="text-2xl font-black text-sky-600 tnum">${faNum(d.prob)}٪</span>
                 <span class="text-xs text-gray-600 block">احتمال بارش برفی</span>`}
          </div>
          <div class="text-xs font-bold tnum">🎿${faNum(d.ski)} 🛡${faNum(d.safety)} ${d.verdictIcon}</div>
          <div class="text-xs opacity-80 tnum mt-1">فرصت برف: ${faNum(d.opp)}</div>
        </button>`).join('')}
    </div>
  </div>`;
}

// ---------------------------------------------------------------- road
export function renderRoad(road, roadName = '') {
  if (!road || road.failed) return '';
  const cls = road.level === 'bad' ? 'banner-bad' : road.level === 'caution' ? 'banner-warn' : 'banner-ok';
  const icon = road.level === 'bad' ? '🔴' : road.level === 'caution' ? '🟡' : '🟢';
  return `
  <div class="glass-card rounded-2xl p-4">
    <div class="banner ${cls}">${icon} مسیر ${esc(roadName)}: ${esc(road.label)}</div>
    <ul class="why-list mt-2 text-sm">${(road.notes || []).map((n) => `<li>• ${esc(n)}</li>`).join('')}</ul>
    <p class="meta-line mt-2">⚠️ ${esc(road.disclaimer || '')}</p>
  </div>`;
}
