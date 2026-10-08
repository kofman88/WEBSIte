/**
 * momentumDetector — the bot's momentum_detector.py one-to-one.
 *
 * BTC/ETH macro impulse (|1H change| ≥ 2 %) → "relaxed mode" for 30 min:
 * LEVELS min_quality −1 (floor 2), min_rr −0.5 (floor 1.5), SMC
 * MIN_CONFIRMATIONS −1 (floor 2). Plus the per-symbol ATR breakout
 * detector (bar range > 2×ATR(14), body ≥ 50 %, volume ≥ 1.5× the previous
 * 20 bars; 1 h cooldown per symbol).
 *
 * The clock is injected (`now` → unix seconds); the macro check takes a
 * `lastClosed1h` provider (the worker wires the BingX fetcher through
 * `lastClosed1hViaFetcher`). The loop cadence (120 s warm-up, 300 s period)
 * is the worker's.
 */

'use strict';

const { fmtSigned, fmtFixed } = require('../../strategies/common/pyfmt');
const { rollingMean, seriesMean } = require('../../strategies/common/series');
const { log: defaultLog } = require('../marketData/mdLog');

const MOMENTUM_1H_PCT = 2.0;        // BTC/ETH move >2% за 1h = импульс
const MOMENTUM_VOL_MULT = 2.5;      // volume >2.5x среднего = аномалия (unused by the checks)
const RELAXED_DURATION = 30 * 60;   // 30 минут relaxed mode после триггера
const ATR_BREAKOUT_MULT = 2.0;      // свеча > 2×ATR = breakout
const ATR_BREAKOUT_COOLDOWN = 3600; // 1 час между алертами по одному символу
const LOOP_WARMUP_S = 120;
const LOOP_INTERVAL_S = 300;

const nowSec = () => Date.now() / 1000;

/** ((btc_open, btc_close), (eth_open, eth_close)) of the last CLOSED 1H bar via a REST fetcher; null when missing. */
async function lastClosed1hViaFetcher(fetcher) {
  const out = [];
  for (const sym of ['BTC-USDT-SWAP', 'ETH-USDT-SWAP']) {
    const df = await fetcher.getCandles(sym, '1H', 3);
    if (!df || df.length === 0) return null;
    const i = df.length - 1;      // old → new → the last closed bar
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

    relaxMinQuality(original) { return d.isRelaxedMode() ? Math.max(2, original - 1) : original; },
    relaxMinRr(original) { return d.isRelaxedMode() ? Math.max(1.5, original - 0.5) : original; },
    relaxConfirmations(original) { return d.isRelaxedMode() ? Math.max(2, original - 1) : original; },

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
     * Returns the breakout dict or null; one alert per symbol per hour.
     */
    detectAtrBreakout(symbol, frame) {
      try {
        if (!frame || frame.length < 20) return null;
        const t = now();
        if (t - (lastBreakoutAlert.get(symbol) || 0) < ATR_BREAKOUT_COOLDOWN) return null;

        const n = frame.length;
        // pd.concat([...]).max(axis=1) skips the NaN prev_close of the first bar → high − low
        const tr = new Float64Array(n);
        for (let i = 0; i < n; i++) {
          const hl = frame.h[i] - frame.l[i];
          if (i === 0) { tr[i] = hl; continue; }
          tr[i] = Math.max(hl, Math.abs(frame.h[i] - frame.c[i - 1]), Math.abs(frame.l[i] - frame.c[i - 1]));
        }
        const atr = rollingMean(tr, 14);
        const lastAtr = atr[n - 1];
        if (!(lastAtr > 0)) return null;

        const lastO = frame.o[n - 1];
        const lastC = frame.c[n - 1];
        const lastH = frame.h[n - 1];
        const lastL = frame.l[n - 1];
        const lastVol = frame.v[n - 1];

        const candleRange = lastH - lastL;
        const candleBody = Math.abs(lastC - lastO);
        if (candleRange < ATR_BREAKOUT_MULT * lastAtr) return null;
        if (candleBody / candleRange < 0.5) return null;

        const avgVol = seriesMean(frame.v.subarray(n - 21, n - 1));   // [CLOSED-BAR] 20 bars before the last closed one
        if (!(avgVol > 0) || lastVol < avgVol * 1.5) return null;

        const direction = lastC > lastO ? 'LONG' : 'SHORT';
        const entry = lastC;
        let sl;
        let tp;
        if (direction === 'LONG') {
          sl = lastL - lastAtr * 0.3;
          const risk = entry - sl;
          tp = entry + Math.max(lastAtr * 2.5, risk * 2.0);
        } else {
          sl = lastH + lastAtr * 0.3;
          const risk = sl - entry;
          tp = entry - Math.max(lastAtr * 2.5, risk * 2.0);
        }
        lastBreakoutAlert.set(symbol, t);
        return {
          symbol, direction, entry, sl, tp, atr: lastAtr,
          range_atr_mult: candleRange / lastAtr,
          vol_ratio: lastVol / avgVol,
          reason: `ATR Breakout ${fmtFixed(candleRange / lastAtr, 1)}×ATR ${direction}`,
        };
      } catch (e) {
        log.debug(`detect_atr_breakout ${symbol}: ${e && e.message}`);
      }
      return null;
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
};
