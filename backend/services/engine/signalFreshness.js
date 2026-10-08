/**
 * signalFreshness — the bot's signal_freshness.py one-to-one (signal-pipeline.md §4).
 *
 * Pre-emit guard: the latest cached close (15m → 1H → 4H) against the card's
 * entry / SL / TP1. Price past the SL → drop; |current − entry| / risk >
 * SIGNAL_MAX_DRIFT_R (0.5) → drop; price past TP1 plus the adaptive tolerance
 * (grows with the scanner's cycle-time EMA) → drop. No price → fail-open.
 *
 * Markers: [SIGNAL-STALE-SL], [SIGNAL-DRIFT], [SIGNAL-EXPIRED], [FRESHNESS-TOLERANCE].
 */

'use strict';

const { fmtG, fmtFixed } = require('../../strategies/common/pyfmt');
const { log: defaultLog } = require('../marketData/mdLog');

const EMA_ALPHA = 0.3;
const PRICE_TFS = Object.freeze(['15m', '1H', '4H']);   // [NO-5M] 5m/1m больше не в кэше

/** _env_float(name, default): float(os.getenv(name, str(default)) or default), parse failure → default. */
function envFloat(env, name, dflt) {
  const raw = env[name];
  if (raw === undefined || raw === null || raw === '') return dflt;
  const s = String(raw).trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return dflt;
  const n = Number(s);
  return Number.isFinite(n) ? n : dflt;
}

/**
 * compute_tolerance_pct(cycle_ema_s): 0 under FRESHNESS_BASELINE_S (30), then
 * FRESHNESS_TOLERANCE_STEP_PCT (0.001) / 100 per second over it, capped at
 * FRESHNESS_TOLERANCE_MAX_PCT (0.005). Returns a fraction (0.001 = 0.1 %).
 */
function computeTolerancePct(cycleEmaS, env = process.env) {
  const baseline = envFloat(env, 'FRESHNESS_BASELINE_S', 30.0);
  const stepPerSec = envFloat(env, 'FRESHNESS_TOLERANCE_STEP_PCT', 0.001) / 100.0;
  const maxTol = envFloat(env, 'FRESHNESS_TOLERANCE_MAX_PCT', 0.005);
  const over = Math.max(0.0, Number(cycleEmaS) - baseline);
  return Math.min(maxTol, over * stepPerSec);
}

const pyTruthy = (v) => !(v === null || v === undefined || v === false || v === 0 || v === '');

/**
 * createFreshness({ env, getCandles, log })
 *   getCandles(symbol, tf) → Frame|null (default: candleCache.getCandles, lazily)
 */
function createFreshness(deps = {}) {
  const env = deps.env || process.env;
  const log = deps.log || defaultLog;
  const getCandles = deps.getCandles || ((symbol, tf) => require('../marketData/candleCache').getCandles(symbol, tf));
  const MAX_DRIFT_R = envFloat(env, 'SIGNAL_MAX_DRIFT_R', 0.5);
  const cycleEma = new Map();   // STRATEGY → EMA seconds

  const f = {
    MAX_DRIFT_R,

    /** report_cycle_time(strategy, seconds): first value seeds, then ema = 0.3·s + 0.7·prev. */
    reportCycleTime(strategy, seconds) {
      if (!strategy || !(seconds > 0)) return;
      const key = String(strategy).toUpperCase();
      const prev = cycleEma.get(key);
      if (prev === undefined) cycleEma.set(key, Number(seconds));
      else cycleEma.set(key, EMA_ALPHA * Number(seconds) + (1.0 - EMA_ALPHA) * prev);
    },

    getCycleEma(strategy) {
      if (!strategy) return 0.0;
      const v = cycleEma.get(String(strategy).toUpperCase());
      return v === undefined ? 0.0 : v;
    },

    computeTolerancePct(cycleEmaS) { return computeTolerancePct(cycleEmaS, env); },

    resetCycleEmaForTests() { cycleEma.clear(); },

    /** get_current_price(symbol): first cached frame (15m, 1H, 4H) with bars and close[-1] > 0; else null. */
    getCurrentPrice(symbol) {
      try {
        for (const tf of PRICE_TFS) {
          const df = getCandles(symbol, tf);
          if (df && df.length > 0) {
            const lastClose = Number(df.c[df.length - 1]);
            if (lastClose > 0) return lastClose;
          }
        }
      } catch (e) {
        log.debug(`get_current_price ${symbol}: ${e && e.message}`);
      }
      return null;
    },

    /**
     * is_signal_fresh({symbol, direction, entry, tp1, strategy, uid, sl}) → bool
     * (sync: the candle cache is in-process). opts.current overrides the price lookup.
     */
    isSignalFresh({ symbol, direction, entry, tp1, strategy = '', uid = 0, sl = 0.0 }, opts = {}) {
      if (!(pyTruthy(entry) && pyTruthy(tp1)) || entry <= 0 || tp1 <= 0) return true;   // malformed → let through

      const current = opts.current !== undefined ? opts.current : f.getCurrentPrice(symbol);
      if (current === null || current === undefined) return true;   // fail-open

      const directionUp = String(direction || '').toUpperCase();
      const isLong = directionUp === 'LONG';
      const isShort = directionUp === 'SHORT';

      // [SIGNAL-DRIFT] price already past the stop or drifted > MAX_DRIFT_R from entry
      if (pyTruthy(sl) && sl > 0 && (isLong || isShort)) {
        const risk = Math.abs(entry - sl);
        const pastSl = isLong ? current <= sl : current >= sl;
        if (pastSl) {
          log.info(`[SIGNAL-STALE-SL] strategy=${strategy} uid=${uid} sym=${symbol} ${directionUp} entry=${fmtG(entry, 6)} sl=${fmtG(sl, 6)} `
            + `current=${fmtG(current, 6)} — drop (price past SL)`);
          return false;
        }
        if (risk > 0 && MAX_DRIFT_R > 0) {
          const driftR = Math.abs(current - entry) / risk;
          if (driftR > MAX_DRIFT_R) {
            log.info(`[SIGNAL-DRIFT] strategy=${strategy} uid=${uid} sym=${symbol} ${directionUp} entry=${fmtG(entry, 6)} current=${fmtG(current, 6)} `
              + `drift=${fmtFixed(driftR, 2)}R > ${fmtFixed(MAX_DRIFT_R, 2)}R — drop`);
            return false;
          }
        }
      }

      // [FRESHNESS-ADAPTIVE] tolerance from the scan cycle EMA
      const ema = f.getCycleEma(strategy);
      const tol = computeTolerancePct(ema, env);
      const tp1LongThreshold = tp1 * (1.0 + tol);
      const tp1ShortThreshold = tp1 * (1.0 - tol);

      let expired = false;
      let savedByTolerance = false;
      if (isLong) {
        if (current >= tp1LongThreshold) expired = true;
        else if (current >= tp1 && tol > 0) savedByTolerance = true;
      } else if (isShort) {
        if (current <= tp1ShortThreshold) expired = true;
        else if (current <= tp1 && tol > 0) savedByTolerance = true;
      }

      if (expired) {
        const deltaPct = entry ? (current - entry) / entry * 100.0 : 0.0;
        log.info(`[SIGNAL-EXPIRED] strategy=${strategy} uid=${uid} sym=${symbol} direction=${directionUp} `
          + `entry=${fmtG(entry, 6)} current=${fmtG(current, 6)} tp1=${fmtG(tp1, 6)} delta=${fmtFixed(deltaPct, 2)}% tol=${fmtFixed(tol * 100.0, 3)}% `
          + `cycle_ema=${fmtFixed(ema, 1)}s — drop (price past TP1+tolerance)`);
        return false;
      }
      if (savedByTolerance) {
        log.info(`[FRESHNESS-TOLERANCE] strategy=${strategy} uid=${uid} sym=${symbol} direction=${directionUp} `
          + `current=${fmtG(current, 6)} tp1=${fmtG(tp1, 6)} tol=${fmtFixed(tol * 100.0, 3)}% cycle_ema=${fmtFixed(ema, 1)}s — keep `
          + '(within tolerance)');
      }
      return true;
    },
  };
  return f;
}

const defaultFreshness = createFreshness();

module.exports = {
  EMA_ALPHA, PRICE_TFS, envFloat, computeTolerancePct, createFreshness, defaultFreshness,
  reportCycleTime: (...a) => defaultFreshness.reportCycleTime(...a),
  getCycleEma: (...a) => defaultFreshness.getCycleEma(...a),
  getCurrentPrice: (...a) => defaultFreshness.getCurrentPrice(...a),
  isSignalFresh: (...a) => defaultFreshness.isSignalFresh(...a),
};
