'use strict';
/**
 * publicTrack/rateLimit.js — per-IP sliding window for the public landing endpoints
 * (the same shape as the Mini App's `_rate_ok` buckets: an in-memory list of hit times per key,
 * the map pruned above 5000 keys). The clock is injectable for the tests.
 */

function createRateLimiter({ limit, windowS, now = () => Date.now() / 1000, maxKeys = 5000 }) {
  const hits = new Map();
  return {
    /** → { ok: true } | { ok: false, retryS } */
    hit(key) {
      const t = now();
      const k = String(key);
      const list = (hits.get(k) || []).filter((x) => t - x < windowS);
      if (list.length >= limit) {
        hits.set(k, list);
        return { ok: false, retryS: Math.max(1, Math.ceil(windowS - (t - list[0]))) };
      }
      list.push(t);
      hits.set(k, list);
      if (hits.size > maxKeys) {
        for (const [kk, v] of hits) if (!v.length || t - v[v.length - 1] >= windowS) hits.delete(kk);
      }
      return { ok: true };
    },
    reset() { hits.clear(); },
    get size() { return hits.size; },
  };
}

module.exports = { createRateLimiter };
