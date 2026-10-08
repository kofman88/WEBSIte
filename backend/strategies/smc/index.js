'use strict';
/**
 * strategies/smc — the pure SMC engine: analysis layer (M3) + signal builder (M4).
 *
 *   analyze(symbol, dfHtf, dfMtf, dfLtf, cfg)            smc/analyzer.SMCAnalyzer.analyze
 *   buildSmcSignal(symbol, analysis, cfg, kwargs)         smc/signal_builder.build_smc_signal
 *   rrLadder(sig) / rrLadderText(sig)                     smc/scanner._rr_ladder / _rr_ladder_text
 *   passesCtxGate(sig, cfg)                               scanner [SMC-CTX-GATE] re-check
 *   evaluate({symbol, dfHtf, dfMtf, dfLtf, ucfg, ...})    the whole per-(symbol, user) pure path
 *
 * Everything here is synchronous and side-effect free (no DB / clock / network).
 */

const { analyze, SMCAnalyzer, smcDigest } = require('./analyzer');
const { SMC_CONFIG_DEFAULTS, smcConfig, analysisKey, configFromAnalysisKey } = require('./config');
const levels = require('./levels');
const narrative = require('./narrative');
const builder = require('./signalBuilder');
const smcUserCfg = require('./smcUserCfg');
const { computeSqueezeScore } = require('../common/squeeze');
const { pyRound, pyInt } = require('../common/pyround');
const { fmtG } = require('../common/pyfmt');
const { pyOr, pyGet, pyFloat } = require('../common/pyval');

/**
 * smc/scanner._rr_ladder(sig): R to TP1/TP2/TP3 from entry and SL, 2 dp;
 * degenerate stop → [0.0, 0.0, 0.0].
 */
function rrLadder(sig) {
  try {
    const entry = pyFloat(pyOr(pyGet(sig, 'entry', 0), 0));
    const risk = Math.abs(entry - pyFloat(pyOr(pyGet(sig, 'sl', 0), 0)));
    if (risk <= 0) return [0.0, 0.0, 0.0];
    return ['tp1', 'tp2', 'tp3'].map((k) => pyRound(Math.abs(pyFloat(pyOr(pyGet(sig, k, 0), 0)) - entry) / risk, 2));
  } catch {
    return [0.0, 0.0, 0.0];
  }
}

/** smc/scanner._rr_ladder_text(sig): f"1:{r1:g} / 1:{r2:g} / 1:{r3:g}" */
function rrLadderText(sig) {
  const [r1, r2, r3] = rrLadder(sig);
  return `1:${fmtG(r1)} / 1:${fmtG(r2)} / 1:${fmtG(r3)}`;
}

/** [SMC-CTX-GATE]: int(sig.score) >= int(cfg_obj.MIN_CONFIRMATIONS) (re-checked after the trend-context penalty). */
function passesCtxGate(sig, cfg) {
  return pyInt(sig.score) >= pyInt(pyOr(pyGet(cfg, 'MIN_CONFIRMATIONS', 0), 0));
}

/**
 * Scanner post-build direction filters (spec §6.5), applied AFTER build_smc_signal:
 *   ucfg.direction != "BOTH" and sig.direction != ucfg.direction → skip
 *   (smc_long_active or smc_short_active) and the flag of sig.direction is off → skip
 * QUIRK: the first test is a raw string compare — a direction value outside BOTH/LONG/SHORT
 * (e.g. "long") lets build_smc_signal try both sides (§6.2) and then rejects every signal here.
 */
function passesUserDirection(sig, ucfg, smcLongActive = false, smcShortActive = false) {
  const direction = pyGet(ucfg, 'direction', 'BOTH');
  if (direction !== 'BOTH' && sig.direction !== direction) return false;
  const l = Boolean(smcLongActive);
  const s = Boolean(smcShortActive);
  if ((l || s) && !(sig.direction === 'LONG' ? l : s)) return false;
  return true;
}

/**
 * [SMC-VOL-GATE] per-(user, symbol) 24 h volume gate (spec §3 step 3 / §6.2):
 *   user_min = float(ucfg.min_volume_usdt or 0); coin_vol = float(vol_by_sym.get(symbol, 0) or 0)
 *   scanned unless user_min > 0 and coin_vol < user_min.
 */
function passesVolumeGate(ucfg, coinVol) {
  const userMin = pyFloat(pyOr(pyGet(ucfg, 'min_volume_usdt', 5000000), 0));
  const vol = pyFloat(pyOr(coinVol === undefined ? 0 : coinVol, 0));
  return !(userMin > 0 && vol < userMin);
}

/**
 * The complete pure path of one (symbol, user) in smc/scanner._scan_cycle up to the
 * signal object (no BTC-trend bonus, momentum veto, dedup or quotas):
 *   analysis = SMCAnalyzer(SMCConfig(key)).analyze(...); analysis.squeeze_score = int(squeeze or 0);
 *   sig = build_smc_signal(symbol, analysis, cfg_obj, **build_kwargs)
 * Returns { analysis, signal (with squeeze_score / passes_ctx_gate / rr_ladder) | null, cfg, buildKwargs, analysisKey }.
 * Pass `analyzerCfg` to reuse a prepared analyzer config and `builderCfg` to skip the derivation.
 */
function evaluate({ symbol, dfHtf, dfMtf, dfLtf, ucfg = null, highWrMode = false, relaxedMode = false, smcLongActive = false, smcShortActive = false, allowedDirs = null, builderCfg = null, analyzerCfg = null }) {
  const bc = builderCfg || smcUserCfg.builderConfig(ucfg || smcUserCfg.defaults(), { highWrMode, relaxedMode, smcLongActive, smcShortActive, allowedDirs });
  const anCfg = analyzerCfg || configFromAnalysisKey(bc.analysisKey);
  const analysis = analyze(symbol, dfHtf, dfMtf, dfLtf, anCfg);
  analysis.squeeze_score = computeSqueezeScore(dfMtf) || 0;   // int(compute_squeeze_score(df_mtf) or 0)
  const sig = builder.buildSmcSignal(symbol, analysis, bc.cfg, bc.buildKwargs);
  const signal = sig === null ? null : {
    ...sig,
    squeeze_score: pyGet(analysis, 'squeeze_score', 0),
    passes_ctx_gate: passesCtxGate(sig, bc.cfg),
    rr_ladder: rrLadder(sig),
  };
  return { analysis, signal, cfg: bc.cfg, buildKwargs: bc.buildKwargs, analysisKey: bc.analysisKey };
}

module.exports = {
  // analysis layer (M3)
  analyze, SMCAnalyzer, smcDigest, SMC_CONFIG_DEFAULTS, smcConfig, analysisKey, configFromAnalysisKey,
  // signal builder (M4)
  calculateLevels: levels.calculateLevels, isMemcoin: levels.isMemcoin, isMajor: levels.isMajor,
  generateNarrative: narrative.generateNarrative,
  buildSmcSignal: builder.buildSmcSignal, scoreBullish: builder.scoreBullish, scoreBearish: builder.scoreBearish,
  checkRetraceWithDepth: builder.checkRetraceWithDepth, computeModeTag: builder.computeModeTag,
  GRADES: builder.GRADES, LABELS: builder.LABELS,
  rrLadder, rrLadderText, passesCtxGate, passesUserDirection, passesVolumeGate, evaluate,
  smcUserCfg,
};
