'use strict';
/**
 * runners/volume.js — golden adapter of the VOLUME engine (engines.js contract).
 *
 * Per bar it does exactly what make_golden.run_volume did with the Python code:
 *   cfg = VolumeConfig.from_params(params)
 *   sig = analyze_volume(symbol, df, cfg, "1h", df_htf)            (df_htf only when cfg.use_htf)
 *   record = asdict(sig) + tp/risk_pct/volume_ratio + the scanner post-steps
 *            squeeze_score (0 for bounce/ribbon, else compute_squeeze_score(df)),
 *            quality_after_squeeze, passes_ctx_gate
 * `prepare` also asserts that fromParams(params) reproduces the `volume_config` dict the
 * generator dumped for the variant (coercion + _fix on the real path).
 */

const V = require('../../../strategies/volume');

function prepare(frames, variant) {
  const cfg = V.VolumeConfig.fromParams(variant.params);
  const want = variant.volume_config;
  if (want) {
    const got = cfg.toDict();
    const wantKeys = Object.keys(want), gotKeys = Object.keys(got);
    if (wantKeys.join(',') !== gotKeys.join(',')) {
      throw new Error(`volume variant ${variant.name}: config field order differs\n got ${gotKeys}\nwant ${wantKeys}`);
    }
    for (const k of wantKeys) {
      if (got[k] !== want[k]) throw new Error(`volume variant ${variant.name}: cfg.${k} = ${got[k]} != ${want[k]}`);
    }
  }
  return { cfg };
}

function run(ctx) {
  const cfg = ctx.prepared ? ctx.prepared.cfg : V.VolumeConfig.fromParams(ctx.variant.params);
  const sig = V.analyzeVolume(ctx.symbol, ctx.df, cfg, ctx.timeframe, cfg.use_htf ? ctx.dfHtf : null);
  if (!sig) return { signal: null };
  const record = {
    ...sig.toDict(),
    tp: sig.tp, risk_pct: sig.risk_pct, volume_ratio: sig.volume_ratio,
    ...V.scannerPostSteps(sig, ctx.df, cfg),
  };
  return { signal: record };
}

module.exports = { prepare, run };
