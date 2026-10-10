/**
 * SnowF — Central configuration for ALL scoring formulas and thresholds.
 *
 * Design rules (enforced across the codebase):
 *  1. No formula constants may live inside scoring functions — everything is here.
 *  2. No double counting: each physical factor contributes ONCE per score.
 *     - Wind: a single "effective wind" = max(sustained, gust * GUST_WEIGHT).
 *     - Snowfall (fresh) vs snow depth (existing) vs snow surface (condition)
 *       are three SEPARATE concepts with separate contributions.
 *     - Instability (CAPE + Lifted Index) is evaluated as ONE combined factor.
 *  3. Safety and Ski Quality are INDEPENDENT dimensions. Safety can only
 *     gate/downgrade the final verdict — never be averaged away by quality.
 *  4. Every score returns its factor breakdown for explainability ("why?").
 *
 * Units: °C, km/h, cm (snow), mm (rain), m (altitude), km (visibility).
 */

// ---------------------------------------------------------------------------
// Global / API / cache
// ---------------------------------------------------------------------------
export const APP = {
  nameFa: 'برف‌کو',
  nameEn: 'SnowF',
  version: 'v3.0',
  timezone: 'Asia/Tehran',
  locale: 'fa-IR',
  dataSource: 'Open-Meteo',
  forecastDays: 16,
};

export const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes (fresh forecast)
export const STALE_OK_MS = 6 * 60 * 60 * 1000; // accept stale cache offline up to 6h (flagged)

// Skiable hours of day (local time) used for "best time" search.
export const SKI_HOURS = { start: 7, end: 16, minWindowHours: 2 };

// ---------------------------------------------------------------------------
// Weights: how the 3 elevation stations combine into ONE resort score.
// Summit matters most (best snow), mid second, base least.
// ---------------------------------------------------------------------------
export const ELEVATION_WEIGHTS = { summit: 0.45, mid: 0.35, low: 0.2 };

// ---------------------------------------------------------------------------
// SKI QUALITY (0-100) — additive model from a neutral base.
// Contribution bands are evaluated top→bottom, first match wins.
// ---------------------------------------------------------------------------
export const SKI = {
  base: 52,

  // --- Existing snow depth (operational viability: is there enough snow?) ---
  depth: [
    { min: 40, points: 14, label: 'عمق برف عالی' },
    { min: 25, points: 10, label: 'عمق برف خوب' },
    { min: 15, points: 4, label: 'عمق برف متوسط' },
    { min: 8, points: -8, label: 'برف کم' },
    { min: -Infinity, points: -22, label: 'کمبود جدی برف' },
  ],

  // --- Fresh snowfall in last 24h (freshness bonus, NOT depth) ---
  fresh: [
    { min: 20, points: 12, label: 'برف تازه فراوان' },
    { min: 10, points: 10, label: 'برف تازه خوب' },
    { min: 5, points: 6, label: 'برف تازه متوسط' },
    { min: 2, points: 3, label: 'برف تازه کم' },
    { min: 0.1, points: 1, label: 'ته‌نشست جزئی برف' },
    { min: -Infinity, points: 0, label: 'بدون برف تازه' },
  ],

  // --- Snow SURFACE condition (from snow-quality module). One factor only. ---
  // Keyed by category id returned by estimateSnowSurface().
  surface: {
    powder: { points: 8, label: 'سطح پودری (برآورد)' },
    fresh: { points: 8, label: 'سطح تازه (برآورد)' },
    packed: { points: 4, label: 'سطح کوبیده مناسب (برآورد)' },
    firm: { points: 0, label: 'سطح سفت (برآورد)' },
    windAffected: { points: -4, label: 'سطح بادخورده (برآورد)' },
    refrozen: { points: -8, label: 'احتمال سطح یخ‌زده (برآورد)' },
    wet: { points: -10, label: 'برف خیس (برآورد)' },
    poor: { points: -6, label: 'سطح نامناسب (برآورد)' },
    unknown: { points: -3, label: 'وضعیت سطح نامشخص' },
  },

  // --- Effective wind = max(sustained, gust * GUST_WEIGHT). SINGLE factor. ---
  GUST_WEIGHT: 0.65,
  wind: [
    { max: 12, points: 3, label: 'باد آرام' },
    { max: 20, points: 0, label: 'باد ملایم' },
    { max: 28, points: -8, label: 'باد متوسط' },
    { max: 38, points: -16, label: 'باد شدید' },
    { max: 48, points: -26, label: 'باد بسیار شدید' },
    { max: Infinity, points: -34, label: 'باد توفنده' },
  ],

  // --- Visibility (comfort/enjoyment side; safety handles the risk side) ---
  visibilityKm: [
    { min: 10, points: 4, label: 'دید عالی' },
    { min: 5, points: 1, label: 'دید خوب' },
    { min: 2, points: -8, label: 'دید محدود' },
    { min: 1, points: -15, label: 'دید ضعیف' },
    { min: -Infinity, points: -22, label: 'دید بسیار ضعیف' },
  ],

  // --- Feels-like temperature (comfort). Extremes are handled by Safety. ---
  // Bands as [min, max] inclusive.
  feelsLike: [
    { min: -9, max: -1, points: 4, label: 'دمای ایده‌آل اسکی' },
    { min: -13, max: -9.01, points: 1, label: 'دمای مناسب' },
    { min: -0.99, max: 1, points: 1, label: 'دمای مناسب' },
    { min: -17, max: -13.01, points: -5, label: 'هوای سرد' },
    { min: 1.01, max: 3, points: -5, label: 'هوای گرم برای برف' },
    { min: -Infinity, max: Infinity, points: -9, label: 'دمای نامناسب' },
  ],

  // --- Cloud cover (flat light / enjoyment). Small effect by design. ---
  cloudPct: [
    { max: 25, points: 2, label: 'آسمان صاف' },
    { max: 65, points: 0, label: 'ابری متغیر' },
    { max: 90, points: -3, label: 'ابری' },
    { max: Infinity, points: -5, label: 'کاملاً ابری' },
  ],

  // --- Ongoing precipitation DURING ski hours (comfort side). ---
  ongoingSnowRateCmH: [
    { max: 0.3, points: 0, label: 'بدون بارش قابل توجه' },
    { max: 1.5, points: -2, label: 'برف سبک حین اسکی' },
    { max: Infinity, points: -5, label: 'برف سنگین حین اسکی' },
  ],
  ongoingRainMm: { threshold: 0.5, points: -8, label: 'باران حین اسکی' },
  ongoingFreezingRain: { points: -12, label: 'احتمال باران یخ‌زده (برآورد)' },

  // --- Convective instability: ONE combined factor from CAPE + Lifted Index.
  // A "severe" verdict from this factor alone is forbidden — it only nudges
  // quality; Safety treats strong instability as a risk input, not a closure.
  instability: [
    { cape: 1200, li: -5, points: -8, label: 'ناپایداری قابل توجه جو' },
    { cape: 600, li: -3, points: -4, label: 'ناپایداری خفیف جو' },
    { cape: -1, li: 99, points: 0, label: 'جو پایدار' },
  ],
};

// ---------------------------------------------------------------------------
// SNOW SURFACE model (0-100). NOTE: depth is deliberately NOT part of this
// score (depth lives in Ski Quality viability). This score answers:
// "given that snow exists, what is its likely surface condition?"
// ---------------------------------------------------------------------------
export const SNOW = {
  base: 58,
  freshGood: { min: 10, points: 14 }, // cm in 24h
  freshSome: { min: 4, points: 8 },
  idealTemp: { min: -8, max: -2, points: 6 },
  rainWet: { min: 0.5, points: -22, label: 'باران روی برف' },
  warmMelt: { min: 1, points: -14, label: 'دمای ذوب' },
  warmSoft: { min: 0, points: -6, label: 'دمای نزدیک صفر' },
  refreeze: { points: -10, label: 'احتمال یخ‌زدگی شبانه' },
  windScour: [
    { max: 35, points: 0 },
    { max: 50, points: -4 },
    { max: Infinity, points: -8 },
  ],
  heavyOngoingSnow: { rate: 2, points: -4 }, // cm/h — deep unconsolidated, tiring
  // Powder heuristic (all must hold): fresh snow + cold + moderate wind.
  powder: { freshMin: 8, tempMax: -2, windMax: 30 },
};

// ---------------------------------------------------------------------------
// SAFETY (0-100). Subtractive model from 100. Each factor counted ONCE.
// ---------------------------------------------------------------------------
export const SAFETY = {
  base: 100,

  // Wind: gust is the primary signal; sustained is only a fallback estimate.
  // Calibration principle: ONE serious factor ≈ -40 (safety 60 → CAUTION);
  // two serious factors → below 40 → AVOID. Gates live in VERDICT.
  gustFallbackFactor: 1.45, // gust ≈ sustained * 1.45 when gust is missing
  gust: [
    { max: 40, points: 0 },
    { max: 50, points: -12 },
    { max: 60, points: -25 },
    { max: 75, points: -40 },
    { max: 85, points: -55 },
    { max: Infinity, points: -70 },
  ],

  visibilityKm: [
    { min: 5, points: 0 },
    { min: 2, points: -8 },
    { min: 1, points: -18 },
    { min: -Infinity, points: -40 },
  ],

  snowfallRateCmH: [
    { max: 0.7, points: 0 },
    { max: 1.5, points: -4 },
    { max: 3, points: -10 },
    { max: Infinity, points: -20 },
  ],

  rainOnSnow: { rainMin: 2, depthMin: 15, points: -15, mildPoints: -6, mildRainMin: 0.5 },
  freezingRain: { points: -25 }, // estimated, never asserted as certain
  warming24h: [
    { min: 8, points: -12 },
    { min: 5, points: -7 },
    { min: -Infinity, points: 0 },
  ],
  feelsLikeMin: [
    { min: -17, points: 0 },
    { min: -22, points: -8 },
    { min: -28, points: -18 },
    { min: -Infinity, points: -30 },
  ],
  // ONE combined convection factor (CAPE primary, LI secondary).
  convection: [
    { cape: 1500, li: -6, points: -18, label: 'ناپایداری همرفتی بالا (برآورد)' },
    { cape: 800, li: -4, points: -8, label: 'ناپایداری همرفتی متوسط (برآورد)' },
    { cape: 400, li: -99, points: -3, label: 'ناپایداری خفیف (برآورد)' },
    { cape: -1, li: 99, points: 0, label: 'همرفت قابل توجه نیست' },
  ],
  deterioration: { points: -8, label: 'بدتر شدن شرایط در ساعات آینده' },

  // Mountain-risk CAPS on safety (caps, not subtractions → no double counting
  // with the individual factors above that partly feed the risk index).
  riskCaps: { low: 100, moderate: 90, elevated: 60, high: 35 },

  // Missing critical data CAPS: when wind/visibility cannot be verified,
  // safety may not claim high values. (Confidence drops too, separately.)
  missingWindCap: 85,
  missingVisCap: 90,

  // Hard stops → verdict AVOID regardless of everything else.
  hardStops: {
    gustKmh: 85,
    visibilityKm: 0.5,
    freezingRainStrong: true,
  },
};

// ---------------------------------------------------------------------------
// WEATHER-RELATED MOUNTAIN RISK (estimate — NOT an official avalanche forecast).
// Point model → 4 bands. Deliberately NOT a 1-5 EAWS scale.
// ---------------------------------------------------------------------------
export const RISK = {
  fresh24h: [
    { min: 40, points: 3 },
    { min: 25, points: 2 },
    { min: 12, points: 1 },
    { min: -Infinity, points: 0 },
  ],
  intensityRate: { min: 2, points: 1 }, // cm/h
  windLoading: { freshMin: 8, gustHigh: 55, gustMid: 40, highPoints: 2, midPoints: 1 },
  warming24h: { min: 8, points: 1 },
  rainOnSnow: { rainMin: 2, points: 2 },
  freezingLevelAboveStation: { points: 1 },
  lowVisibility: { maxKm: 1, points: 1 },
  bands: [
    { max: 1, id: 'low', label: 'کم', icon: '🟢' },
    { max: 3, id: 'moderate', label: 'متوسط', icon: '🟡' },
    { max: 5, id: 'elevated', label: 'بالا', icon: '🟠' },
    { max: Infinity, id: 'high', label: 'خیلی بالا', icon: '🔴' },
  ],
  disclaimer:
    'این شاخص صرفاً برآوردی از شرایط جوی مرتبط با ریسک کوهستان است و نمی‌تواند جایگزین گزارش رسمی بهمن، اطلاعیه پیست یا توصیه کارشناسان کوهستان باشد.',
};

// ---------------------------------------------------------------------------
// VERDICT gates. Safety gates are GLOBAL FLOORS — profiles may only raise
// the GO bar (casual), never lower it.
// ---------------------------------------------------------------------------
export const VERDICT = {
  safetyAvoidBelow: 40, // safety < 40 → AVOID, no matter the quality
  safetyCautionBelow: 65, // safety < 65 → at most CAUTION
  qualityAvoidBelow: 30, // quality < 30 → AVOID (miserable, not worth it)
  qualityCautionBelow: 50, // quality < 50 → at most CAUTION
  minDepthCm: 8, // below → AVOID with "likely closed / thin cover" note
};

// ---------------------------------------------------------------------------
// USER PROFILES — quality-side preference only. Safety floors untouched.
// Deltas are small additive nudges recorded as explainable factors.
// ---------------------------------------------------------------------------
export const PROFILES = {
  casual: {
    id: 'casual', label: 'تفریحی / خانواده', icon: '🧣',
    desc: 'اولویت با ایمنی، دید خوب و هوای ملایم',
    goSafetyMin: 72, // stricter than global 65 — allowed (raising the bar)
    goQualityMin: 55,
  },
  intermediate: {
    id: 'intermediate', label: 'متوسط', icon: '🎿',
    desc: 'تعادل بین کیفیت برف و راحتی',
    goSafetyMin: 65, goQualityMin: 50,
  },
  advanced: {
    id: 'advanced', label: 'حرفه‌ای', icon: '⛷️',
    desc: 'تحمل بیشتر باد و سرما، تمرکز بر کیفیت برف',
    goSafetyMin: 65, goQualityMin: 45, // quality bar may drop; safety NEVER below global
  },
  powder: {
    id: 'powder', label: 'شکارچی پودر', icon: '❄️',
    desc: 'اولویت با برف تازه؛ ایمنی همچنان خط قرمز است',
    goSafetyMin: 65, goQualityMin: 50,
  },
};

// Profile nudges applied inside Ski Quality (documented, explainable).
// Labels use plain Persian; "پاداش"/"کاهش" show the direction of the nudge.
export const PROFILE_NUDGES = {
  casual: [
    { when: 'cold', points: -2, label: 'کاهش به‌خاطر سرما (حالت تفریحی)' },
    { when: 'goodVis', points: 2, label: 'پاداش دید خوب (حالت تفریحی)' },
    { when: 'windy', points: -3, label: 'کاهش به‌خاطر باد (حالت تفریحی)' },
  ],
  intermediate: [],
  advanced: [
    { when: 'breezy', points: 4, label: 'تحمل باد (حالت حرفه‌ای)' },
    { when: 'lowVisOk', points: 3, label: 'تحمل دید متوسط (حالت حرفه‌ای)' },
    { when: 'coldOk', points: 2, label: 'تحمل سرما (حالت حرفه‌ای)' },
  ],
  powder: [
    { when: 'deepFresh', points: 8, label: 'پاداش برف تازه (حالت پودر)' },
    { when: 'someFresh', points: 4, label: 'پاداش برف تازه (حالت پودر)' },
    { when: 'noFresh', points: -6, label: 'کاهش به‌خاطر نبود برف تازه (حالت پودر)' },
  ],
};

// ---------------------------------------------------------------------------
// SNOW OPPORTUNITY (0-100) — "is it worth waiting/going for snow?"
// ---------------------------------------------------------------------------
export const OPPORTUNITY = {
  freshFcstCm: [
    { min: 15, points: 38 },
    { min: 8, points: 30 },
    { min: 4, points: 20 },
    { min: 1, points: 10 },
    { min: -Infinity, points: 0 },
  ],
  probability: [
    { min: 70, points: 14 },
    { min: 40, points: 7 },
    { min: -Infinity, points: 0 },
  ],
  tempOk: { max: 0, points: 8 },
  windOk: [
    { max: 30, points: 10 },
    { max: 40, points: 4 },
    { max: Infinity, points: -10 },
  ],
  persistence: { points: 8 }, // next-day max stays cold → snow lasts
  windAffectedCap: 55, // heavy snow + strong wind → capped (wind-affected day)
  windAffected: { freshMin: 8, gustMin: 55 },
};

// ---------------------------------------------------------------------------
// CONFIDENCE — trust in the recommendation given data completeness/horizon.
// NOT a scientific probability.
// ---------------------------------------------------------------------------
export const CONFIDENCE = {
  horizon: [
    { maxDay: 2, base: 88 },
    { maxDay: 5, base: 74 },
    { maxDay: 9, base: 60 },
    { maxDay: Infinity, base: 45 },
  ],
  missingVarPenalty: 6,
  missingVarMaxPenalty: 18,
  stalePenalty: 10,
  contradictionPenalty: 5,
};

// ---------------------------------------------------------------------------
// Detection thresholds (flags shown as estimates / likelihoods)
// ---------------------------------------------------------------------------
export const FLAGS = {
  rainOnSnow: { rainMm: 0.5, depthCm: 10 },
  refreeze: { prevDayMaxAbove: 0.5, nightMinBelow: -1, morningBelow: 0 },
  windLoading: { freshMin: 8, gustMin: 40 },
  freezingRain: { precipMin: 0.5, tempMin: -3, tempMax: 0.5, humidityMin: 88 },
  deterioration: { skiDrop: 10, windRise: 15, visDropKm: 3 },
  noSnowDepth: 15, // below → "thin cover" note
};

// Miscellaneous labels
export const LIFT_ESTIMATE = [
  { max: 20, label: 'احتمالاً همه تله‌ها فعال (برآورد)' },
  { max: 35, label: 'احتمال فعالیت تله‌ها (برآورد)' },
  { max: 50, label: 'احتمال محدودیت تله‌ها (برآورد)' },
  { max: Infinity, label: 'احتمال توقف تله‌ها (برآورد)' },
];

export const LENS = [
  { vlt: '80-95%', fa: 'شفاف', when: 'شب' },
  { vlt: '50-80%', fa: 'زرد', when: 'دید کم / ابری سنگین' },
  { vlt: '30-50%', fa: 'نارنجی', when: 'نیمه‌ابری' },
  { vlt: '15-30%', fa: 'برنزی', when: 'کمی ابری' },
  { vlt: '5-15%', fa: 'تیره/آینه‌ای', when: 'آفتابی' },
];
