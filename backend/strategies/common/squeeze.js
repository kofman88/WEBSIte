'use strict';
/**
 * squeeze.js — cross-strategy squeeze detector (squeeze_detector.py), pure.
 *
 *   BB width = (upper − lower) / sma  with sma = rolling(20).mean(), std = rolling(20).std(ddof=0),
 *   upper/lower = sma ± 2·std (sma == 0 → NaN), NaN rows dropped; the current width is
 *   compared with the 15 % / 30 % Series.quantile of the last `lookback` widths;
 *   ATR here is a SIMPLE rolling mean of the true range (14 and 50), ratio = atr14 / max(atr50, 1e-9).
 *
 *   score 2 = BB ≤ 15 % quantile AND ratio ≤ 0.7; 1 = BB ≤ 30 % quantile OR ratio ≤ 0.85; else 0.
 *   Fewer than max(lookback + 21, 51) bars → 0.
 *
 * The thresholds are the production env defaults (SQUEEZE_BB_LOOKBACK=50,
 * SQUEEZE_BB_PCTILE_STRONG=15, SQUEEZE_BB_PCTILE_SOME=30, SQUEEZE_ATR_RATIO_STRONG=0.7,
 * SQUEEZE_ATR_RATIO_SOME=0.85), overridable per call.
 */

const S = require('./series');

const DEFAULTS = Object.freeze({
  lookback: 50, pctileStrong: 15.0, pctileSome: 30.0, atrRatioStrong: 0.7, atrRatioSome: 0.85,
});

/** `_bb_width(df)` on the close column (NaN where the SMA is NaN or 0). */
function bbWidth(close, period = 20, mult = 2.0) {
  const sma = S.rollingMean(close, period, period);
  const std = S.rollingStd(close, period, 0, period);
  const n = close.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const upper = sma[i] + mult * std[i];
    const lower = sma[i] - mult * std[i];
    out[i] = (upper - lower) / (sma[i] === 0 ? Number.NaN : sma[i]);
  }
  return out;
}

function dropna(arr) {
  return arr.filter((v) => v === v);
}

/** Shared internals of the three public functions; null when not enough data. */
function internals(df, opts) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  const n = o.lookback;
  const rec = { n, bbw: null, recent: null, current: Number.NaN, thrStrong: Number.NaN, thrSome: Number.NaN, atr14: Number.NaN, atr50: Number.NaN, atrRatio: Number.NaN, enough: false };
  if (!df || df.length < Math.max(n + 21, 51)) return rec;
  rec.enough = true;
  const bbw = dropna(bbWidth(df.c));
  if (bbw.length < n) return rec;
  rec.bbw = bbw;
  rec.recent = bbw.subarray(bbw.length - n);
  rec.current = bbw[bbw.length - 1];
  rec.thrStrong = S.seriesQuantile(rec.recent, o.pctileStrong / 100.0);
  rec.thrSome = S.seriesQuantile(rec.recent, o.pctileSome / 100.0);
  const atr14 = dropna(S.atrSma(df.h, df.l, df.c, 14));
  const atr50 = dropna(S.atrSma(df.h, df.l, df.c, 50));
  if (!atr14.length || !atr50.length) return rec;
  rec.atr14 = atr14[atr14.length - 1];
  rec.atr50 = atr50[atr50.length - 1];
  rec.atrRatio = rec.atr14 / Math.max(rec.atr50, 1e-9);
  return rec;
}

/** `compute_squeeze_score(df)` → 0 / 1 / 2. */
function computeSqueezeScore(df, opts = null) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  const r = internals(df, o);
  if (!r.enough || r.bbw === null) return 0;              // too short / fewer than n widths
  if (r.atr14 !== r.atr14) return 0;                      // no ATR rows (len(atr14) == 0)
  const bbStrong = r.current <= r.thrStrong;
  const bbSome = r.current <= r.thrSome;
  const atrStrong = r.atrRatio <= o.atrRatioStrong;
  const atrSome = r.atrRatio <= o.atrRatioSome;
  if (bbStrong && atrStrong) return 2;
  if (bbSome && atrSome) return 1;
  if (bbSome || atrSome) return 1;
  return 0;
}

/** `is_squeeze_active(df)`: BB width ≤ the 30 % quantile AND the ATR ratio ≤ 0.85. */
function isSqueezeActive(df, opts = null) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  const r = internals(df, o);
  if (!r.enough || r.bbw === null || r.atr14 !== r.atr14) return false;
  return r.current <= r.thrSome && r.atrRatio <= o.atrRatioSome;
}

/** `get_squeeze_diagnostics(df)`: bbwidth_current, bbwidth_pctile, atr_ratio, score, label, enough_data. */
function squeezeDiagnostics(df, opts = null) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  const out = { bbwidth_current: 0.0, bbwidth_pctile: 100.0, atr_ratio: 1.0, score: 0, label: 'no', enough_data: false };
  const r = internals(df, o);
  if (!r.enough) return out;
  out.enough_data = true;
  if (r.bbw === null) return out;
  out.bbwidth_current = r.current;
  let le = 0;
  for (let i = 0; i < r.recent.length; i++) if (r.recent[i] <= r.current) le++;
  out.bbwidth_pctile = le / r.recent.length * 100.0;
  if (r.atr14 !== r.atr14) return out;
  out.atr_ratio = r.atrRatio;
  out.score = computeSqueezeScore(df, o);
  out.label = ['no', 'some', 'strong'][out.score];
  return out;
}

/** `format_squeeze_log(symbol, tf, diag)` */
function formatSqueezeLog(symbol, tf, diag) {
  const { fmtFixed } = require('./pyfmt');
  return `[SQUEEZE-DETECTED] sym=${symbol} tf=${tf} score=${diag.score} label=${diag.label} `
    + `bbw_pctile=${fmtFixed(diag.bbwidth_pctile, 1)}% atr_ratio=${fmtFixed(diag.atr_ratio, 2)}`;
}

/** Aliases used by the SMC port (same production values, env names of squeeze_detector.py). */
const SQUEEZE_DEFAULTS = Object.freeze({
  bbLookback: DEFAULTS.lookback,
  bbPctileStrong: DEFAULTS.pctileStrong,
  bbPctileSome: DEFAULTS.pctileSome,
  atrRatioStrong: DEFAULTS.atrRatioStrong,
  atrRatioSome: DEFAULTS.atrRatioSome,
});

/** squeeze_detector._atr: rolling(period).mean() of the true range. */
function atrSimple(frame, period = 14) {
  return S.atrSma(frame.h, frame.l, frame.c, period);
}

module.exports = {
  DEFAULTS, SQUEEZE_DEFAULTS, bbWidth, atrSimple, internals,
  computeSqueezeScore, isSqueezeActive, squeezeDiagnostics, formatSqueezeLog,
};
