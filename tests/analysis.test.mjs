import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLocationDay, analyzeResortDay, analyzeRoad, detectDeterioration } from '../js/analysis.js';
import { assessDataQuality, buildDayHours, tempRise24h } from '../js/weather.js';
import { decide } from '../js/recommendation.js';
import { makePayload, dropVar } from './helpers.mjs';

const META = { alt: 3600, nameFa: 'قله', shortFa: 'قله', zone: 'summit' };

describe('weather normalizer', () => {
  it('builds 24 hour rows for a day; converts snow depth m→cm', () => {
    const p = makePayload();
    const hours = buildDayHours(p, 0);
    assert.equal(hours.length, 24);
    assert.equal(hours[0].snowDepth, 60);
    assert.equal(hours[0].visKm, 20);
  });
  it('tempRise24h compares daily maxima', () => {
    const p = makePayload({ daily: { temperature_2m_max: (d) => [-2, 4, 0][d] } });
    assert.equal(tempRise24h(p, 1), 6);
  });
  it('assessDataQuality flags missing vars, never crashes on null', () => {
    assert.equal(assessDataQuality(makePayload()).level, 'good');
    const bad = dropVar(makePayload(), 'hourly', 'visibility');
    const q = assessDataQuality(bad);
    assert.equal(q.level, 'limited');
    assert.ok(q.missingHourly.includes('visibility'));
    assert.equal(assessDataQuality(null).level, 'poor');
  });
});

describe('analyzeLocationDay (end-to-end scenarios)', () => {
  it('scenario 10: perfect day → high ski + safety', () => {
    // Fixture must be internally consistent: the hourly snowfall (6 h × 1.5 cm)
    // is what "fresh snow in the trailing 24 h" is derived from, and it must
    // add up to the declared daily sum.
    const p = makePayload({
      hourly: { snowfall: (d, h) => (d === 0 && h < 6 ? 1.5 : 0) },
      daily: { snowfall_sum: (d) => (d === 0 ? 9 : 0) },
    });
    const a = analyzeLocationDay(p, 0, META);
    assert.equal(a.failed, false);
    assert.equal(a.fresh24hCm, 9);
    assert.ok(a.ski.score >= 75, `ski=${a.ski.score}`);
    assert.ok(a.safety.score >= 85, `safety=${a.safety.score}`);
    assert.equal(a.snow.category, 'powder');
    const v = decide({ ski: a.ski.score, safety: a.safety.score, depthCm: a.depthCm, hardStops: a.safety.hardStops, riskBand: a.risk.band });
    assert.equal(v.verdict, 'go');
  });

  it('scenario 2: storm (heavy snow + violent wind) → safety collapses, risk high', () => {
    const p = makePayload({
      hourly: {
        snowfall: () => 2.5,
        wind_speed_10m: () => 60,
        wind_gusts_10m: () => 95,
        visibility: () => 800,
        temperature_2m: () => -4,
      },
      daily: { snowfall_sum: () => 45 },
    });
    const a = analyzeLocationDay(p, 0, META);
    assert.ok(a.safety.score < 40, `safety=${a.safety.score}`);
    assert.ok(a.safety.hardStops.length > 0);
    assert.equal(a.risk.band, 'high');
    const v = decide({ ski: a.ski.score, safety: a.safety.score, depthCm: a.depthCm, hardStops: a.safety.hardStops, riskBand: a.risk.band });
    assert.equal(v.verdict, 'avoid');
  });

  it('scenario 3: rain on snow → flags + wet surface', () => {
    const p = makePayload({
      hourly: { rain: (d, h) => (h >= 7 && h <= 16 ? 0.5 : 0), temperature_2m: () => 1.5 },
      daily: { rain_sum: () => 4, temperature_2m_max: () => 3 },
    });
    const a = analyzeLocationDay(p, 0, META);
    assert.equal(a.rainOnSnow.active, true);
    assert.equal(a.snow.category, 'wet');
    assert.ok(a.ski.score < 65, `ski=${a.ski.score}`);
  });

  it('scenario 5: refreeze pattern → refrozen surface estimate', () => {
    // Day 0 thawed (max +4), night froze (-6), morning still below zero,
    // ski window stays near/below freezing → hard refrozen crust likely.
    const p = makePayload({
      hourly: { temperature_2m: (d, h) => (h < 6 ? -6 : h <= 9 ? -2 : 0) },
      daily: { temperature_2m_max: (d) => (d === 0 ? 4 : 0) },
    });
    const b = analyzeLocationDay(p, 1, META);
    assert.equal(b.refreeze.likely, true);
    assert.equal(b.snow.category, 'refrozen');
  });

  it('scenario 6: fog/whiteout → safety hit + caution at best', () => {
    const p = makePayload({ hourly: { visibility: () => 600 } });
    const a = analyzeLocationDay(p, 0, META);
    assert.ok(a.safety.score < 65, `safety=${a.safety.score}`);
    const v = decide({ ski: a.ski.score, safety: a.safety.score, depthCm: a.depthCm, hardStops: a.safety.hardStops, riskBand: a.risk.band });
    assert.notEqual(v.verdict, 'go');
  });

  it('scenario 8: incomplete payload → analysis survives, N/A preserved', () => {
    let p = makePayload();
    p = dropVar(p, 'hourly', 'visibility');
    p = dropVar(p, 'hourly', 'wind_gusts_10m');
    const a = analyzeLocationDay(p, 0, META);
    assert.equal(a.failed, false);
    assert.equal(a.visKm, null);
    assert.ok(Number.isFinite(a.ski.score) && Number.isFinite(a.safety.score));
  });

  it('scenario 9: API failure (null) → failed object, no crash', () => {
    const a = analyzeLocationDay(null, 0, META);
    assert.equal(a.failed, true);
    const resort = analyzeResortDay([a, null, undefined], { resortId: 'x', nameFa: 'X' });
    assert.equal(resort.failed, true);
  });

  it('late day (window already ended) → lateDay flag, numbers still populated', () => {
    const p = makePayload();
    const a = analyzeLocationDay(p, 0, META, { fromHour: 20 });
    assert.equal(a.lateDay, true);
    assert.ok(a.wind !== null, `wind=${a.wind}`);
    assert.ok(a.visKm !== null, `vis=${a.visKm}`);
    assert.ok(Number.isFinite(a.ski.score) && Number.isFinite(a.safety.score));
  });

  it('freezing-level reading compares against station altitude', () => {
    const p = makePayload({ hourly: { freezing_level_height: () => 2400 } });
    const a = analyzeLocationDay(p, 0, META); // station 3600
    assert.equal(a.freezingReading.cold, true);
    assert.equal(a.freezingLevel, 2400);
  });
});

describe('detectDeterioration', () => {
  const hour = (h, score) => ({ hour: h, temp: -5, appTemp: -7, wind: 10, gust: 15, visKm: 12, cloud: 20, snowfall: 0, rain: 0, isDay: 1 });
  it('is false when nothing changes', () => {
    const hours = [];
    for (let h = 0; h < 24; h++) hours.push(hour(h));
    assert.equal(detectDeterioration(hours, 9), false);
  });
  it('is false without a "now" context (future days)', () => {
    const hours = [];
    for (let h = 0; h < 24; h++) hours.push(hour(h));
    assert.equal(detectDeterioration(hours, null), false);
  });
  it('detects a bad evening after a good ski window', () => {
    const hours = [];
    for (let h = 0; h < 24; h++) {
      hours.push(h < 16 ? hour(h) : { ...hour(h), wind: 60, gust: 95, visKm: 0.4 });
    }
    assert.equal(detectDeterioration(hours, 9), true);
  });
  it('feeds the safety engine as a penalty', () => {
    const p = makePayload({
      hourly: {
        wind_speed_10m: (d, h) => (h >= 16 ? 60 : 10),
        wind_gusts_10m: (d, h) => (h >= 16 ? 95 : 15),
        visibility: (d, h) => (h >= 16 ? 400 : 12000),
      },
    });
    const a = analyzeLocationDay(p, 0, META, { fromHour: 9 });
    assert.equal(a.deteriorating, true);
    assert.ok(a.safety.factors.some((f) => f.key === 'deterioration'));
  });
});

describe('analyzeResortDay', () => {
  it('combines 3 stations; partial failure tolerated', () => {
    const p = makePayload();
    const locs = [
      analyzeLocationDay(p, 0, { ...META, zone: 'summit' }),
      analyzeLocationDay(p, 0, { ...META, zone: 'mid' }),
      analyzeLocationDay(null, 0, { ...META, zone: 'low' }),
    ];
    const r = analyzeResortDay(locs, { resortId: 'dizin', nameFa: 'دیزین', dayIndex: 0 });
    assert.equal(r.failed, false);
    assert.equal(r.partial, true);
    assert.ok(Number.isFinite(r.ski) && Number.isFinite(r.safety));
  });

  it('depth for the viability gate comes from the BEST station, not only the summit', () => {
    // Summit is wind-scoured (0 cm) but the mid station still has 60 cm.
    const bare = makePayload({ hourly: { snow_depth: () => 0 } });
    const deep = makePayload({ hourly: { snow_depth: () => 0.6 } });
    const locs = [
      analyzeLocationDay(bare, 0, { ...META, zone: 'summit' }),
      analyzeLocationDay(deep, 0, { ...META, zone: 'mid' }),
    ];
    const r = analyzeResortDay(locs, { resortId: 'dizin', nameFa: 'دیزین', dayIndex: 0 });
    assert.equal(r.depthCm, 60, 'the deepest station decides the snow gate');
  });

  it('exposes the worst station safety as an independent floor', () => {
    const calm = makePayload();
    const stormy = makePayload({ hourly: { wind_gusts_10m: () => 120 } });
    const locs = [
      analyzeLocationDay(calm, 0, { ...META, zone: 'summit' }),
      analyzeLocationDay(stormy, 0, { ...META, zone: 'mid' }),
    ];
    const r = analyzeResortDay(locs, { resortId: 'dizin', nameFa: 'دیزین', dayIndex: 0 });
    assert.ok(r.minSafety <= r.safety, 'minSafety is never above the average');
    assert.ok(r.minSafetyZone);
  });

  it('carries the resort full name for the UI header', () => {
    const p = makePayload();
    const r = analyzeResortDay([analyzeLocationDay(p, 0, META)], { resortId: 'dizin', nameFa: 'دیزین', fullNameFa: 'پیست دیزین', dayIndex: 0 });
    assert.equal(r.fullNameFa, 'پیست دیزین');
  });
});

describe('analyzeRoad', () => {
  it('icy conditions → caution/bad with estimate disclaimer', () => {
    const p = makePayload({ hourly: { temperature_2m: () => -1, relative_humidity_2m: () => 92 }, days: 1 });
    const r = analyzeRoad(p);
    assert.ok(['caution', 'bad'].includes(r.level));
    assert.ok(r.disclaimer.includes('برآورد'));
  });
  it('null → failed, no crash', () => {
    assert.equal(analyzeRoad(null).failed, true);
  });
});
