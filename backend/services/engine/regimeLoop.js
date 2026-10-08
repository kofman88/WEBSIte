/**
 * regimeLoop — the live part of the bot's market_regime.py (the cached BTC
 * regime, 4 h TTL, the `regime_history` kv log, regime_allows_direction) and
 * the regime_loop of background_loops.py (every 30 min: BTC 1H × 120 bars by
 * REST → candle cache with TTL 1800 → detect_regime → cache).
 *
 * The pure classifier `detectRegime(frame, {tf})` and regime_allows_direction
 * live in strategies/common/marketRegime.js (LEVELS port); tests may inject a
 * fake classifier through `deps.detectRegime`. `runLoop()` = regime_loop:
 * 60 s warm-up, then every REGIME_INTERVAL.
 */

'use strict';

const { pyJsonDumps } = require('./pyjson');
const marketRegime = require('../../strategies/common/marketRegime');
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
const sleepMs = (ms) => new Promise((r) => { const h = setTimeout(r, ms); if (h.unref) h.unref(); });

/**
 * regime_allows_direction(regime, direction): trending_up → no SHORT,
 * trending_down → no LONG, high_vol / ranging → both (marketRegime.js).
 */
const { regimeAllowsDirection } = marketRegime;

function resolveDetectRegime(deps) {
  return typeof deps.detectRegime === 'function' ? deps.detectRegime : marketRegime.detectRegime;
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

    /**
     * _append_regime_history(prev, new, ts): kv['regime_history'] = the last 30 changes.
     * Unparsable JSON starts a new list; a parsed non-list (no .append) aborts the write.
     */
    appendRegimeHistory(prev, next, ts) {
      try {
        const kv = kvOf();
        const raw = kv.get(HISTORY_KEY) || '[]';
        let hist;
        try {
          hist = raw ? JSON.parse(raw) : [];
        } catch (_e) {
          log.warning('market_regime._append_regime_history() unhandled exception');
          hist = [];
        }
        if (!Array.isArray(hist)) throw new TypeError(`'${typeof hist}' object has no attribute 'append'`);
        hist.push({ ts, from: prev, to: next });
        hist = hist.slice(-HISTORY_MAX);
        kv.set(HISTORY_KEY, pyJsonDumps(hist, ['ts']));
      } catch (e) {
        log.debug(`_append_regime_history: ${e && e.message}`);
      }
    },

    /** get_regime_history(limit): hist[-limit:] ([] on any error / non-list). */
    getRegimeHistory(limit = 10) {
      try {
        const raw = kvOf().get(HISTORY_KEY) || '[]';
        const hist = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(hist)) return [];
        return limit > 0 ? hist.slice(-limit) : hist.slice(limit === 0 ? 0 : -limit);
      } catch (_e) {
        log.warning('market_regime.get_regime_history() unhandled exception');
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

    /** regime_loop(um, fetcher): sleep 60 s, then tick() every 30 min until `signal.aborted`. */
    async runLoop({ signal = null, sleep = sleepMs } = {}) {
      log.info('regime_loop запущен');
      await sleep(REGIME_START_DELAY_S * 1000);
      while (!(signal && signal.aborted)) {
        await r.tick();
        if (signal && signal.aborted) break;
        await sleep(REGIME_INTERVAL * 1000);
      }
      log.info('regime_loop остановлен.');
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
