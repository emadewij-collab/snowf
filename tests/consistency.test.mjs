import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { formatClock, renderTechnicalDetails, renderResortDetail } from '../js/ui.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const readJson = (p) => JSON.parse(read(p));

describe('live clock formatting', () => {
  const TZ = 'Asia/Tehran';

  it('keeps the date and the time as two separate values', () => {
    const c = formatClock(new Date('2026-10-21T13:08:07+03:30'), TZ);
    assert.ok(c.date.length > 0);
    assert.ok(c.time.length > 0);
    assert.ok(!c.date.includes(':'), 'the date must not contain the time');
    assert.ok(!c.time.includes('مهر'), 'the time must not contain the date');
  });

  it('uses the natural Persian order: weekday, day, month, year', () => {
    const c = formatClock(new Date('2026-10-21T13:08:07+03:30'), TZ);
    assert.equal(c.date, 'چهارشنبه ۲۹ مهر ۱۴۰۵');
  });

  it('formats the time as HH:MM:SS with Persian digits', () => {
    const c = formatClock(new Date('2026-10-21T13:08:07+03:30'), TZ);
    assert.equal(c.time, '۱۳:۰۸:۰۷');
  });

  it('renders midnight as 00, never 24', () => {
    const c = formatClock(new Date('2026-10-21T00:00:00+03:30'), TZ);
    assert.ok(!c.time.startsWith('۲۴'), `time=${c.time}`);
    assert.ok(c.time.startsWith('۰۰'), `time=${c.time}`);
  });

  it('never emits the literal "ساعت" that welded the two together', () => {
    for (const iso of ['2026-01-05T09:30:00+03:30', '2026-07-21T23:59:59+03:30', '2026-10-21T00:00:00+03:30']) {
      const c = formatClock(new Date(iso), TZ);
      assert.ok(!c.date.includes('ساعت'));
      assert.ok(!c.time.includes('ساعت'));
    }
  });

  it('index.html uses two separate clock elements', () => {
    const html = read('index.html');
    assert.ok(html.includes('id="live-date"'));
    assert.ok(html.includes('id="live-time"'));
    assert.ok(!html.includes('id="live-clock"'), 'the old combined element must be gone');
  });
});

describe('technical layer is collapsed, not always visible', () => {
  const tech = {
    source: 'Open-Meteo',
    model: 'best_match',
    gridKm: 11,
    sharedCell: true,
    stations: [{ nameFa: 'قله', alt: 3600, demAlt: 3527, delta: -0.474 }],
    minSafety: 42,
    minSafetyZone: 'قله',
    dataQuality: { level: 'good' },
    missingCount: 0,
    updatedAt: Date.now(),
  };

  it('renders a collapsed <details> block', () => {
    const html = renderTechnicalDetails(tech, { label: '۲۹ مهر' });
    assert.ok(html.includes('<details'), 'must be a disclosure element');
    assert.ok(html.includes('</details>'));
    assert.ok(!/<details[^>]*\sopen/.test(html), 'must not be open by default');
  });

  it('carries the provenance data', () => {
    const html = renderTechnicalDetails(tech, { label: '۲۹ مهر' });
    assert.ok(html.includes('Open-Meteo'));
    assert.ok(html.includes('best_match'));
    assert.ok(html.includes('۳۵۲۷'), 'DEM altitude of the station');
    assert.ok(html.includes('۳۶۰۰'), 'official station altitude');
    assert.ok(html.includes('۲۹ مهر'), 'the day it refers to');
  });

  it('never leaks English technical strings into the Persian UI', () => {
    const html = renderTechnicalDetails(tech, { label: '۲۹ مهر' });
    assert.ok(!/temp adjusted|DEM \d|station \d|grid cell/i.test(html));
  });

  it('hides the safety floor when it does not actually constrain', () => {
    assert.ok(renderTechnicalDetails({ ...tech, minSafety: 100 }).includes('کف ایمنی') === false);
    assert.ok(renderTechnicalDetails({ ...tech, minSafety: 42 }).includes('کف ایمنی'));
  });

  it('keeps the technical details out of the always-visible part of the resort card', () => {
    const station = {
      nameFa: 'قله', shortFa: 'قله', zone: 'summit', alt: 3600,
      failed: false, temp: 5, tempMin: 1, tempMax: 9, feelsLike: 2,
      wind: 12, gust: 20, windDir: 'شمال', visKm: 41, cloud: 40, humidity: 50,
      fresh24hCm: 0, depthCm: 0, depthKnown: true, precipMm: 0, probMax: 10,
      snowRateMax: 0, cape: 0, li: 2, uv: 3, sunrise: '06:45', sunset: '18:10',
      ski: { score: 14, factors: [] }, safety: { score: 100, factors: [], hardStops: [], flags: [] },
      snow: { score: 44, label: 'خیس', factors: [] }, risk: { band: 'low', label: 'کم', icon: '🟢', drivers: [] },
      refreeze: { likely: false }, rainOnSnow: { active: false }, freezingRain: { likely: false },
      windLoading: false, freezingReading: { text: null, cold: null },
      lens: { fa: 'شفاف', vlt: '80-95%', when: 'شب' }, lift: 'وضعیت نامشخص',
      heightCorrection: { applied: true, delta: -0.474, demAlt: 3527, targetAlt: 3600 },
      grid: { lat: 36.07, lon: 51.49, elevation: 3527 },
    };
    const html = renderResortDetail({
      resort: { nameFa: 'دیزین', fullNameFa: 'پیست دیزین' },
      analysis: { ski: 14, safety: 100, snowScore: 44, fresh24hCm: 0, locations: [station] },
      verdict: { verdict: 'avoid', icon: '🔴', label: 'نامناسب برای اسکی', reasons: ['x'] },
      verdictsByLoc: [{ verdict: 'avoid', icon: '🔴', label: 'نامناسب برای اسکی', reasons: ['x'] }],
      bestWindow: { available: false, reason: '—' },
      bestElev: { available: true, nameFa: 'قله', reasons: ['x'], ranking: [], sharedCell: true },
      why: { pros: [], cons: [], notes: [] },
      confidence: { label: 'بالا', pct: 80, notes: [] },
      trend: { label: '—', detail: null },
      snowOpp: { score: 17, label: 'کم' },
      timeline: [],
      stale: false,
      updatedAt: Date.now(),
      lateDay: false,
      technical: tech,
      technicalLabel: '۲۹ مهر',
      dateLabel: 'امروز',
    });
    // the grid limitation and the height correction must live inside the
    // collapsed block, never in the visible part
    const visible = html.split('<details')[0];
    assert.ok(!visible.includes('سلول شبکه'), 'grid jargon must not be in the visible part');
    assert.ok(!visible.includes('۳۵۲۷'), 'DEM altitude must not be in the visible part');
    assert.ok(html.includes('جزئیات فنی محاسبه'), 'the technical layer must exist');
  });
});

describe('release consistency', () => {
  it('package.json version matches APP.version in js/config.js', () => {
    const pkg = readJson('package.json').version;
    const cfg = read('js/config.js').match(/version:\s*'([^']+)'/)[1];
    assert.equal(pkg, cfg, `package.json=${pkg} but config.js=${cfg}`);
  });

  it('index.html does not hardcode the version (it is rendered at runtime)', () => {
    assert.ok(!/SnowF v[\d.]+/.test(read('index.html')), 'footer version must come from APP.version');
    assert.ok(read('index.html').includes('id="app-version"'));
  });

  it('the bundled fallback covers every resort and station of data/resorts.json', () => {
    const json = readJson('data/resorts.json').resorts;
    const fallback = read('js/resorts.js');
    for (const [rid, resort] of Object.entries(json)) {
      // the fallback may or may not quote the key (both are valid JS)
      const keyRe = new RegExp(`'${rid}':|\\b${rid}:`);
      assert.ok(keyRe.test(fallback), `missing fallback resort: ${rid}`);
      for (const loc of resort.locations) {
        assert.ok(fallback.includes(`id: '${loc.id}'`), `missing fallback station: ${loc.id}`);
      }
      for (const loc of resort.locations) {
        const m = fallback.match(new RegExp(`id: '${loc.id}'[^}]*`));
        assert.ok(m, `cannot read fallback entry for ${loc.id}`);
        assert.ok(m[0].includes(`alt: ${loc.alt}`), `alt mismatch for ${loc.id}`);
        assert.ok(m[0].includes(`lat: ${loc.lat}`), `lat mismatch for ${loc.id}`);
        assert.ok(m[0].includes(`lon: ${loc.lon}`), `lon mismatch for ${loc.id}`);
      }
    }
  });

  it('every DEM altitude in data/resorts.json is within 100 m of the station altitude', () => {
    const json = readJson('data/resorts.json').resorts;
    for (const resort of Object.values(json)) {
      for (const loc of resort.locations) {
        const delta = Math.abs(loc.alt - loc.demAlt);
        assert.ok(delta <= 100, `${loc.id}: alt=${loc.alt} demAlt=${loc.demAlt} (Δ${delta} m)`);
      }
    }
  });

  it('the service worker precaches exactly the files that exist', () => {
    const sw = read('service-worker.js');
    const list = sw.match(/const PRECACHE = \[([\s\S]*?)\];/)[1];
    const paths = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    for (const p of paths) {
      if (p === './') continue;
      assert.ok(existsSync(join(ROOT, p)), `precached file is missing: ${p}`);
    }
  });

  it('the service worker serves the HTML shell network-first', () => {
    const sw = read('service-worker.js');
    assert.ok(
      sw.includes("req.mode === 'navigate'"),
      'navigations must be network-first, otherwise the markup is one visit behind'
    );
    assert.ok(
      sw.includes("api.open-meteo.com"),
      'the weather API must never be intercepted by the service worker'
    );
  });

  it('every script referenced by index.html exists', () => {
    const html = read('index.html');
    const refs = [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map((m) => m[1]);
    for (const r of refs) {
      assert.ok(existsSync(join(ROOT, r)), `index.html references a missing file: ${r}`);
    }
  });

  it('the manifest icons exist on disk', () => {
    const manifest = readJson('manifest.json');
    for (const icon of manifest.icons || []) {
      const p = icon.src.replace(/^\.\//, '');
      assert.ok(existsSync(join(ROOT, p)), `manifest icon is missing: ${p}`);
    }
  });

  it('no CDN dependency is unpinned', () => {
    const html = read('index.html');
    const cdn = [...html.matchAll(/https:\/\/[^"'\s]+\.js[^"'\s]*/g)].map((m) => m[0]);
    for (const url of cdn) {
      assert.ok(!/@latest/.test(url), `unpinned CDN dependency: ${url}`);
    }
  });
});
