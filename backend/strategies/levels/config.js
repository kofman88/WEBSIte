const { pyMax, pyMin } = require('../common/pyround');   // builtin max()/min(): a NaN 2nd argument is ignored
'use strict';
/**
 * config.js — LEVELS configuration objects, one-to-one with the bot:
 *
 *   TRADE_CFG_DEFAULTS / tradeCfg()  user_manager.TradeCfg dataclass defaults + __post_init__ clamps
 *   IND_CONFIG_DEFAULTS / cfgToInd() scanner_mid.IndConfig + scanner_mid._cfg_to_ind (MIN_RR floor)
 *   LEVELS_ENV                       config.Config LEVELS_* gates and the env-only flags the
 *                                    indicator reads, pinned to the production defaults the golden
 *                                    fixtures were generated with (FIXTURES.md "env")
 *   REJECT                           indicator._ANALYZE_STATS bucket names (spec §18 scanner / §25)
 *
 * Spec: strategy-levels.md §2.1 (TradeCfg), §2.3 (IndConfig), §2.5 (constants).
 * Pure: plain objects in, plain objects out.
 */

/** user_manager.TradeCfg field defaults, in dataclass order (spec §2.1). */
const TRADE_CFG_DEFAULTS = Object.freeze({
  timeframe: '1h',
  scan_interval: 300,
  pivot_strength: 7,
  max_level_age: 100,
  max_retest_bars: 30,
  zone_buffer: 0.3,
  ema_fast: 50,
  ema_slow: 200,
  htf_ema_period: 50,
  rsi_period: 14,
  rsi_ob: 65,
  rsi_os: 35,
  vol_mult: 1.0,
  vol_len: 20,
  use_rsi: true,
  use_volume: true,
  use_pattern: false,
  use_htf: false,
  atr_period: 14,
  atr_mult: 1.0,
  max_risk_pct: 1.5,
  tp1_rr: 2.0,
  tp2_rr: 3.0,
  tp3_rr: 4.5,
  min_volume_usdt: 300_000,
  min_quality: 3,
  cooldown_bars: 5,
  trend_only: false,
  zone_pct: 0.7,
  max_dist_pct: 1.5,
  min_rr: 2.0,
  max_level_tests: 4,
});

const TRADE_CFG_FIELDS = Object.freeze(Object.keys(TRADE_CFG_DEFAULTS));

/**
 * TradeCfg.__post_init__ — clamps applied on EVERY construction, in this exact order
 * (spec §2.1): min_rr ≥ 1, max_risk_pct ∈ [0.1, 5], cooldown_bars ≥ 0, tp ladder
 * ordering, scan_interval ∈ [60, 86400], min_quality ∈ [0, 10], vol_mult ∈ [0.1, 5].
 * Mutates and returns `cfg`.
 */
function tradeCfgPostInit(cfg) {
  if (cfg.min_rr < 1.0) cfg.min_rr = 1.0;
  if (cfg.max_risk_pct > 5.0) cfg.max_risk_pct = 5.0;
  if (cfg.max_risk_pct < 0.1) cfg.max_risk_pct = 0.1;
  if (cfg.cooldown_bars < 0) cfg.cooldown_bars = 0;
  if (cfg.tp1_rr < cfg.min_rr) cfg.tp1_rr = cfg.min_rr;
  if (cfg.tp2_rr <= cfg.tp1_rr) cfg.tp2_rr = cfg.tp1_rr + 1.0;
  if (cfg.tp3_rr <= cfg.tp2_rr) cfg.tp3_rr = cfg.tp2_rr + 1.5;
  if (cfg.scan_interval < 60) cfg.scan_interval = 60;
  if (cfg.scan_interval > 86400) cfg.scan_interval = 86400;
  cfg.min_quality = pyMax(0, pyMin(10, cfg.min_quality));
  cfg.vol_mult = pyMax(0.1, pyMin(5.0, cfg.vol_mult));
  return cfg;
}

/**
 * TradeCfg(**overrides): defaults + overrides (unknown keys ignored like
 * TradeCfg.from_json's field filter), then __post_init__.
 */
function tradeCfg(overrides = {}) {
  const cfg = { ...TRADE_CFG_DEFAULTS };
  for (const k of TRADE_CFG_FIELDS) {
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, k) && overrides[k] !== undefined) cfg[k] = overrides[k];
  }
  return tradeCfgPostInit(cfg);
}

/**
 * config.Config LEVELS_* values + the env flags indicator.py reads directly. These are
 * the production defaults; make_golden.py pins exactly these for the fixtures.
 */
const LEVELS_ENV = Object.freeze({
  LEVELS_REGIME_GATE: 'enforce',
  LEVELS_VOL_GATE: 'off',
  LEVELS_MAX_ATR_PCT: 2.5,
  LEVELS_ENTRY_CONFIRM: 'off',
  LEVELS_MIN_RR: 1.8,
  LEVELS_RELAX_ENABLED: false,   // env LEVELS_RELAX_ENABLED ∈ {1,true,yes,on} → weak patterns, wider bounce window (§8.2)
  SL_V2_LEVELS_ENABLED: false,   // sl_v2.is_levels_enabled() → regime multiplier of MAX_RISK_PCT (§10.2)
});

/** scanner_mid.IndConfig dataclass defaults for the fields with defaults (spec §2.3). */
const IND_CONFIG_DEFAULTS = Object.freeze({
  HTF_EMA_PERIOD: 50,
  HTF_TIMEFRAME: '1d',
  USE_RSI_FILTER: true,
  USE_VOLUME_FILTER: true,
  USE_PATTERN_FILTER: false,
  USE_HTF_FILTER: false,
  ZONE_PCT: 0.7,
  MAX_DIST_PCT: 1.5,
  MIN_RR: 2.0,
  MAX_LEVEL_TESTS: 4,
  HIGH_WR_MODE: false,
});

/**
 * scanner_mid._cfg_to_ind(cfg, high_wr_mode) → IndConfig, field order of the dataclass
 * (so JSON.stringify of the result equals the `ind_config` stored in the fixtures).
 *   MIN_RR = max(cfg.min_rr, Config.LEVELS_MIN_RR)   // QUIRK(spec §2.3): floor 1.8 even for user 0.8..1.5
 */
function cfgToInd(cfg, highWrMode = false, env = LEVELS_ENV) {
  return {
    TIMEFRAME: cfg.timeframe,
    PIVOT_STRENGTH: cfg.pivot_strength,
    ATR_PERIOD: cfg.atr_period,
    ATR_MULT: cfg.atr_mult,
    MAX_RISK_PCT: cfg.max_risk_pct,
    EMA_FAST: cfg.ema_fast,
    EMA_SLOW: cfg.ema_slow,
    RSI_PERIOD: cfg.rsi_period,
    RSI_OB: cfg.rsi_ob,
    RSI_OS: cfg.rsi_os,
    VOL_MULT: cfg.vol_mult,
    VOL_LEN: cfg.vol_len,
    MAX_LEVEL_AGE: cfg.max_level_age,
    MAX_RETEST_BARS: cfg.max_retest_bars,
    COOLDOWN_BARS: cfg.cooldown_bars,
    ZONE_BUFFER: cfg.zone_buffer,
    TP1_RR: cfg.tp1_rr,
    TP2_RR: cfg.tp2_rr,
    TP3_RR: cfg.tp3_rr,
    HTF_EMA_PERIOD: cfg.htf_ema_period,
    HTF_TIMEFRAME: IND_CONFIG_DEFAULTS.HTF_TIMEFRAME,
    USE_RSI_FILTER: cfg.use_rsi,
    USE_VOLUME_FILTER: cfg.use_volume,
    USE_PATTERN_FILTER: cfg.use_pattern,
    USE_HTF_FILTER: cfg.use_htf,
    ZONE_PCT: cfg.zone_pct,
    MAX_DIST_PCT: cfg.max_dist_pct,
    MIN_RR: pyMax(cfg.min_rr, env.LEVELS_MIN_RR),
    MAX_LEVEL_TESTS: cfg.max_level_tests,
    HIGH_WR_MODE: Boolean(highWrMode),
  };
}

/** The default IndConfig (TradeCfg defaults → _cfg_to_ind). */
function defaultIndConfig() {
  return cfgToInd(tradeCfg(), false);
}

/**
 * indicator._ANALYZE_STATS buckets (`_none_stat(reason)`), in call order of _do_analyze.
 * `NONE` is the harness label for a None result that incremented no bucket (analyze()
 * prologue: too short / cooldown).
 */
const REJECT = Object.freeze({
  ZONES: 'zones',
  VOLUME: 'volume',
  SIGNAL: 'signal',
  RSI: 'rsi',
  SL_RISK: 'sl_risk',
  RR: 'rr',
  CHECKLIST: 'checklist',
  QUALITY_HWR: 'quality_hwr',
  LEVELS_FILTER: 'levels_filter',
  NONE: 'none',
});

/** Zone-cache TTL per TIMEFRAME (seconds), indicator._do_analyze `_TF_TTL_MAP`; unknown → 900 (spec §7.6). */
const ZONE_CACHE_TTL_S = Object.freeze({ '1m': 120, '5m': 300, '15m': 600, '30m': 900, '1h': 1800, '4h': 3600, '1d': 7200 });
const ZONE_CACHE_TTL_DEFAULT_S = 900;
const ZONE_CACHE_MAX = 350;

/** Minimum bars analyze() needs: max(EMA_SLOW, 100) (spec §5.3). */
function minBars(ind) {
  return Math.max(ind.EMA_SLOW, 100);
}

module.exports = {
  TRADE_CFG_DEFAULTS, TRADE_CFG_FIELDS, tradeCfgPostInit, tradeCfg,
  LEVELS_ENV, IND_CONFIG_DEFAULTS, cfgToInd, defaultIndConfig, minBars,
  REJECT, ZONE_CACHE_TTL_S, ZONE_CACHE_TTL_DEFAULT_S, ZONE_CACHE_MAX,
};
