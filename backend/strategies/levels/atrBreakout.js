'use strict';
/**
 * atrBreakout.js — momentum_detector.detect_atr_breakout + the SignalResult the LEVELS
 * `analyze()` builds from it (spec §22). Only reachable in momentum "relaxed mode"
 * (global, time based — injected as `opts.relaxed`; asserted OFF in the golden fixtures).
 *
 *   detectAtrBreakout(symbol, df, { nowSec, lastAlert, cooldownSec = 3600 })
 *     needs ≥ 20 bars; per-symbol cooldown on the injected `lastAlert` Map (symbol → sec);
 *     atr = SMA(TR, 14); last closed bar: range ≥ 2·atr, body/range ≥ 0.5,
 *     volume ≥ 1.5 × mean(volume[-21:-1]); LONG when close > open;
 *     LONG sl = low − 0.3·atr, tp = entry + max(2.5·atr, 2·risk); SHORT mirrored.
 *   breakoutSignal(symbol, br, triggerReason) → SignalResult (quality 5, "ATR Breakout")
 *
 * Pure apart from the explicitly injected clock / cooldown map.
 */

const S = require('../common/series');
const { fmtFixed } = require('../common/pyfmt');
const { pyMax } = require('../common/pyround');

const ATR_BREAKOUT_MULT = 2.0;
const ATR_BREAKOUT_COOLDOWN_S = 3600;

/**
 * detect_atr_breakout(symbol, df) → dict | null. `lastAlert` (Map) is `_last_breakout_alert`
 * and is updated on a hit (like the bot's module-level dict).
 */
function detectAtrBreakout(symbol, df, { nowSec = 0, lastAlert = null, cooldownSec = ATR_BREAKOUT_COOLDOWN_S, atrMult = ATR_BREAKOUT_MULT } = {}) {
  try {
    if (!df || df.length < 20) return null;
    if (lastAlert && nowSec - (lastAlert.get(symbol) || 0) < cooldownSec) return null;
    const n = df.length;
    const atr = S.atrSma(df.h, df.l, df.c, 14);
    const lastAtr = atr[n - 1];
    if (lastAtr <= 0) return null;

    const lastO = df.o[n - 1];
    const lastC = df.c[n - 1];
    const lastH = df.h[n - 1];
    const lastL = df.l[n - 1];
    const lastVol = df.v[n - 1];

    const candleRange = lastH - lastL;
    const candleBody = Math.abs(lastC - lastO);
    if (candleRange < atrMult * lastAtr) return null;
    if (candleBody / candleRange < 0.5) return null;

    const avgVol = S.seriesMean(df.v.subarray(Math.max(0, n - 21), n - 1));   // volume.iloc[-21:-1].mean()
    if (avgVol <= 0 || lastVol < avgVol * 1.5) return null;

    const direction = lastC > lastO ? 'LONG' : 'SHORT';
    const entry = lastC;
    let sl; let tp;
    if (direction === 'LONG') {
      sl = lastL - lastAtr * 0.3;
      const risk = entry - sl;
      tp = entry + pyMax(lastAtr * 2.5, risk * 2.0);
    } else {
      sl = lastH + lastAtr * 0.3;
      const risk = sl - entry;
      tp = entry - pyMax(lastAtr * 2.5, risk * 2.0);
    }
    if (lastAlert) lastAlert.set(symbol, nowSec);
    const rangeAtrMult = candleRange / lastAtr;
    return {
      symbol, direction, entry, sl, tp, atr: lastAtr,
      range_atr_mult: rangeAtrMult,
      vol_ratio: lastVol / avgVol,
      reason: `ATR Breakout ${fmtFixed(rangeAtrMult, 1)}×ATR ${direction}`,
    };
  } catch (_e) {
    return null;
  }
}

/** The SignalResult fields `analyze()` builds from a breakout dict (everything else at defaults). */
function breakoutSignal(symbol, br, triggerReason = '') {
  const { signalResult } = require('./result');
  return signalResult({
    symbol,
    direction: br.direction,
    entry: br.entry,
    sl: br.sl,
    tp1: br.tp,
    tp2: br.entry + (br.tp - br.entry) * 1.5,
    tp3: br.entry + (br.tp - br.entry) * 2.0,
    risk_pct: Math.abs((br.sl - br.entry) / br.entry * 100),
    quality: 5,
    breakout_type: 'ATR Breakout',
    reasons: [
      `✅ ATR Breakout ${fmtFixed(br.range_atr_mult, 1)}×ATR`,
      `✅ Volume spike ${fmtFixed(br.vol_ratio, 1)}×`,
      `✅ Momentum confirmed (${triggerReason})`,
    ],
    human_explanation: `Свеча размером ${fmtFixed(br.range_atr_mult, 1)}×ATR с объёмом ${fmtFixed(br.vol_ratio, 1)}× среднего. Импульсное движение рынка.`,
  });
}

module.exports = { ATR_BREAKOUT_MULT, ATR_BREAKOUT_COOLDOWN_S, detectAtrBreakout, breakoutSignal };
