import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cacheGet, cacheSet, cacheClear, storeGet, storeSet } from '../js/cache.js';
import { CACHE_TTL_MS, STALE_OK_MS } from '../js/config.js';

// Minimal localStorage stub so the module's browser path is exercised.
class MemStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  *[Symbol.iterator]() { yield* this.map.keys(); }
}
globalThis.localStorage = new MemStorage();

describe('cache tiers', () => {
  it('serves a fresh entry without a network call', () => {
    cacheClear();
    cacheSet('k1', { a: 1 }, Date.now());
    const c = cacheGet('k1');
    assert.equal(c.hit, true);
    assert.equal(c.stale, false);
    assert.deepEqual(c.data, { a: 1 });
  });

  it('marks an entry as stale between TTL and the stale window', () => {
    cacheClear();
    const old = Date.now() - (CACHE_TTL_MS + 60_000);
    cacheSet('k2', { a: 2 }, old);
    const c = cacheGet('k2');
    assert.equal(c.hit, true);
    assert.equal(c.stale, true, 'must be flagged, never served silently');
  });

  it('discards an entry older than the stale window', () => {
    cacheClear();
    const old = Date.now() - (STALE_OK_MS + 60_000);
    cacheSet('k3', { a: 3 }, old);
    const c = cacheGet('k3');
    assert.equal(c.hit, false);
    assert.equal(c.data, null);
  });

  it('applies the SAME age policy to the memory tier as to localStorage', () => {
    cacheClear();
    const old = Date.now() - (STALE_OK_MS + 60_000);
    cacheSet('k4', { a: 4 }, old);
    const c = cacheGet('k4');
    assert.equal(c.hit, false, 'an expired memory entry must not outlive the stale window');
  });

  it('reports a miss for an unknown key', () => {
    cacheClear();
    const c = cacheGet('never-written');
    assert.equal(c.hit, false);
    assert.equal(c.updatedAt, 0);
  });

  it('cacheClear removes every entry', () => {
    cacheSet('k5', { a: 5 }, Date.now());
    cacheClear();
    assert.equal(cacheGet('k5').hit, false);
  });
});

describe('preference store', () => {
  it('round-trips values', () => {
    storeSet('theme', 'theme-night');
    assert.equal(storeGet('theme'), 'theme-night');
  });

  it('falls back when the key is missing', () => {
    assert.equal(storeGet('nope', 'default'), 'default');
  });
});
