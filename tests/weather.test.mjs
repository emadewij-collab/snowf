import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import {
  heightCorrection, inSkiWindow, trailing24hSum, freshSnow24h, dayEndIndex,
  buildDayHours, summarizeSkiWindow, gridInfo, gridCellKey, haversineKm,
  buildDayIndex, findNowIndex,
} from '../js/weather.js';
import { HEIGHT, SKI_HOURS } from '../js/config.js';
import { makePayload } from './helpers.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('height correction', () => {
  it('shifts the model temperature to the true station altitude', () => {
    // DEM says 2896 m, the station is really at 3600 m → 704 m colder.
    const data = { elevation: 2896 };
    const hc = heightCorrection(data, 3600);
    assert.equal(hc.applied, true);
    assert.equal(hc.demAlt, 2896);
    assert.equal(hc.targetAlt, 3600);
    assert.equal(hc.delta, Math.round(-704 * HEIGHT.lapseRate * 1000) / 1000);
    assert.ok(hc.delta < 0, 'a higher station must be colder');
  });

  it('is a no-op below the noise threshold', () => {
    const hc = heightCorrection({ elevation: 3000 }, 3010);
    assert.equal(hc.applied, false);
    assert.equal(hc.delta, 0);
  });

  it('is a no-op when the DEM elevation is unknown', () => {
    const hc = heightCorrection({}, 3600);
    assert.equal(hc.applied, false);
    assert.equal(hc.delta, 0);
  });

  it('is a no-op when the target altitude is unknown', () => {
    const hc = heightCorrection({ elevation: 2896 }, null);
    assert.equal(hc.applied, false);
  });

  it('applies the shift to temperature-like variables only', () => {
    const p = makePayload({ daily: {} });
    p.elevation = 2500;
    const plain = buildDayHours(p, 0);
    const shifted = buildDayHours(p, 0, { targetAlt: 3000 });
    const d = Math.round(-500 * HEIGHT.lapseRate * 100) / 100;
    assert.equal(shifted[0].temp - plain[0].temp, d);
    assert.equal(shifted[0].appTemp - plain[0].appTemp, d);
    // wind / precip / cloud must NOT move
    assert.equal(shifted[0].wind, plain[0].wind);
    assert.equal(shifted[0].precip, plain[0].precip);
    assert.equal(shifted[0].cloud, plain[0].cloud);
    assert.equal(shifted[0].snowDepth, plain[0].snowDepth);
  });

  it('only requests the variables the app actually reads', () => {
    const api = readFileSync(join(ROOT, 'js/api.js'), 'utf8');
    const list = api.match(/const HOURLY_VARS = \[([\s\S]*?)\];/)[1];
    const vars = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    // none of these is read by any engine or by the UI
    for (const dead of ['showers', 'weather_code', 'pressure_msl', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high', 'convective_inhibition', 'dew_point_2m']) {
      assert.ok(!vars.includes(dead), `${dead} is never read — it must not be requested`);
    }
    // and the ones we do rely on must still be there
    for (const need of ['temperature_2m', 'apparent_temperature', 'relative_humidity_2m', 'precipitation', 'rain', 'snowfall', 'snow_depth', 'cloud_cover', 'visibility', 'wind_speed_10m', 'wind_gusts_10m', 'cape', 'lifted_index', 'freezing_level_height']) {
      assert.ok(vars.includes(need), `${need} is required`);
    }
  });
});

describe('ski window is half-open', () => {
  it('excludes the closing hour (07:00–16:00 → rows 7…15)', () => {
    assert.equal(inSkiWindow(7), true);
    assert.equal(inSkiWindow(15), true);
    assert.equal(inSkiWindow(16), false);
    assert.equal(inSkiWindow(6), false);
    assert.equal(SKI_HOURS.end, 16);
  });

  it('summarizeSkiWindow uses the same rule', () => {
    const p = makePayload();
    const win = summarizeSkiWindow(buildDayHours(p, 0));
    assert.equal(win.count, SKI_HOURS.end - SKI_HOURS.start);
    assert.equal(win.hours[0].hour, SKI_HOURS.start);
    assert.equal(win.hours[win.hours.length - 1].hour, SKI_HOURS.end - 1);
  });
});

describe('trailing 24h sums', () => {
  it('sums the last 24 hourly values ending at endIndex', () => {
    const arr = Array.from({ length: 48 }, (_, i) => i);
    // indices 7…30 → (7+30) * 24 / 2
    assert.equal(trailing24hSum(arr, 30), 444);
  });

  it('clamps at the start of the array', () => {
    assert.equal(trailing24hSum([1, 1, 1], 1), 2);
  });

  it('returns null for an out-of-range index or a non-array', () => {
    assert.equal(trailing24hSum([1, 2], 9), null);
    assert.equal(trailing24hSum(null, 0), null);
  });

  it('freshSnow24h uses the trailing window, not the calendar-day sum', () => {
    const p = makePayload({
      hourly: { snowfall: (d, h) => (d === 0 && h >= 12 ? 2 : 0) },
      daily: { snowfall_sum: (d) => (d === 0 ? 999 : 0) }, // deliberately inconsistent
    });
    // Day 0 ends at index 23 → trailing 24 h covers indices 0..23 → 12 h × 2 cm.
    assert.equal(freshSnow24h(p, 0), 24);
    assert.equal(dayEndIndex(p, 0), 23);
  });

  it('uses "now" as the end of the window for today', () => {
    const p = makePayload({ hourly: { snowfall: () => 1 } });
    // pretend "now" is index 5 → trailing window = indices 0..5
    const idx = p.hourly.time.findIndex((t) => t.endsWith('T05:00'));
    assert.equal(freshSnow24h(p, 0, idx), 6);
  });
});

describe('grid metadata', () => {
  it('reads the model cell coordinates and elevation', () => {
    const g = gridInfo({ latitude: 36.055244, longitude: 51.38567, elevation: 2896 });
    assert.equal(g.lat, 36.055244);
    assert.equal(g.elevation, 2896);
  });

  it('is null-safe', () => {
    const g = gridInfo(null);
    assert.equal(g.lat, null);
    assert.equal(gridCellKey(g), null);
  });

  it('builds a stable cell key (same cell → same key)', () => {
    const a = gridCellKey({ lat: 36.055244, lon: 51.38567 });
    const b = gridCellKey({ lat: 36.055244, lon: 51.38567 });
    const c = gridCellKey({ lat: 36.0724, lon: 51.4892 });
    assert.equal(a, b);
    assert.notEqual(a, c);
  });

  it('measures short distances', () => {
    const d = haversineKm(36.0, 51.4, 36.0, 51.41);
    assert.ok(d > 0.8 && d < 1.1, `d=${d}`);
    assert.equal(haversineKm(null, 1, 2, 3), null);
  });
});

describe('day/hour alignment', () => {
  it('groups hourly rows per calendar day', () => {
    const p = makePayload({ days: 3 });
    const idx = buildDayIndex(p.hourly.time);
    assert.equal(idx.size, 3);
    for (const range of idx.values()) {
      assert.equal(range.end - range.start + 1, 24);
    }
  });

  it('finds "now" only when the timestamp exists', () => {
    const p = makePayload({ days: 1, startDate: '2026-01-10' });
    const i = findNowIndex(p.hourly.time, new Date('2026-01-10T05:30:00Z'));
    assert.ok(i === null || Number.isInteger(i));
    assert.equal(findNowIndex(null), null);
  });
});
