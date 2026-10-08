'use strict';
/**
 * runners/levels.js — golden adapter of the LEVELS engine (engines.js contract).
 *
 * Per bar it does exactly what make_golden.run_levels did with the Python code:
 *   ic  = _cfg_to_ind(TradeCfg(**trade_cfg), high_wr_mode)        (asserted equal to the stored ind_config)
 *   ind = CHMIndicator(ic)                                          fresh instance: no zone cache, no cooldown
 *   sig = ind.analyze(symbol, df, df_htf, df_btc, df_eth)          df_htf only when USE_HTF_FILTER
 *   record = asdict(sig) + squeeze_score / quality_after_squeeze / passes_min_quality
 *   reject = the _ANALYZE_STATS bucket of a None result ("none" when no bucket)
 * Live state pinned by the generator: momentum relaxed mode OFF, BTC regime cache empty
 * (regime multiplier 1.0), SL_V2 off, LEVELS_REGIME_GATE=enforce (config.LEVELS_ENV).
 */

const L = require('../../../strategies/levels');

function prepare(frames, variant) {
  const tc = L.tradeCfg(variant.trade_cfg);
  const cfg = L.cfgToInd(tc, variant.high_wr_mode);
  const want = variant.ind_config;
  if (want) {
    const wantKeys = Object.keys(want);
    const gotKeys = Object.keys(cfg);
    if (wantKeys.join(',') !== gotKeys.join(',')) {
      throw new Error(`levels variant ${variant.name}: IndConfig field order differs\n got ${gotKeys}\nwant ${wantKeys}`);
    }
    for (const k of wantKeys) {
      if (cfg[k] !== want[k]) throw new Error(`levels variant ${variant.name}: cfg.${k} = ${cfg[k]} != ${want[k]}`);
    }
  }
  const minQuality = variant.scanner_post_filter ? variant.scanner_post_filter.min_quality : tc.min_quality;
  return { cfg, minQuality };
}

function run(ctx) {
  const { cfg, minQuality } = ctx.prepared || prepare(null, ctx.variant);
  const dfHtf = cfg.USE_HTF_FILTER ? ctx.dfHtf : null;
  const res = L.analyze(ctx.symbol, ctx.df, dfHtf, ctx.dfBtc, ctx.dfEth, cfg, { relaxed: false, regime: null });
  if (!res.signal) return { signal: null, rejectReason: res.rejectReason || 'none', stage: res.stage, reason: res.reason };
  const record = { ...res.signal, ...L.scannerPostSteps(res.signal, ctx.df, minQuality) };
  return { signal: record, rejectReason: null, stage: res.stage };
}

module.exports = { prepare, run };
