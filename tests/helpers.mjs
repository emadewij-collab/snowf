/**
 * Shared fixtures for SnowF unit tests.
 * Builds a minimal-but-realistic Open-Meteo-like payload for N days.
 */

export function makePayload({ days = 3, startDate = '2026-01-10', hourly = {}, daily = {} } = {}) {
  const times = [];
  const H = (key, fn) => {
    const arr = [];
    for (let d = 0; d < days; d++) for (let h = 0; h < 24; h++) arr.push(fn(d, h));
    return arr;
  };
  for (let d = 0; d < days; d++) {
    const dt = addDays(startDate, d);
    for (let h = 0; h < 24; h++) times.push(`${dt}T${String(h).padStart(2, '0')}:00`);
  }
  const def = {
    temperature_2m: H('t', (d, h) => -6 + Math.sin(h / 3) * 2 - d),
    relative_humidity_2m: H('h', () => 60),
    dew_point_2m: H('h', () => -12),
    apparent_temperature: H('h', () => -8),
    precipitation_probability: H('h', () => 10),
    precipitation: H('h', () => 0),
    rain: H('h', () => 0),
    showers: H('h', () => 0),
    snowfall: H('h', () => 0),
    snow_depth: H('h', () => 0.6), // meters!
    weather_code: H('h', () => 1),
    pressure_msl: H('h', () => 1015),
    cloud_cover: H('h', () => 20),
    cloud_cover_low: H('h', () => 10),
    cloud_cover_mid: H('h', () => 5),
    cloud_cover_high: H('h', () => 5),
    visibility: H('h', () => 20000),
    wind_speed_10m: H('h', () => 12),
    wind_direction_10m: H('h', () => 270),
    wind_gusts_10m: H('h', () => 20),
    cape: H('h', () => 0),
    lifted_index: H('h', () => 2),
    convective_inhibition: H('h', () => 50),
    freezing_level_height: H('h', () => 2200),
    is_day: H('h', (d, h) => (h >= 7 && h <= 17 ? 1 : 0)),
  };
  const D = (key, fn) => {
    const arr = [];
    for (let d = 0; d < days; d++) arr.push(fn(d));
    return arr;
  };
  const dates = [];
  for (let d = 0; d < days; d++) dates.push(addDays(startDate, d));
  const dailyDef = {
    time: dates,
    weather_code: D('w', () => 1),
    temperature_2m_max: D('w', (d) => -3 - d),
    temperature_2m_min: D('w', (d) => -10 - d),
    apparent_temperature_max: D('w', (d) => -5 - d),
    apparent_temperature_min: D('w', (d) => -12 - d),
    precipitation_sum: D('w', () => 0),
    rain_sum: D('w', () => 0),
    snowfall_sum: D('w', () => 0),
    precipitation_hours: D('w', () => 0),
    precipitation_probability_max: D('w', () => 10),
    wind_speed_10m_max: D('w', () => 15),
    wind_gusts_10m_max: D('w', () => 25),
    wind_direction_10m_dominant: D('w', () => 270),
    sunrise: dates.map((x) => `${x}T07:10`),
    sunset: dates.map((x) => `${x}T17:20`),
    uv_index_max: D('w', () => 2),
  };
  // Apply overrides: { varName: value | (d,h)=>value } / daily: { var: value | (d)=>value }
  for (const [k, v] of Object.entries(hourly)) {
    if (!def[k]) def[k] = new Array(days * 24).fill(null);
    def[k] = typeof v === 'function' ? H(k, v) : new Array(days * 24).fill(v);
  }
  for (const [k, v] of Object.entries(daily)) {
    if (!dailyDef[k]) dailyDef[k] = new Array(days).fill(null);
    dailyDef[k] = typeof v === 'function' ? D(k, v) : new Array(days).fill(v);
  }
  return { hourly: { time: times, ...def }, daily: dailyDef };
}

function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

/** Remove a variable entirely (simulate incomplete API payload). */
export function dropVar(payload, scope, name) {
  const c = JSON.parse(JSON.stringify(payload));
  delete c[scope][name];
  return c;
}
