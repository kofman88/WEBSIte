/**
 * regimeLoop — the live part of the bot's market_regime.py (the cached BTC
 * regime, 4 h TTL, the `regime_history` kv log, regime_allows_direction) and
 * the regime_loop of background_loops.py (every 30 min: BTC 1H × 120 bars by
 * REST → candle cache with TTL 1800 → detect_regime → cache).
 *
 * The pure classifier `detectRegime(frame, {tf})` lives in
 * strategies/common/marketRegime.js (LEVELS port); it is required lazily so
 * this module loads without it (tests inject a fake through `deps.detectRegime`).
 */

'use strict';

const { pyJsonDumps, pyJsonLoads } = require('./pyjson');
const { log: defaultLog } = require('../marketData/mdLog');

const REGIME_INTERVAL = 1800;      // 30 мин — обновляем режим BTC в кэше
const REGIME_START_DELAY_S = 60;
const CACHE_TTL = 4 * 3600;        // market_regime._CACHE_TTL
const HISTORY_KEY = 'regime_history';
const HISTORY_MAX = 30;
const SYMBOL = 'BTC-USDT-SWAP';
const TF = '1H';
const FETCH_LIMIT = 120;
const MIN_BARS = 60;

const nowSec = () => Date.now() / 1000;

/**
 * regime_allows_direction(regime, direction): trending_up → no SHORT,
 * trending_down → no LONG, high_vol / ranging → both.
 */
function regimeAllowsDirection(regime, direction) {
  if (regime === 'trending_up' && direction === 'SHORT') return false;
  if (regime === 'trending_down' && direction === 'LONG') return false;
  return true;
}

function resolveDetectRegime(deps) {
  if (typeof deps.detectRegime === 'function') return deps.detectRegime;
  // eslint-disable-next-line global-require
  const mod = require('../../strategies/common/marketRegime');
  const fn = mod.detectRegime || mod.detect_regime;
  if (typeof fn !== 'function') throw new Error('strategies/common/marketRegime.detectRegime missing');
  return fn;
}

/**
 * createRegimeLoop({ fetcher, cache, kv, detectRegime, now, log })
 *   fetcher — { getCandles(symbol, tf, limit) → Promise<Frame|null> }
 *   cache   — { setCandles(symbol, tf, frame, ttlMap) } (default candleCache)
 *   kv      — { get, set } (default engineKvService)
 */
function createRegimeLoop(deps = {}) {
  const now = deps.now || nowSec;
  const log = deps.log || defaultLog;
  const kvOf = () => (deps.kv !== undefined ? deps.kv : require('../engineKvService'));
  const cacheOf = () => (deps.cache !== undefined ? deps.cache : require('../marketData/candleCache'));
  let cachedRegime = null;
  let cachedAt = 0.0;

  const r = {
    REGIME_INTERVAL, CACHE_TTL, HISTORY_KEY,

    /** get_cached_regime(): null when empty or older than 4 h. */
    getCachedRegime() {
      if (cachedRegime === null) return null;
      if (now() - cachedAt > CACHE_TTL) return null;
      return cachedRegime;
    },

    /** set_cached_regime(regime): store + append to kv regime_history on change. */
    setCachedRegime(regime) {
      const prev = cachedRegime;
      cachedRegime = regime;
      cachedAt = now();
      if (prev !== null && prev !== regime) {
        log.info(`Regime change: ${prev} → ${regime}`);
        r.appendRegimeHistory(prev, regime, cachedAt);
      }
    },

    /** _append_regime_history(prev, new, ts): kv['regime_history'] = last 30 changes. */
    appendRegimeHistory(prev, next, ts) {
      try {
        const kv = kvOf();
        const raw = kv.get(HISTORY_KEY) || '[]';
        let hist = pyJsonLoads(raw, []);
        if (!Array.isArray(hist)) hist = [];
        hist.push({ ts, from: prev, to: next });
        hist = hist.slice(-HISTORY_MAX);
        kv.set(HISTORY_KEY, pyJsonDumps(hist, ['ts']));
      } catch (e) {
        log.debug(`_append_regime_history: ${e && e.message}`);
      }
    },

    getRegimeHistory(limit = 10) {
      try {
        const raw = kvOf().get(HISTORY_KEY) || '[]';
        const hist = pyJsonLoads(raw, []);
        return Array.isArray(hist) ? hist.slice(-limit) : [];
      } catch (_e) {
        return [];
      }
    },

    regimeAllowsDirection,

    /** One regime_loop iteration: fetch → cache (TTL 1800) → detect_regime → cache. Returns the regime or null. */
    async tick() {
      try {
        if (!deps.fetcher) throw new Error('regime_loop: no fetcher');
        const df = await deps.fetcher.getCandles(SYMBOL, TF, FETCH_LIMIT);
        if (df && df.length >= MIN_BARS) {
          cacheOf().setCandles(SYMBOL, TF, df, { [TF]: REGIME_INTERVAL });
          const regime = resolveDetectRegime(deps)(df);   // no tf → baseline slope threshold (quirk kept)
          r.setCachedRegime(regime);
          log.debug(`regime_loop: BTC regime = ${regime} (cached)`);
          return regime;
        }
      } catch (e) {
        log.warning(`regime_loop error: ${e && e.message}`);
      }
      return null;
    },

    _resetForTests() { cachedRegime = null; cachedAt = 0.0; },
  };
  return r;
}

const defaultLoop = createRegimeLoop();

module.exports = {
  REGIME_INTERVAL, REGIME_START_DELAY_S, CACHE_TTL, HISTORY_KEY, HISTORY_MAX, SYMBOL, TF, FETCH_LIMIT, MIN_BARS,
  regimeAllowsDirection, createRegimeLoop, defaultLoop,
  getCachedRegime: () => defaultLoop.getCachedRegime(),
  setCachedRegime: (...a) => defaultLoop.setCachedRegime(...a),
  getRegimeHistory: (...a) => defaultLoop.getRegimeHistory(...a),
};
