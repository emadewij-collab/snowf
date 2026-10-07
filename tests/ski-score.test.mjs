import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateSkiQuality } from '../js/ski-score.js';

const GOOD = {
  depthCm: 60, fresh24hCm: 12, surfaceCategory: 'powder',
  sustainedKmh: 10, gustKmh: 18, visKm: 15, feelsLikeC: -5,
  cloudPct: 15, snowRateMax: 0.2, rainMm: 0, freezingRain: false,
  capeMax: 0, liMin: 2,
};

describe('calculateSkiQuality', () => {
  it('scenario 1: cold + calm + fresh snow → high score', () => {
    const r = calculateSkiQuality(GOOD, 'intermediate');
    assert.ok(r.score >= 80, `expected >= 80, got ${r.score}`);
    assert.ok(r.factors.length > 5);
  });

  it('scenario 7: strong wind without snow → heavy penalty, single wind factor', () => {
    const r = calculateSkiQuality({ ...GOOD, sustainedKmh: 55, gustKmh: 80, fresh24hCm: 0, surfaceCategory: 'packed' });
    assert.ok(r.score < 55, `expected < 55, got ${r.score}`);
    const windFactors = r.factors.filter((f) => f.key === 'wind');
    assert.equal(windFactors.length, 1, 'wind must contribute exactly once (no double counting)');
  });

  it('uses effective wind = max(sustained, gust*0.65)', () => {
    const r = calculateSkiQuality({ ...GOOD, sustainedKmh: 10, gustKmh: 60 });
    assert.equal(r.effWind, 39); // 60 * 0.65
  });

  it('thin cover (<8cm) tanks the score', () => {
    const base = calculateSkiQuality(GOOD, 'intermediate');
    const r = calculateSkiQuality({ ...GOOD, depthCm: 4 });
    assert.ok(r.score < base.score - 25, `got ${r.score} vs base ${base.score}`);
  });

  it('scenario 3: rain during ski hours penalizes quality', () => {
    const base = calculateSkiQuality(GOOD, 'intermediate');
    const r = calculateSkiQuality({ ...GOOD, rainMm: 3, surfaceCategory: 'wet' });
    assert.ok(r.score < base.score - 20, `got ${r.score} vs base ${base.score}`);
  });

  it('scenario 6: very low visibility penalizes quality', () => {
    const base = calculateSkiQuality(GOOD, 'intermediate');
    const r = calculateSkiQuality({ ...GOOD, visKm: 0.4 });
    assert.ok(r.score < base.score - 20, `got ${r.score} vs base ${base.score}`);
  });

  it('scenario 8: missing data → no crash, tracked in `missing`', () => {
    const r = calculateSkiQuality({});
    assert.ok(Number.isFinite(r.score));
    assert.ok(r.score >= 0 && r.score <= 100);
    assert.ok(r.missing.includes('visKm'));
    assert.ok(r.missing.includes('depthCm'));
  });

  it('powder profile rewards fresh snow; casual profile is stricter on wind', () => {
    const powder = calculateSkiQuality(GOOD, 'powder');
    const base = calculateSkiQuality(GOOD, 'intermediate');
    assert.ok(powder.score > base.score, `${powder.score} vs ${base.score}`);
    const windy = { ...GOOD, sustainedKmh: 30, gustKmh: 40 };
    const casual = calculateSkiQuality(windy, 'casual');
    const adv = calculateSkiQuality(windy, 'advanced');
    assert.ok(adv.score > casual.score, `${adv.score} vs ${casual.score}`);
  });

  it('score always within 0..100', () => {
    const r = calculateSkiQuality({ depthCm: 200, fresh24hCm: 100, surfaceCategory: 'powder', sustainedKmh: 0, gustKmh: 0, visKm: 50, feelsLikeC: -5, cloudPct: 0 });
    assert.ok(r.score <= 100 && r.score >= 0);
  });
});
