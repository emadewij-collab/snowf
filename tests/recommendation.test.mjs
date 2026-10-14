import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decide, hourlySkiScore, findBestWindow, bestElevation,
  explainWhy, confidenceFor, trendFromHourly,
} from '../js/recommendation.js';

describe('decide (SAFETY OVERRIDE)', () => {
  it('scenario 10: all good → GO', () => {
    const d = decide({ ski: 86, safety: 88, depthCm: 60, hardStops: [], riskBand: 'low' });
    assert.equal(d.verdict, 'go');
  });

  it('THE OVERRIDE: ski 95 + safety 25 → AVOID (never GO)', () => {
    const d = decide({ ski: 95, safety: 25, depthCm: 80, hardStops: [], riskBand: 'high' });
    assert.equal(d.verdict, 'avoid');
    assert.equal(d.safetyGate, true);
  });

  it('safety in caution zone caps verdict at CAUTION even with great snow', () => {
    const d = decide({ ski: 92, safety: 55, depthCm: 70, hardStops: [], riskBand: 'moderate' });
    assert.equal(d.verdict, 'caution');
  });

  it('hard stop → AVOID with reasons', () => {
    const d = decide({ ski: 90, safety: 80, depthCm: 60, hardStops: [{ id: 'gust', label: 'گاست توفنده' }] });
    assert.equal(d.verdict, 'avoid');
    assert.ok(d.reasons.length > 0);
  });

  it('no snow → AVOID', () => {
    const d = decide({ ski: 60, safety: 90, depthCm: 3, hardStops: [] });
    assert.equal(d.verdict, 'avoid');
  });
});

describe('hourlySkiScore + findBestWindow', () => {
  const calmHour = (hour) => ({ hour, temp: -5, appTemp: -7, wind: 10, gust: 15, visKm: 12, cloud: 20, snowfall: 0, rain: 0, isDay: 1 });
  const stormHour = (hour) => ({ hour, temp: -3, appTemp: -9, wind: 45, gust: 70, visKm: 1.5, cloud: 95, snowfall: 1.2, rain: 0, isDay: 1 });

  it('calm morning beats stormy afternoon', () => {
    const a = hourlySkiScore(calmHour(9), 50);
    const b = hourlySkiScore(stormHour(14), 50);
    assert.ok(a.score > b.score + 20, `${a.score} vs ${b.score}`);
  });

  it('findBestWindow picks the morning block when afternoon deteriorates', () => {
    const hours = [];
    for (let h = 0; h < 24; h++) hours.push(h < 12 ? calmHour(h) : stormHour(h));
    const w = findBestWindow(hours, null, 50);
    assert.equal(w.available, true);
    assert.ok(w.start <= 9, `start=${w.start}`);
    assert.ok(w.end <= 13, `end=${w.end}`);
    assert.ok(w.why.length > 0);
  });

  it('past hours are skipped for today; late day → unavailable', () => {
    const hours = [];
    for (let h = 0; h < 24; h++) hours.push(calmHour(h));
    const w = findBestWindow(hours, 18, 50);
    assert.equal(w.available, false);
  });
});

describe('bestElevation', () => {
  const loc = (zone, ski, safety, wind = 15, visKm = 10) => ({
    zone, shortFa: zone, nameFa: zone, ski: { score: ski }, safety: { score: safety, hardStops: [] },
    snow: { score: ski, label: 'x' }, risk: { band: 'low' }, wind, visKm, depthCm: 40,
  });
  it('picks the best station with a reason', () => {
    const r = bestElevation([loc('summit', 60, 60, 45, 3), loc('mid', 80, 80, 12, 12), loc('low', 70, 75, 10, 9)]);
    assert.equal(r.available, true);
    assert.equal(r.zone, 'mid');
    assert.ok(r.reasons.length > 0);
    assert.equal(r.ranking.length, 3);
  });
  it('an avoid-level station cannot win', () => {
    const bad = loc('summit', 95, 95);
    bad.safety.hardStops = [{ id: 'gust', label: 'x' }];
    const r = bestElevation([bad, loc('mid', 50, 70)]);
    assert.equal(r.zone, 'mid');
  });
});

describe('explainWhy', () => {
  it('returns pros/cons/notes from factors', () => {
    const w = explainWhy({
      ski: { factors: [{ key: 'a', label: 'برف تازه', points: 10 }, { key: 'b', label: 'باد', points: -16 }] },
      safety: { factors: [], hardStops: [] },
      snow: { label: 'پودر', score: 80 },
      risk: { icon: '🟢', label: 'کم' },
    });
    assert.ok(w.pros.length >= 1 && w.cons.length >= 1 && w.notes.length >= 2);
  });
});

describe('confidenceFor', () => {
  it('decays with horizon', () => {
    const near = confidenceFor({ dayIndex: 0 });
    const mid = confidenceFor({ dayIndex: 4 });
    const far = confidenceFor({ dayIndex: 12 });
    assert.ok(near.pct > mid.pct && mid.pct > far.pct, `${near.pct}/${mid.pct}/${far.pct}`);
  });
  it('missing data + staleness lower confidence', () => {
    const a = confidenceFor({ dayIndex: 1 });
    const b = confidenceFor({ dayIndex: 1, missingVars: 3, stale: true });
    assert.ok(b.pct < a.pct);
    assert.ok(b.notes.length >= 2);
  });
});

describe('trendFromHourly', () => {
  it('detects deterioration and improvement', () => {
    const rows = [];
    for (let h = 7; h <= 16; h++) rows.push({ hour: h, score: 80 - (h - 7) * 3 });
    assert.equal(trendFromHourly(rows, 7).dir, 'deteriorating');
    const rows2 = [];
    for (let h = 7; h <= 16; h++) rows2.push({ hour: h, score: 40 + (h - 7) * 3 });
    assert.equal(trendFromHourly(rows2, 7).dir, 'improving');
  });
});
