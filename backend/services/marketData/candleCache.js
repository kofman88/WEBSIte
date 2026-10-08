'use strict';
/**
 * candleCache.js — the bot's in-memory candle cache (`cache.py`): an ordered TTL
 * cache with LRU eviction (`get` moves hits to the end, `set` evicts the oldest
 * entry when full and the key is new), hit/miss/eviction counters, cap
 * `Config.CACHE_MAX_KEYS = 4000`, and the coins-list cache (TTL 6 h).
 *
 * Keys are `"<symbol>_<tf>"`. PORT_DECISIONS D6: the bot wrote `BTC-USDT-SWAP_1H`
 * from the WS feed and read `BTC-USDT-SWAP_1h` from LEVELS (so LEVELS on 1h/4h/1d
 * never hit WS data — spec data-and-market §7.6, quirk #1). The site normalises
 * the timeframe in the key (`1h`→`1H`, `4h`→`4H`, `1d`→`1D`, ws_feed._TF_NORM), so
 * every reader and writer of the same symbol/timeframe shares one entry. The TTL
 * lookup still uses the caller's raw tf (the TTL maps carry both spellings).
 */

const { TF_NORM } = require('./candleFrame');
const { log: defaultLog } = require('./mdLog');

const COINS_TTL_S = 6 * 3600;
const DEFAULT_MAX_KEYS = 4000; // Config.CACHE_MAX_KEYS

class TTLCache {
  constructor(maxSize = 300, { now = () => Date.now() / 1000 } = {}) {
    this._data = new Map(); // key -> { value, expiresAt }   (insertion order = LRU order)
    this._maxSize = maxSize;
    this._now = now;
    this._hits = 0;
    this._misses = 0;
    this._evictions = 0;
  }

  get(key) {
    const entry = this._data.get(key);
    if (entry === undefined) {
      this._misses += 1;
      return null;
    }
    if (this._now() > entry.expiresAt) {
      this._data.delete(key);
      this._misses += 1;
      return null;
    }
    // LRU — move to the end
    this._data.delete(key);
    this._data.set(key, entry);
    this._hits += 1;
    return entry.value;
  }

  set(key, value, ttlS) {
    if (this._data.size >= this._maxSize && !this._data.has(key)) {
      const oldest = this._data.keys().next().value;
      this._data.delete(oldest);
      this._evictions += 1;
    }
    // Re-setting an existing key keeps its position (OrderedDict assignment semantics;
    // JS Map.set on a present key also keeps insertion order).
    this._data.set(key, { value, expiresAt: this._now() + ttlS });
  }

  delete(key) { this._data.delete(key); }
  clear() { this._data.clear(); }
  size() { return this._data.size; }
  keys() { return Array.from(this._data.keys()); }
  has(key) { return this._data.has(key); }

  stats() {
    const total = this._hits + this._misses;
    const ratio = total ? (this._hits / total) * 100 : 0;
    return {
      size: this.size(),
      max_size: this._maxSize,
      hits: this._hits,
      misses: this._misses,
      evictions: this._evictions,
      ratio: Math.round(ratio * 10) / 10,
    };
  }
}

// ── module-level candle cache (the bot's `cache` module) ────────────────────

let _candleCache = null;
let _coinsCache = null; // { coins, expiresAt }
let _now = () => Date.now() / 1000;
let _log = defaultLog;

function initCache(maxKeys = 150, { now, log } = {}) {
  if (now) _now = now;
  if (log) _log = log;
  _candleCache = new TTLCache(maxKeys, { now: () => _now() });
  _log.info(`✅ In-memory кэш инициализирован (max ${maxKeys} keys)`);
  return _candleCache;
}

/** D6: normalised key — `BTC-USDT-SWAP_1H` for tf '1h' and '1H' alike. */
function normTfKey(tf) { return TF_NORM[tf] ?? tf; }
function candleKey(symbol, tf) { return `${symbol}_${normTfKey(tf)}`; }

function getCandles(symbol, tf) {
  if (_candleCache === null) {
    _log.warning('cache.getCandles: кэш не инициализирован — вызовите initCache()');
    return null;
  }
  return _candleCache.get(candleKey(symbol, tf));
}

/** `ttlMap.get(tf, 3600)` — the raw tf first, then the normalised spelling. */
function setCandles(symbol, tf, frame, ttlMap) {
  if (_candleCache === null) {
    _log.warning('cache.setCandles: кэш не инициализирован — вызовите initCache()');
    return;
  }
  const m = ttlMap || {};
  const ttl = m[tf] ?? m[normTfKey(tf)] ?? 3600;
  _candleCache.set(candleKey(symbol, tf), frame, ttl);
}

function deleteCandles(symbol, tf) {
  if (_candleCache) _candleCache.delete(candleKey(symbol, tf));
}

function getCoins() {
  if (_coinsCache && _now() < _coinsCache.expiresAt) return _coinsCache.coins;
  return null;
}

function setCoins(coins) {
  _coinsCache = { coins, expiresAt: _now() + COINS_TTL_S };
}

function cacheStats() { return _candleCache ? _candleCache.stats() : {}; }
function cacheKeys() { return _candleCache ? _candleCache.keys() : []; }
function getCache() { return _candleCache; }

/** Tests: drop the module state. */
function _resetForTests() {
  _candleCache = null;
  _coinsCache = null;
  _now = () => Date.now() / 1000;
  _log = defaultLog;
}

module.exports = {
  TTLCache, COINS_TTL_S, DEFAULT_MAX_KEYS,
  initCache, candleKey, normTfKey, getCandles, setCandles, deleteCandles,
  getCoins, setCoins, cacheStats, cacheKeys, getCache, _resetForTests,
};
