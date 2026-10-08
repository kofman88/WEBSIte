'use strict';
/**
 * squeeze.js — one-to-one port of the bot's `squeeze_detector.py` (cross-strategy
 * BB-squeeze + ATR-contraction score used as a score booster by SMC c8, the
 * LEVELS scanner "SQUEEZE-BOOST" and the VOLUME scanner `apply_squeeze_bonus`).
 *
 * Pure: takes a candle Frame ({h, l, c} Float64Arrays + length) and a threshold
 * object. The Python module reads its thresholds from the environment
 * (SQUEEZE_BB_LOOKBACK, SQUEEZE_BB_PCTILE_STRONG, SQUEEZE_BB_PCTILE_SOME,
 * SQUEEZE_ATR_RATIO_STRONG, SQUEEZE_ATR_RATIO_SOME); the engine takes them as a
 * plain object instead, defaulting to the production values pinned in the
 * golden fixtures (`expected/*.json → env`).
 *
 * Numeric contract (spec strategy-smc.md §4.8, FIXTURES.md "SMC"):
 *   bbw   = (sma20 + 2·std20 − (sma20 − 2·std20)) / sma20.replace(0, NaN), std ddof=0
 *   thr   = Series.quantile(last 50 bbw, p/100)   (linear interpolation)
 *   atr_n = rolling(n).mean() of the true range   (simple mean, NOT Wilder/EMA)
 *   ratio = atr14[-1] / max(atr50[-1], 1e-9)
 */

const S = require('./series');

/** Production defaults of squeeze_detector.py (env-overridable there, config here). */
const SQUEEZE_DEFAULTS = Object.freeze({
  bbLookback: 50,        // SQUEEZE_BB_LOOKBACK
  bbPctileStrong: 15.0,  // SQUEEZE_BB_PCTILE_STRONG
  bbPctileSome: 30.0,    // SQUEEZE_BB_PCTILE_SOME
  atrRatioStrong: 0.7,   // SQUEEZE_ATR_RATIO_STRONG
  atrRatioSome: 0.85,    // SQUEEZE_ATR_RATIO_SOME
});

function nBars(frame) {
  return frame.length !== undefined ? frame.length : frame.c.length;
}

/** Series.dropna() on a Float64Array. */
function dropna(a) {
  let k = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === a[i]) k++;
  const out = new Float64Array(k);
  k = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === a[i]) out[k++] = a[i];
  return out;
}

/** squeeze_detector._bb_width: (upper − lower) / sma.replace(0, nan), std ddof=0. */
function bbWidth(close, period = 20, mult = 2.0) {
  const sma = S.rollingMean(close, period, period);
  const std = S.rollingStd(close, period, 0, period);
  const n = close.length;
  const width = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const upper = sma[i] + mult * std[i];
    const lower = sma[i] - mult * std[i];
    width[i] = (upper - lower) / (sma[i] === 0 ? Number.NaN : sma[i]);
  }
  return width;
}

/** squeeze_detector._atr: rolling(period).mean() of the true range (row 0 = high − low). */
function atrSimple(frame, period = 14) {
  return S.atrSma(frame.h, frame.l, frame.c, period);
}

/**
 * Shared computation of the three public functions. Returns null when the Python
 * code would bail out early (not enough bars / BB values), otherwise the internals
 * { bbw, recent, current, thrStrong, thrSome, atr14, atr50, atrRatio, o } with
 * atrRatio === null when either ATR series is empty after dropna().
 */
function internals(frame, opts) {
  const o = { ...SQUEEZE_DEFAULTS, ...(opts || {}) };
  const n = o.bbLookback;
  const len = nBars(frame);
  if (len < Math.max(n + 21, 51)) return null;
  const bbw = dropna(bbWidth(frame.c));
  if (bbw.length < n) return null;
  const recent = bbw.subarray(bbw.length - n);
  const current = bbw[bbw.length - 1];
  // Python: recent_bbw.quantile(pctile / 100.0)
  const thrStrong = S.seriesQuantile(recent, o.bbPctileStrong / 100.0);
  const thrSome = S.seriesQuantile(recent, o.bbPctileSome / 100.0);
  const atr14 = dropna(atrSimple(frame, 14));
  const atr50 = dropna(atrSimple(frame, 50));
  if (atr14.length === 0 || atr50.length === 0) {
    return { bbw, recent, current, thrStrong, thrSome, atr14: null, atr50: null, atrRatio: null, o };
  }
  const a14 = atr14[atr14.length - 1], a50 = atr50[atr50.length - 1];
  const atrRatio = a14 / Math.max(a50, 1e-9);
  return { bbw, recent, current, thrStrong, thrSome, atr14: a14, atr50: a50, atrRatio, o };
}

/**
 * squeeze_detector.compute_squeeze_score(df) → 0 | 1 | 2.
 * `frame` null → 0 (like `df is None`).
 */
function computeSqueezeScore(frame, opts) {
  if (!frame) return 0;
  const x = internals(frame, opts);
  if (!x || x.atrRatio === null) return 0;
  const bbStrong = x.current <= x.thrStrong;
  const bbSome = x.current <= x.thrSome;
  const atrStrong = x.atrRatio <= x.o.atrRatioStrong;
  const atrSome = x.atrRatio <= x.o.atrRatioSome;
  if (bbStrong && atrStrong) return 2;
  if (bbSome && atrSome) return 1;
  if (bbSome || atrSome) return 1;
  return 0;
}

/** squeeze_detector.is_squeeze_active(df): BB in the lower SOME percentile AND ATR contracted. */
function isSqueezeActive(frame, opts) {
  if (!frame) return false;
  const x = internals(frame, opts);
  if (!x || x.atrRatio === null) return false;
  const bbSqueeze = x.current <= x.thrSome;
  const atrContracted = x.atrRatio <= x.o.atrRatioSome;
  return Boolean(bbSqueeze && atrContracted);
}

const LABELS = Object.freeze({ 0: 'no', 1: 'some', 2: 'strong' });

/**
 * squeeze_detector.get_squeeze_diagnostics(df) plus the internals the golden layer
 * dump records (n, bbw_last, thr_strong, thr_some, atr14, atr50, atr_ratio, bbw_recent).
 */
function squeezeDiagnostics(frame, opts) {
  const out = {
    bbwidth_current: 0.0, bbwidth_pctile: 100.0, atr_ratio: 1.0, score: 0, label: 'no', enough_data: false,
    n: frame ? nBars(frame) : 0, bbw_last: null, thr_strong: null, thr_some: null, atr14: null, atr50: null, bbw_recent: null,
  };
  if (!frame) return out;
  const o = { ...SQUEEZE_DEFAULTS, ...(opts || {}) };
  if (nBars(frame) < Math.max(o.bbLookback + 21, 51)) return out;
  out.enough_data = true;
  const x = internals(frame, opts);
  if (!x) return out;
  out.bbwidth_current = x.current;
  out.bbw_last = x.current;
  out.thr_strong = x.thrStrong;
  out.thr_some = x.thrSome;
  out.bbw_recent = Array.from(x.recent);
  let le = 0;
  for (let i = 0; i < x.recent.length; i++) if (x.recent[i] <= x.current) le++;
  out.bbwidth_pctile = le / x.recent.length * 100.0;
  if (x.atrRatio === null) return out;
  out.atr14 = x.atr14;
  out.atr50 = x.atr50;
  out.atr_ratio = x.atrRatio;
  out.score = computeSqueezeScore(frame, opts);
  out.label = LABELS[out.score];
  return out;
}

module.exports = { SQUEEZE_DEFAULTS, bbWidth, atrSimple, computeSqueezeScore, isSqueezeActive, squeezeDiagnostics };
