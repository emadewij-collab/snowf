import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

describe('multi-location API client', () => {
  const api = read('js/api.js');

  it('fetches every station with chunked, parallel requests', () => {
    assert.ok(api.includes('export async function getForecasts'), 'the multi-location entry point must exist');
    assert.ok(
      api.includes("latitude: points.map((p) => String(p.lat)).join(',')"),
      'the coordinates must be sent as a comma-separated list'
    );
    assert.ok(
      api.includes('const chunks = []'),
      'the request must be split into chunks'
    );
    assert.ok(
      api.includes('await Promise.all('),
      'all chunks must be fired concurrently'
    );
    assert.ok(
      /const size = Math\.max\(1, API\.locationsPerRequest\)/.test(api),
      'the chunk size must come from the config'
    );
    assert.ok(!/export function getForecast\(/.test(api), 'the single-point variant should be gone');
  });

  it('never asks for every location in one request', () => {
    const cfg = read('js/config.js');
    const m = cfg.match(/locationsPerRequest:\s*(\d+)/);
    assert.ok(m, 'API.locationsPerRequest must be defined');
    const size = Number(m[1]);
    assert.ok(size >= 1 && size <= 3, `chunk size ${size} is outside the measured sweet spot (1-3)`);
  });

  it('splits the response array back per location, in request order', () => {
    assert.ok(api.includes('idxs.forEach((idx, n) =>'), 'the response must be split by request order');
    assert.ok(api.includes('const data = payload && payload[n]'));
  });

  it('caches each location individually so a partial cache hit refetches only the rest', () => {
    assert.ok(api.includes('cacheSet(key(points[idx].lat, points[idx].lon, kind), data, updatedAt)'));
    assert.ok(api.includes('const missing = []'), 'the cache lookup must collect the misses');
  });

  it('the app issues one batched call for the stations and one for the roads', () => {
    const app = read('js/app.js');
    assert.ok(app.includes('getForecasts(subset, {'), 'stations must be fetched in one batched call');
    assert.ok(app.includes('getRoadForecasts('), 'roads must be fetched in one batched call');
    assert.ok(!/getForecast\(/.test(app), 'no per-station requests may remain');
    assert.ok(!/getRoadForecast\(/.test(app), 'no per-road requests may remain');
  });

  it('falls back to single-location requests when a chunk fails', () => {
    assert.ok(
      api.includes('if (!payload) {'),
      'a failed chunk must be retried location by location'
    );
    assert.ok(api.includes('idxs.map((i) => fetchChunk([i]))'), 'the fallback must request single locations');
  });

  it('gives the shared API a generous timeout (its latency swings wildly)', () => {
    const cfg = read('js/config.js');
    const m = cfg.match(/timeoutMs:\s*(\d+)/);
    assert.ok(m, 'API.timeoutMs must be defined');
    assert.ok(Number(m[1]) >= 20000, 'a 15s timeout aborted requests the server still would have answered');
  });

  it('paints each chunk as it lands instead of waiting for the slowest', () => {
    const api = read('js/api.js');
    const app = read('js/app.js');
    assert.ok(api.includes('onChunk'), 'the client must report chunk arrivals');
    assert.ok(app.includes('onChunk: (idxs) =>'), 'the app must react to chunk arrivals');
    assert.ok(app.includes('scheduleRender()'), 'a chunk arrival must trigger a repaint');
  });

  it('no longer uses requestAnimationFrame for the progressive render', () => {
    const app = read('js/app.js');
    assert.ok(
      !/requestAnimationFrame\(/.test(app),
      'rAF is paused in background tabs, which made the page look frozen'
    );
    assert.ok(/setTimeout\(/.test(app), 'the repaint must be scheduled with setTimeout');
  });
});
