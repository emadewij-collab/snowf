/**
 * SnowF — Cache layer.
 *
 * Two tiers:
 *  1. In-memory Map (fast, per session).
 *  2. localStorage (survives reload / offline → served as STALE, always flagged).
 *
 * Never serves stale data silently: entries past TTL are marked stale and the
 * UI must show "آخرین داده ذخیره‌شده" + timestamp.
 *
 * Import-safe in Node (guards around localStorage).
 */

import { CACHE_TTL_MS, STALE_OK_MS } from './config.js';

const mem = new Map();
const LS_PREFIX = 'snowf_v3_';

function lsGet(key) {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(LS_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function lsSet(key, value) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage full / private mode — memory cache still works */
  }
}

/**
 * @returns {{ hit: boolean, data: any, updatedAt: number, stale: boolean }}
 */
export function cacheGet(key) {
  const now = Date.now();
  const m = mem.get(key);
  if (m && now - m.updatedAt < CACHE_TTL_MS) {
    return { hit: true, data: m.data, updatedAt: m.updatedAt, stale: false };
  }
  const persisted = lsGet(key);
  if (persisted && persisted.data) {
    const age = now - persisted.updatedAt;
    if (age < CACHE_TTL_MS) {
      mem.set(key, persisted);
      return { hit: true, data: persisted.data, updatedAt: persisted.updatedAt, stale: false };
    }
    if (age < STALE_OK_MS) {
      return { hit: true, data: persisted.data, updatedAt: persisted.updatedAt, stale: true };
    }
  }
  // Expired memory entry: still usable as last-resort stale (flagged).
  if (m) return { hit: true, data: m.data, updatedAt: m.updatedAt, stale: true };
  return { hit: false, data: null, updatedAt: 0, stale: false };
}

export function cacheSet(key, data, updatedAt = Date.now()) {
  const entry = { data, updatedAt };
  mem.set(key, entry);
  lsSet(key, entry);
}

export function cacheClear() {
  mem.clear();
  try {
    if (typeof localStorage === 'undefined') return;
    Object.keys(localStorage)
      .filter((k) => k.startsWith(LS_PREFIX))
      .forEach((k) => localStorage.removeItem(k));
  } catch { /* ignore */ }
}

// --- Tiny typed store for UI preferences (favorites, theme, profile, ...) ---
export function storeGet(key, fallback = null) {
  try {
    if (typeof localStorage === 'undefined') return fallback;
    const raw = localStorage.getItem(LS_PREFIX + 'pref_' + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function storeSet(key, value) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(LS_PREFIX + 'pref_' + key, JSON.stringify(value));
  } catch { /* ignore */ }
}
