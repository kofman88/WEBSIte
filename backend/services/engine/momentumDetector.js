/**
 * momentumDetector — the bot's momentum_detector.py one-to-one.
 *
 * BTC/ETH macro impulse (|1H change| ≥ 2 %) → "relaxed mode" for 30 min:
 * LEVELS min_quality −1 (floor 2), min_rr −0.5 (floor 1.5), SMC
 * MIN_CONFIRMATIONS −1 (floor 2). Plus the per-symbol ATR breakout
 * detector (bar range > 2×ATR(14), body ≥ 50 %, volume ≥ 1.5× the previous
 * 20 bars; 1 h cooldown per symbol) — the computation is the LEVELS port's
 * strategies/levels/atrBreakout.detectAtrBreakout; this module owns the
 * module-level `_last_breakout_alert` map and hands it to the LEVELS engine
 * through `levelsOpts()` (indicator.analyze's relaxed-mode fallback).
 *
 * The clock is injected (`now` → unix seconds); the macro check takes a
 * `lastClosed1h` provider (DATA_SOURCE=bingx path: the last CLOSED 1H bar of
 * BTC and ETH through the REST fetcher, `lastClosed1hViaFetcher`).
 * `runLoop()` is momentum_loop: 120 s warm-up, then every 300 s.
 */

'use strict';

const { fmtSigned } = require('../../strategies/common/pyfmt');
const { pyMax } = require('../../strategies/common/pyround');
const atrBreakout = require('../../strategies/levels/atrBreakout');
const { log: defaultLog } = require('../marketData/mdLog');

const MOMENTUM_1H_PCT = 2.0;        // BTC/ETH move >2% за 1h = импульс
const MOMENTUM_VOL_MULT = 2.5;      // volume >2.5x среднего = аномалия (unused by the checks)
const RELAXED_DURATION = 30 * 60;   // 30 минут relaxed mode после триггера
const ATR_BREAKOUT_MULT = 2.0;      // свеча > 2×ATR = breakout
const ATR_BREAKOUT_COOLDOWN = 3600; // 1 час между алертами по одному символу
const LOOP_WARMUP_S = 120;
const LOOP_INTERVAL_S = 300;

const nowSec = () => Date.now() / 1000;
const sleepMs = (ms) => new Promise((r) => { const h = setTimeout(r, ms); if (h.unref) h.unref(); });

/** ((btc_open, btc_close), (eth_open, eth_close)) of the last CLOSED 1H bar via a REST fetcher; null when missing. */
async function lastClosed1hViaFetcher(fetcher) {
  const out = [];
  for (const sym of ['BTC-USDT-SWAP', 'ETH-USDT-SWAP']) {
    const df = await fetcher.getCandles(sym, '1H', 3);
    if (!df || df.length === 0) return null;
    const i = df.length - 1;      // от старых к новым → последняя закрытая
    out.push([Number(df.o[i]), Number(df.c[i])]);
  }
  return out;
}

function createMomentumDetector(deps = {}) {
  const now = deps.now || nowSec;
  const log = deps.log || defaultLog;
  const state = {
    relaxed: false, relaxed_until: 0.0, trigger_symbol: '', trigger_reason: '',
    btc_1h_change: 0.0, eth_1h_change: 0.0, detected_at: 0.0,
  };
  const lastBreakoutAlert = new Map();   // symbol → ts

  const d = {
    MOMENTUM_1H_PCT, RELAXED_DURATION, ATR_BREAKOUT_MULT, ATR_BREAKOUT_COOLDOWN,
    _state: state,

    isRelaxedMode() {
      if (!state.relaxed) return false;
      if (now() > state.relaxed_until) {
        state.relaxed = false;
        log.info('Momentum: relaxed mode expired');
        return false;
      }
      return true;
    },

    getState() { return state; },

    activateRelaxed(symbol, reason, btcChange = 0.0, ethChange = 0.0) {
      const t = now();
      state.relaxed = true;
      state.relaxed_until = t + RELAXED_DURATION;
      state.trigger_symbol = symbol;
      state.trigger_reason = reason;
      state.btc_1h_change = btcChange;
      state.eth_1h_change = ethChange;
      state.detected_at = t;
      log.info(`🔥 MOMENTUM: Relaxed mode ACTIVATED by ${symbol} (${reason}). BTC 1h=${fmtSigned(btcChange, 2)}%, ETH 1h=${fmtSigned(ethChange, 2)}%`);
    },

    relaxMinQuality(original) { return d.isRelaxedMode() ? pyMax(2, original - 1) : original; },
    relaxMinRr(original) { return d.isRelaxedMode() ? pyMax(1.5, original - 0.5) : original; },
    relaxConfirmations(original) { return d.isRelaxedMode() ? pyMax(2, original - 1) : original; },

    /**
     * check_macro_momentum(): `lastClosed1h` → [[btc_o, btc_c], [eth_o, eth_c]] | null.
     * Returns the trigger text when relaxed mode was activated, else null.
     */
    async checkMacroMomentum(lastClosed1h) {
      try {
        const oc = await lastClosed1h();
        if (!oc) return null;
        const [[btcO, btcC], [ethO, ethC]] = oc;
        const btcChange = btcO > 0 ? (btcC - btcO) / btcO * 100 : 0;
        const ethChange = ethO > 0 ? (ethC - ethO) / ethO * 100 : 0;
        if (Math.abs(btcChange) >= MOMENTUM_1H_PCT) {
          const direction = btcChange > 0 ? 'pump' : 'dump';
          const reason = `BTC ${direction} ${fmtSigned(btcChange, 2)}% за 1H`;
          d.activateRelaxed('BTC', reason, btcChange, ethChange);
          return reason;
        }
        if (Math.abs(ethChange) >= MOMENTUM_1H_PCT) {
          const direction = ethChange > 0 ? 'pump' : 'dump';
          const reason = `ETH ${direction} ${fmtSigned(ethChange, 2)}% за 1H`;
          d.activateRelaxed('ETH', reason, btcChange, ethChange);
          return reason;
        }
      } catch (e) {
        log.debug(`check_macro_momentum: ${e && e.message}`);
      }
      return null;
    },

    /**
     * detect_atr_breakout(symbol, df): the last closed bar with range > 2×ATR(14),
     * body ≥ 50 % of the range and volume ≥ 1.5× the mean of the 20 bars before it.
     * Returns the breakout dict or null; one alert per symbol per hour (shared map).
     */
    detectAtrBreakout(symbol, frame) {
      return atrBreakout.detectAtrBreakout(symbol, frame, { nowSec: now(), lastAlert: lastBreakoutAlert });
    },

    /**
     * The live state indicator.analyze reads from this module: relaxed mode on/off,
     * the breakout cooldown map, the trigger reason for the ATR-breakout reasons line.
     * Pass as LEVELS `analyze(…, opts)` overrides.
     */
    levelsOpts() {
      return { relaxed: d.isRelaxedMode(), nowSec: now(), breakoutState: lastBreakoutAlert, triggerReason: state.trigger_reason };
    },

    /** momentum_loop: sleep 120 s, then check_macro_momentum() every 300 s until `signal.aborted`. */
    async runLoop(lastClosed1h, { signal = null, sleep = sleepMs } = {}) {
      log.info('Momentum loop started');
      await sleep(LOOP_WARMUP_S * 1000);
      while (!(signal && signal.aborted)) {
        try {
          await d.checkMacroMomentum(lastClosed1h);
        } catch (e) {
          log.debug(`momentum_loop: ${e && e.message}`);
        }
        if (signal && signal.aborted) break;
        await sleep(LOOP_INTERVAL_S * 1000);
      }
    },

    _resetForTests() {
      Object.assign(state, { relaxed: false, relaxed_until: 0.0, trigger_symbol: '', trigger_reason: '', btc_1h_change: 0.0, eth_1h_change: 0.0, detected_at: 0.0 });
      lastBreakoutAlert.clear();
    },
  };
  return d;
}

const defaultDetector = createMomentumDetector();

module.exports = {
  MOMENTUM_1H_PCT, MOMENTUM_VOL_MULT, RELAXED_DURATION, ATR_BREAKOUT_MULT, ATR_BREAKOUT_COOLDOWN, LOOP_WARMUP_S, LOOP_INTERVAL_S,
  lastClosed1hViaFetcher, createMomentumDetector, defaultDetector,
  isRelaxedMode: () => defaultDetector.isRelaxedMode(),
  getState: () => defaultDetector.getState(),
  activateRelaxed: (...a) => defaultDetector.activateRelaxed(...a),
  relaxMinQuality: (...a) => defaultDetector.relaxMinQuality(...a),
  relaxMinRr: (...a) => defaultDetector.relaxMinRr(...a),
  relaxConfirmations: (...a) => defaultDetector.relaxConfirmations(...a),
  checkMacroMomentum: (...a) => defaultDetector.checkMacroMomentum(...a),
  detectAtrBreakout: (...a) => defaultDetector.detectAtrBreakout(...a),
  levelsOpts: () => defaultDetector.levelsOpts(),
};
