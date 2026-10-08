'use strict';
/**
 * marketRegime.js — the pure part of market_regime.py (+ sl_v2.levels_regime_multiplier):
 *
 *   detectRegime(df, opts)          detect_regime(df, ema_period, atr_period, slope_thresh, high_vol_pct, tf)
 *   slopeThreshForTf(tf)            _slope_thresh_for_tf — per-TF table, unknown/None → 0.001
 *   regimeAllowsDirection(r, dir)   regime_allows_direction
 *   levelsRegimeMultiplier(regime)  sl_v2.levels_regime_multiplier → [mult, normalised]
 *
 * The cached BTC regime (set_cached_regime / get_cached_regime, 4 h TTL) is live state
 * owned by the scanner loop (M9); engines receive it as an argument.
 *
 * Numerics (spec §17): EMA = ewm(span=50, adjust=False) of close, ATR = ewm(span=14,
 * adjust=False) of the true range; half = max(50 // 2, 3) = 25; slope = (ema[-1] −
 * ema[-25]) / ema[-25]; atr_ratio = atr[-1] / close[-1]; order high_vol → trending_up →
 * trending_down → ranging. Fewer than max(ema, atr) + 5 bars → "ranging".
 */

const S = require('./series');

const EMA_PERIOD = 50;
const ATR_PERIOD = 14;
const SLOPE_THRESH = 0.001;
const HIGH_VOL_PCT = 0.04;

/** _SLOPE_THRESH_BY_TF — note the keys: "1H"/"1h", "4H"/"4h" both present, "1D" only (no "1d"). */
const SLOPE_THRESH_BY_TF = Object.freeze({
  '1m': 0.005,
  '3m': 0.004,
  '5m': 0.003,
  '15m': 0.002,
  '30m': 0.0015,
  '1H': 0.001,
  '1h': 0.001,
  '2H': 0.0008,
  '4H': 0.0007,
  '4h': 0.0007,
  '1D': 0.0005,
});

/**
 * _slope_thresh_for_tf(tf): falsy → baseline; unknown key → baseline.
 * QUIRK(spec §17 / §25.14): a lowercase "1d" (the TF string stored by the user) is not in
 * the table and falls back to 0.001 instead of the daily 0.0005.
 */
function slopeThreshForTf(tf) {
  if (!tf) return SLOPE_THRESH;
  return Object.prototype.hasOwnProperty.call(SLOPE_THRESH_BY_TF, tf) ? SLOPE_THRESH_BY_TF[tf] : SLOPE_THRESH;
}

/**
 * detect_regime(df, ema_period=50, atr_period=14, slope_thresh=0.001, high_vol_pct=0.04, tf=None)
 * → "trending_up" | "trending_down" | "ranging" | "high_vol". `df` is a Frame.
 * The per-TF recalibration only applies when the caller left slope_thresh at its default
 * (an explicit slope_thresh always wins).
 */
function detectRegime(df, {
  emaPeriod = EMA_PERIOD, atrPeriod = ATR_PERIOD, slopeThresh = SLOPE_THRESH, highVolPct = HIGH_VOL_PCT, tf = null,
} = {}) {
  if (tf && slopeThresh === SLOPE_THRESH) slopeThresh = slopeThreshForTf(tf);
  try {
    if (!df || df.length < Math.max(emaPeriod, atrPeriod) + 5) return 'ranging';
    const n = df.length;
    const ema = S.ewmSpan(df.c, emaPeriod);
    const atr = S.atrEmaSpan(df.h, df.l, df.c, atrPeriod);
    const lastClose = df.c[n - 1];
    const lastEma = ema[n - 1];
    const lastAtr = atr[n - 1];
    if (lastClose <= 0) return 'ranging';
    // Наклон EMA: (EMA[-1] - EMA[-period//2]) / EMA[-period//2]
    const half = Math.max(Math.floor(emaPeriod / 2), 3);
    const emaMid = n >= half ? ema[n - half] : lastEma;
    if (emaMid <= 0) return 'ranging';
    const slope = (lastEma - emaMid) / emaMid;
    const atrRatio = lastAtr / lastClose;
    if (atrRatio > highVolPct) return 'high_vol';
    if (slope > slopeThresh) return 'trending_up';
    if (slope < -slopeThresh) return 'trending_down';
    return 'ranging';
  } catch (_e) {
    return 'ranging';
  }
}

/** regime_allows_direction: trending_up blocks SHORT, trending_down blocks LONG; everything else allowed. */
function regimeAllowsDirection(regime, direction) {
  if (regime === 'trending_up' && direction === 'SHORT') return false;
  if (regime === 'trending_down' && direction === 'LONG') return false;
  return true;
}

/** sl_v2._LEVELS_REGIME_MULT */
const LEVELS_REGIME_MULT = Object.freeze({
  trend: 0.85,
  range: 1.20,
  volatile: 1.10,
  unknown: 1.00,
  trending_up: 0.85,
  trending_down: 0.85,
  ranging: 1.20,
});

/** sl_v2.levels_regime_multiplier(regime) → [multiplier, normalised_regime]; falsy → [1.0, "unknown"]. */
function levelsRegimeMultiplier(regime) {
  if (!regime) return [1.0, 'unknown'];
  const r = String(regime).toLowerCase().trim();
  return [Object.prototype.hasOwnProperty.call(LEVELS_REGIME_MULT, r) ? LEVELS_REGIME_MULT[r] : 1.0, r];
}

module.exports = {
  EMA_PERIOD, ATR_PERIOD, SLOPE_THRESH, HIGH_VOL_PCT, SLOPE_THRESH_BY_TF, LEVELS_REGIME_MULT,
  slopeThreshForTf, detectRegime, regimeAllowsDirection, levelsRegimeMultiplier,
};
