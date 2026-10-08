'use strict';
/**
 * index.js — VOLUME strategy «Торговля по объёму и MA»: the public, pure entry points.
 *
 *   analyzeVolume(symbol, df, cfg, timeframe, dfHtf)  = volume_strategy.analyze_volume
 *       signal on the last CLOSED bar of `df` (a Frame) or null; `dfHtf` (HTF Frame) is used
 *       only when cfg.use_htf. Unlike the Python function it does NOT swallow exceptions
 *       (that `[VOLUME-ERR]` catch-and-warn is a scanner concern — see analyzeVolumeSafe).
 *
 *   Scanner-side pure steps of volume_scanner.py (no I/O):
 *     prepassConfig(cfg)                 the `_analyze_with_htf` pre-pass config (no HTF, min_quality−1)
 *     analyzeWithHtf(symbol, df, cfg, tf, loadHtf)  the live rule: pre-pass first, HTF only for candidates
 *     applySqueezeBonus(sig, df)         [SQUEEZE-VOLUME] mutates sig.squeeze / sig.quality (score 0/1/2)
 *     scannerPostSteps(sig, df, cfg)     the same, side-effect free: {squeeze_score, quality_after_squeeze, passes_ctx_gate}
 *     passesCtxGate(quality, cfg)        [CTX-GATE] quality ≥ cfg.min_quality
 *     dedupTtlS(tf)                      [VOLUME-TTL] max(3600, 4 × tf seconds)
 */

const { computeSqueezeScore } = require('../common/squeeze');
const config = require('./config');
const { pyLower } = require('../common/pyUnicode');   // CPython 3.11 str case / whitespace methods
const { VolumeConfig, minBars } = config;
const { VolumeContext, prepareContext } = require('./context');
const htf = require('./htf');
const detectors = require('./detectors');
const signal = require('./signal');

const { htfState, htfFor } = htf;
const { signalAt } = signal;

/**
 * `analyze_volume(symbol, df, cfg, timeframe, df_htf)`: signal on df.iloc[-1] or null.
 * With cfg.use_htf and a df_htf, LONG is allowed only when the HTF close is above its
 * EMA{htf_ema} (SHORT mirrored); a strong HTF state adds +1 quality.
 */
function analyzeVolume(symbol, df, cfg = null, timeframe = '', dfHtf = null) {
  cfg = cfg || new VolumeConfig();
  if (!df || df.length < minBars(cfg)) return null;
  let htfArr = null;
  let htfTf = '';
  if (cfg.use_htf && dfHtf !== null && dfHtf !== undefined) {
    const st = htfState(dfHtf, cfg);
    if (st !== 0) {
      htfArr = new Int8Array(df.length);
      htfArr[df.length - 1] = st;
      htfTf = htfFor(timeframe);
    }
  }
  const ctx = new VolumeContext(df, cfg, htfArr, htfTf);
  return signalAt(ctx, df.length - 1, symbol, timeframe);
}

/**
 * The Python contract ("never raises"): exceptions become null and are reported through
 * `onError(err)` (the bot logs `[VOLUME-ERR] analyze_volume %s: %s` at WARNING).
 */
function analyzeVolumeSafe(symbol, df, cfg = null, timeframe = '', dfHtf = null, onError = null) {
  try {
    return analyzeVolume(symbol, df, cfg, timeframe, dfHtf);
  } catch (e) {
    if (onError) onError(e, `[VOLUME-ERR] analyze_volume ${symbol}: ${e && e.message ? e.message : e}`);
    return null;
  }
}

// ── volume_scanner.py pure helpers ───────────────────────────────────────────

const TF_SECONDS = Object.freeze({ '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 });

/** [VOLUME-TTL 2026-10] anti-duplicate per (coin, direction) = 4 bars of the TF, at least an hour. */
function dedupTtlS(tf) {
  const sec = TF_SECONDS[pyLower(String(tf || ''))];
  return Math.max(3600, 4 * (sec === undefined ? 3600 : sec));
}

/** `dataclasses.replace(cfg, use_htf=False, min_quality=max(1, cfg.min_quality − 1))` */
function prepassConfig(cfg) {
  return cfg.replace({ use_htf: false, min_quality: Math.max(1, cfg.min_quality - 1) });
}

/**
 * `_analyze_with_htf`: without the HTF filter → the plain call; otherwise the pre-pass
 * (no HTF, min_quality − 1) must return a signal before the HTF frame is loaded
 * (`loadHtf()` → Frame | null, e.g. REST/cache or resampleHtf) and the final call runs.
 */
function analyzeWithHtf(symbol, df, cfg, timeframe, loadHtf) {
  if (!cfg.use_htf || !htfFor(timeframe)) return analyzeVolume(symbol, df, cfg, timeframe);
  const pre = analyzeVolume(symbol, df, prepassConfig(cfg), timeframe);
  if (pre === null) return null;
  const dfH = loadHtf ? loadHtf() : null;
  return analyzeVolume(symbol, df, cfg, timeframe, dfH);
}

/** [CTX-GATE] after the trend-context penalty / bonuses. */
function passesCtxGate(quality, cfg) {
  return quality >= cfg.min_quality;
}

/**
 * [SQUEEZE-VOLUME] `apply_squeeze_bonus(sig, df)`: cross / turn / golden cross out of a
 * volatility squeeze (score ≥ 1) → sig.squeeze = score, quality +1 (cap 5). Bounce and
 * ribbon setups are not breakouts and are skipped; idempotent (sig.squeeze already set).
 * Returns the score 0/1/2.
 */
function applySqueezeBonus(sig, df) {
  if (!sig || sig.setup === 'bounce' || sig.setup === 'ribbon' || sig.squeeze) {
    return sig ? Math.trunc(Number(sig.squeeze) || 0) : 0;
  }
  let score;
  try {
    score = Math.trunc(Number(computeSqueezeScore(df)) || 0);
  } catch (_e) {
    return 0;
  }
  if (score >= 1) {
    sig.squeeze = score;
    sig.quality = Math.min(5, Math.trunc(Number(sig.quality)) + 1);
  }
  return score;
}

/** Side-effect-free version of the scanner post-steps, as recorded in the golden fixtures. */
function scannerPostSteps(sig, df, cfg) {
  let sq = 0;
  if (sig.setup !== 'bounce' && sig.setup !== 'ribbon') sq = Math.trunc(Number(computeSqueezeScore(df)) || 0);
  const qAfter = sq >= 1 ? Math.min(5, sig.quality + 1) : sig.quality;
  return { squeeze_score: sq, quality_after_squeeze: qAfter, passes_ctx_gate: passesCtxGate(qAfter, cfg) };
}

module.exports = {
  ...config,
  ...htf,
  ...detectors,
  ...signal,
  VolumeContext, prepareContext,
  analyzeVolume, analyzeVolumeSafe,
  TF_SECONDS, dedupTtlS, prepassConfig, analyzeWithHtf, passesCtxGate, applySqueezeBonus, scannerPostSteps,
  computeSqueezeScore,
};
