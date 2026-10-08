'use strict';
/**
 * runners/smcAnalysis.js — golden runner for the SMC ANALYSIS layer alone (M3).
 *
 * Reproduces make_golden.run_smc up to (not including) build_smc_signal for the
 * default analysis key: SMCAnalyzer(SMCConfig(<key>)).analyze(symbol, df_htf, df_mtf,
 * df_ltf) + the scanner's squeeze injection, then the _smc_digest record compared
 * against expected/smc_analysis.json.
 *
 * ctx (golden.test.js makeCtx('smc', …)): { symbol, i, closeMs, dfHtf (4h, last 300),
 * dfMtf (1h prefix), dfLtf (15m, last 300), variant: { name, analysis_key }, prepared }.
 */

const { analyze, smcDigest } = require('../../../strategies/smc/analyzer');
const { configFromAnalysisKey } = require('../../../strategies/smc/config');
const { computeSqueezeScore } = require('../../../strategies/common/squeeze');

function configOf(variant) {
  return configFromAnalysisKey(variant.analysis_key);
}

module.exports = {
  /** One SMCConfig per fixture/variant (the analyzer is stateless, the config is all it holds). */
  prepare(frames, variant) {
    return { cfg: configOf(variant) };
  },

  run(ctx) {
    const cfg = ctx.prepared && ctx.prepared.cfg ? ctx.prepared.cfg : configOf(ctx.variant);
    const analysis = analyze(ctx.symbol, ctx.dfHtf, ctx.dfMtf, ctx.dfLtf, cfg);
    // scanner: analysis["squeeze_score"] = int(compute_squeeze_score(df_mtf) or 0)
    analysis.squeeze_score = computeSqueezeScore(ctx.dfMtf) || 0;
    return { analysis, digest: smcDigest(analysis) };
  },
};
