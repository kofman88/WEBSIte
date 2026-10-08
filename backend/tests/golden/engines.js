'use strict';
/**
 * engines.js — pluggable engine registry for the golden harness.
 *
 * M2–M6 register their pure engines here (adapters live in ./runners/*.js); until
 * then an entry is `null` and golden.test.js marks the corresponding sweep as todo
 * (never failing).
 *
 * Contract (every runner is synchronous and pure; `ctx` comes from load.barInputs
 * plus the variant config stored in the expected file):
 *
 *   levels.run(ctx) → { signal: Object|null, rejectReason: string|null }
 *     ctx = { symbol, i, closeMs, df, dfHtf (1d, null unless use_htf), dfBtc, dfEth,
 *             variant: { name, trade_cfg, ind_config, high_wr_mode, scanner_post_filter } }
 *     `signal` carries every field of the fixture record except the harness keys
 *     (i, ts, open_time_ms, n_bars, n_htf_bars); squeeze_score / quality_after_squeeze /
 *     passes_min_quality are the scanner post-steps and must be included.
 *     `rejectReason` = the indicator._ANALYZE_STATS bucket ("zones", "volume", "signal",
 *     "rsi", "sl_risk", "rr", "checklist", "quality_hwr", "levels_filter"; several joined
 *     with "," in sorted order; "none" when no bucket) for a null signal.
 *
 *   smc.run(ctx) → { signal: Object|null, digest: Object|null }
 *     ctx = { symbol, i, closeMs, dfHtf (4h), dfMtf (1h prefix), dfLtf (15m),
 *             variant: { name, smc_user_cfg, high_wr_mode, smc_config, analysis_key, build_kwargs } }
 *     `signal` = SMCSignalResult fields + squeeze_score, passes_ctx_gate, rr_ladder.
 *     `digest` = make_golden._smc_digest(analysis) (compared against smc_analysis.json
 *     for the default variant only; may be null for other variants).
 *
 *   volume.run(ctx) → { signal: Object|null }
 *     ctx = { symbol, i, closeMs, df, dfHtf (4h, null unless use_htf), timeframe: '1h',
 *             variant: { name, params, volume_config } }
 *     `signal` = VolumeSignal fields + tp, risk_pct, volume_ratio, squeeze_score,
 *     quality_after_squeeze, passes_ctx_gate.
 *
 * Optional per-engine `prepare(frames, variant)` may precompute per-fixture state
 * (e.g. full-series indicators) and is passed back as ctx.prepared.
 */

const engines = {
  levels: null,
  smc: null,
  volume: require('./runners/volume'),   // M2
};

/** Register an engine runner (used by M2–M6 and by tests with dummy runners). */
function register(name, runner) {
  if (!(name in engines)) throw new Error(`unknown golden engine: ${name}`);
  engines[name] = runner;
}

function get(name) {
  return engines[name];
}

module.exports = { engines, register, get };
