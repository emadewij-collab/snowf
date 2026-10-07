import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateSafetyScore, calculateMountainRisk } from '../js/safety.js';

const CALM = {
  gustKmh: 20, sustainedKmh: 12, visKm: 12, snowRateMax: 0.1,
  rainOnSnow: { active: false }, freezingRain: { likely: false },
  warming24h: 1, feelsMinC: -8, capeMax: 0, liMin: 2, deteriorating: false,
};
const LOW_RISK = { band: 'low', label: 'کم' };

describe('calculateSafetyScore', () => {
  it('calm day → high safety', () => {
    const r = calculateSafetyScore(CALM, LOW_RISK);
    assert.ok(r.score >= 90, `got ${r.score}`);
    assert.equal(r.hardStops.length, 0);
  });

  it('scenario 7: extreme gust → hard stop', () => {
    const r = calculateSafetyScore({ ...CALM, gustKmh: 95 }, LOW_RISK);
    assert.ok(r.hardStops.length > 0);
    assert.ok(r.score < 50, `got ${r.score}`);
  });

  it('scenario 6: critical visibility → hard stop', () => {
    const r = calculateSafetyScore({ ...CALM, visKm: 0.3 }, LOW_RISK);
    assert.ok(r.hardStops.some((h) => h.id === 'visibility'));
  });

  it('scenario 3: rain on snow penalizes + flags', () => {
    const r = calculateSafetyScore({ ...CALM, rainOnSnow: { active: true, severe: true } }, LOW_RISK);
    assert.ok(r.score <= 85, `got ${r.score}`);
    assert.ok(r.flags.some((f) => f.id === 'rain-on-snow'));
  });

  it('strong freezing rain → hard stop', () => {
    const r = calculateSafetyScore({ ...CALM, freezingRain: { likely: true, strong: true } }, LOW_RISK);
    assert.ok(r.hardStops.some((h) => h.id === 'freezing-rain'));
  });

  it('mountain risk applies a CAP, not a subtraction (no double count)', () => {
    const high = { band: 'high', label: 'خیلی بالا' };
    const r = calculateSafetyScore(CALM, high);
    assert.equal(r.score, 35);
    assert.ok(r.capApplied);
  });

  it('extreme cold penalizes', () => {
    const r = calculateSafetyScore({ ...CALM, feelsMinC: -30 }, LOW_RISK);
    assert.ok(r.score <= 70, `got ${r.score}`);
  });

  it('CAPE alone never hard-stops (no fake closure)', () => {
    const r = calculateSafetyScore({ ...CALM, capeMax: 2000, liMin: -6 }, LOW_RISK);
    assert.equal(r.hardStops.length, 0);
    assert.ok(r.score < 100 && r.score > 40, `got ${r.score}`);
  });

  it('missing wind data caps safety at 85 (cannot claim verified safety)', () => {
    const r = calculateSafetyScore({ ...CALM, gustKmh: null, sustainedKmh: null }, LOW_RISK);
    assert.equal(r.score, 85);
    assert.equal(r.capApplied.band, 'missing-wind');
  });
  it('missing visibility caps safety at 90', () => {
    const r = calculateSafetyScore({ ...CALM, visKm: null }, LOW_RISK);
    assert.equal(r.score, 90);
    assert.equal(r.capApplied.band, 'missing-visibility');
  });
});

describe('calculateMountainRisk', () => {
  it('calm + no snow → low', () => {
    const r = calculateMountainRisk({ fresh24hCm: 0, snowRateMax: 0, gustKmh: 15, visKm: 10 });
    assert.equal(r.band, 'low');
    assert.equal(r.estimated, true);
    assert.ok(r.disclaimer.length > 20);
  });

  it('scenario 2: heavy snow + strong wind → elevated/high + wind loading', () => {
    const r = calculateMountainRisk({ fresh24hCm: 45, snowRateMax: 2.5, gustKmh: 70, visKm: 5 });
    assert.ok(['elevated', 'high'].includes(r.band), `got ${r.band}`);
    assert.equal(r.windLoading, true);
  });

  it('bands are 4-level, never EAWS 1-5', () => {
    for (const ctx of [
      { fresh24hCm: 0 }, { fresh24hCm: 15 }, { fresh24hCm: 30, gustKmh: 60 }, { fresh24hCm: 60, gustKmh: 80 },
    ]) {
      const r = calculateMountainRisk(ctx);
      assert.ok(['low', 'moderate', 'elevated', 'high'].includes(r.band));
    }
  });
});
