import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rankResorts, rankDays, snowOpportunity, findBestPick } from '../js/comparison.js';

const R = (resortId, ski, safety, extra = {}) => ({
  resortId, nameFa: resortId, ski, safety, depthCm: 50, hardStops: [], risk: { band: 'low' }, ...extra,
});

describe('rankResorts', () => {
  it('verdict-first ordering: safe-good beats dangerous-great', () => {
    const rows = rankResorts([
      R('stormy-powder', 95, 30, { hardStops: [], risk: { band: 'high' } }),
      R('nice-day', 72, 85),
    ]);
    assert.equal(rows[0].resortId, 'nice-day');
    assert.equal(rows[0].medal, '🥇');
    assert.equal(rows[1].verdict.verdict, 'avoid');
  });
  it('skips failed resorts', () => {
    const rows = rankResorts([{ failed: true }, R('a', 60, 70)]);
    assert.equal(rows.length, 1);
  });
});

describe('rankDays', () => {
  it('ranks by verdict then blend, returns top 3', () => {
    const days = [
      { dayIndex: 0, ski: 60, safety: 70, depthCm: 40, risk: { band: 'low' } },
      { dayIndex: 1, ski: 90, safety: 88, depthCm: 60, risk: { band: 'low' } },
      { dayIndex: 2, ski: 95, safety: 20, depthCm: 80, risk: { band: 'high' } },
      { dayIndex: 3, ski: 75, safety: 80, depthCm: 50, risk: { band: 'low' } },
    ];
    const top = rankDays(days, 'intermediate', 3);
    assert.equal(top.length, 3);
    assert.equal(top[0].dayIndex, 1);
    assert.equal(top[1].dayIndex, 3);
    assert.ok(!top.some((d) => d.dayIndex === 2), 'dangerous day must not be top-3');
  });
});

describe('snowOpportunity', () => {
  it('big forecast snow + calm → high', () => {
    const o = snowOpportunity({ freshCm: 18, probPct: 85, tempMaxC: -3, gustKmh: 20, persistCold: true });
    assert.ok(o.score >= 70, `got ${o.score}`);
  });
  it('heavy snow + strong wind → capped (wind-affected)', () => {
    const o = snowOpportunity({ freshCm: 25, probPct: 90, tempMaxC: -4, gustKmh: 70, persistCold: true });
    assert.equal(o.capped, true);
    assert.ok(o.score <= 55, `got ${o.score}`);
  });
  it('no snow → low', () => {
    const o = snowOpportunity({ freshCm: 0, probPct: 10, tempMaxC: 2, gustKmh: 15 });
    assert.ok(o.score < 30, `got ${o.score}`);
  });
});

describe('findBestPick', () => {
  it('picks the single best (resort × day) with 3 reasons', () => {
    const cands = [
      { resortId: 'a', nameFa: 'A', dayIndex: 0, ski: 60, safety: 70, depthCm: 40, risk: { band: 'low' }, fresh: 2, wind: 20, visKm: 6 },
      { resortId: 'b', nameFa: 'B', dayIndex: 2, ski: 88, safety: 86, depthCm: 60, risk: { band: 'low' }, fresh: 14, wind: 14, visKm: 12 },
    ];
    const best = findBestPick(cands);
    assert.equal(best.resortId, 'b');
    assert.equal(best.dayIndex, 2);
    assert.ok(best.reasons.length === 3);
  });
  it('empty → null (no fake pick)', () => {
    assert.equal(findBestPick([]), null);
  });
});
