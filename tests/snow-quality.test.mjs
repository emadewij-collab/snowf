import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { estimateSnowSurface, detectRefreeze, detectRainOnSnow, detectFreezingRain } from '../js/snow-quality.js';

describe('estimateSnowSurface', () => {
  it('fresh + cold + calm → powder', () => {
    const r = estimateSnowSurface({ tempC: -6, rainMm: 0, freshCm: 14, refreeze: false, windMaxKmh: 18 });
    assert.equal(r.category, 'powder');
    assert.equal(r.estimated, true);
    assert.ok(r.score >= 70, `got ${r.score}`);
  });

  it('scenario 3/4: rain or above-freezing → wet', () => {
    const rainy = estimateSnowSurface({ tempC: -1, rainMm: 3, freshCm: 10, windMaxKmh: 15 });
    assert.equal(rainy.category, 'wet');
    const warm = estimateSnowSurface({ tempC: 3, rainMm: 0, freshCm: 10, windMaxKmh: 10 });
    assert.equal(warm.category, 'wet');
    assert.ok(warm.score < 60, `got ${warm.score}`);
  });

  it('refreeze → refrozen category with penalty', () => {
    const r = estimateSnowSurface({ tempC: -4, rainMm: 0, freshCm: 2, refreeze: true, windMaxKmh: 10 });
    assert.equal(r.category, 'refrozen');
  });

  it('strong wind scours the surface', () => {
    const calm = estimateSnowSurface({ tempC: -5, freshCm: 6, windMaxKmh: 15 });
    const windy = estimateSnowSurface({ tempC: -5, freshCm: 6, windMaxKmh: 60 });
    assert.ok(windy.score < calm.score);
  });
});

describe('detectRefreeze', () => {
  it('scenario 5: thaw yesterday + freeze overnight + cold morning → likely', () => {
    const r = detectRefreeze({ prevDayMax: 3, nightMin: -5, morningTemp: -2 });
    assert.equal(r.likely, true);
  });
  it('no thaw → not likely', () => {
    const r = detectRefreeze({ prevDayMax: -4, nightMin: -8, morningTemp: -6 });
    assert.equal(r.likely, false);
  });
  it('missing inputs → not likely (no false alarm)', () => {
    const r = detectRefreeze({});
    assert.equal(r.likely, false);
  });
});

describe('detectRainOnSnow', () => {
  it('rain + deep snow → active', () => {
    const r = detectRainOnSnow({ rainMm: 4, snowDepthCm: 50 });
    assert.equal(r.active, true);
    assert.equal(r.severe, true);
  });
  it('rain without snowpack → inactive', () => {
    const r = detectRainOnSnow({ rainMm: 4, snowDepthCm: 2 });
    assert.equal(r.active, false);
  });
});

describe('detectFreezingRain', () => {
  it('precip near 0°C with moist air → likely (estimate)', () => {
    const r = detectFreezingRain({ precipMm: 1.2, tempC: -0.5, humidity: 95 });
    assert.equal(r.likely, true);
    assert.ok(r.label.includes('برآورد'));
  });
  it('clearly cold snow → not likely', () => {
    const r = detectFreezingRain({ precipMm: 2, tempC: -8, humidity: 90 });
    assert.equal(r.likely, false);
  });
});
