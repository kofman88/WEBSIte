'use strict';
/**
 * runners/smc.js — golden runner for the SMC engine (M4): make_golden.run_smc per bar.
 *
 *   ucfg = SMCUserCfg(**variant.smc_user_cfg); cfg_obj, key, build_kwargs = _smc_cfg_from_user(ucfg, high_wr_mode)
 *   analysis = SMCAnalyzer(SMCConfig(key)).analyze(symbol, df_htf, df_mtf, df_ltf)
 *   analysis.squeeze_score = int(compute_squeeze_score(df_mtf) or 0)
 *   sig = build_smc_signal(symbol, analysis, cfg_obj, **build_kwargs)
 *   record = asdict(sig) + squeeze_score + passes_ctx_gate + rr_ladder
 *
 * The builder config is DERIVED from the recorded SMCUserCfg (the production path),
 * then checked against the recorded cfg_obj / analysis_key / build_kwargs so a
 * derivation bug shows up as a loud error, not as thousands of mismatching bars.
 *
 * ctx (golden.test.js makeCtx('smc', …)): { symbol, i, closeMs, dfHtf (4h, last 300),
 * dfMtf (1h prefix), dfLtf (15m, last 300), variant: { name, smc_user_cfg, high_wr_mode,
 * smc_config, analysis_key, build_kwargs }, prepared }.
 */

const smc = require('../../../strategies/smc');
const { configFromAnalysisKey } = require('../../../strategies/smc/config');

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function deriveConfig(variant) {
  if (!variant.smc_user_cfg) {
    // analysis-key-only variant (digest sweeps): class defaults for the builder
    const cfg = smc.smcConfig();
    return { cfg, analysisKey: variant.analysis_key, buildKwargs: variant.build_kwargs || {}, analyzerCfg: configFromAnalysisKey(variant.analysis_key) };
  }
  const ucfg = smc.smcUserCfg.fromOverrides(variant.smc_user_cfg);
  const bc = smc.smcUserCfg.builderConfig(ucfg, { highWrMode: Boolean(variant.high_wr_mode) });
  if (variant.analysis_key && !sameJson(bc.analysisKey, variant.analysis_key)) {
    throw new Error(`smc runner: derived analysis key ${JSON.stringify(bc.analysisKey)} != recorded ${JSON.stringify(variant.analysis_key)}`);
  }
  if (variant.smc_config) {
    for (const k of Object.keys(variant.smc_config)) {
      if (!sameJson(bc.cfg[k], variant.smc_config[k])) {
        throw new Error(`smc runner: derived cfg_obj.${k}=${JSON.stringify(bc.cfg[k])} != recorded ${JSON.stringify(variant.smc_config[k])}`);
      }
    }
  }
  if (variant.build_kwargs && !sameJson(bc.buildKwargs, variant.build_kwargs)) {
    throw new Error(`smc runner: derived build_kwargs ${JSON.stringify(bc.buildKwargs)} != recorded ${JSON.stringify(variant.build_kwargs)}`);
  }
  return { cfg: bc.cfg, analysisKey: bc.analysisKey, buildKwargs: bc.buildKwargs, analyzerCfg: configFromAnalysisKey(bc.analysisKey) };
}

module.exports = {
  prepare(frames, variant) {
    return deriveConfig(variant);
  },

  run(ctx) {
    const p = ctx.prepared || deriveConfig(ctx.variant);
    const out = smc.evaluate({
      symbol: ctx.symbol,
      dfHtf: ctx.dfHtf,
      dfMtf: ctx.dfMtf,
      dfLtf: ctx.dfLtf,
      builderCfg: { cfg: p.cfg, analysisKey: p.analysisKey, buildKwargs: p.buildKwargs },
      analyzerCfg: p.analyzerCfg,
    });
    return { signal: out.signal, digest: smc.smcDigest(out.analysis), analysis: out.analysis };
  },
};
