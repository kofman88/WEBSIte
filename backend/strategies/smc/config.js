'use strict';
/**
 * config.js — `smc.analyzer.SMCConfig` (class defaults, verbatim) and the
 * scanner's analyzer-sharing key (`smc.scanner._analysis_key`).
 *
 * Spec: strategy-smc.md §2.1. `smcConfig(overrides)` copies the class defaults
 * and overwrites only UPPER-CASE keys (Python: `key.isupper() and not
 * key.startswith("_")`); unknown and lower-case keys are silently ignored.
 */

const { pyIsupper } = require('../common/pyUnicode');   // CPython 3.11 str.isupper()
const SMC_CONFIG_DEFAULTS = Object.freeze({
  // Structure
  SWING_LOOKBACK: 10,
  BOS_CONFIRMATION: true,
  CHOCH_ENABLED: true,
  // Liquidity
  EQUAL_THRESHOLD_PCT: 0.1,
  SWEEP_WICK_RATIO: 0.3,
  SWEEP_CLOSE_REQUIRED: false,
  // Order Block
  OB_MIN_IMPULSE_PCT: 0.15,
  OB_MAX_AGE_CANDLES: 60,
  OB_MITIGATED_INVALID: true,
  OB_USE_BREAKER: true,
  // FVG
  FVG_ENABLED: true,
  FVG_MIN_GAP_PCT: 0.08,
  FVG_INVERSED: true,
  FVG_PARTIAL_INVALID: false,   // accepted, never read (spec §2.1)
  // Premium/Discount
  PD_ENABLED: true,
  PD_BUFFER_PCT: 1.0,           // passed to get_premium_discount, ignored there
  // Signal
  MIN_CONFIRMATIONS: 3,
  MIN_RR: 2.0,
  SL_BUFFER_PCT: 0.5,
  TP1_RATIO: 0.33,
  TP2_RATIO: 0.50,
  TP3_RATIO: 0.17,
  // Volume filter
  VOL_MULT: 1.2,
  VOL_LEN: 20,
  USE_VOLUME_FILTER: false,
});

/** `key.isupper() and not key.startswith("_")` of SMCConfig.__init__ (str.isupper() of CPython 3.11). */
function isUpperKey(key) {
  return typeof key === 'string' && pyIsupper(key) && !key.startsWith('_');
}

/** SMCConfig(**kwargs): class defaults + UPPER-CASE overrides, unknown keys ignored. */
function smcConfig(overrides = {}) {
  const cfg = { ...SMC_CONFIG_DEFAULTS };
  for (const [key, val] of Object.entries(overrides || {})) {
    if (isUpperKey(key)) cfg[key] = val;
  }
  return cfg;
}

/** Python int(x) on a config value (ints stay, floats truncate toward zero). */
function pyIntOf(x) {
  const t = Math.trunc(Number(x));
  return t === 0 ? 0 : t;
}

/**
 * smc.scanner._analysis_key(cfg_obj) → the six fields that select a shared analyzer:
 * [FVG_ENABLED, CHOCH_ENABLED, OB_USE_BREAKER, OB_MAX_AGE_CANDLES, SWEEP_CLOSE_REQUIRED, VOL_LEN].
 */
function analysisKey(cfg) {
  return [
    Boolean(cfg.FVG_ENABLED), Boolean(cfg.CHOCH_ENABLED), Boolean(cfg.OB_USE_BREAKER),
    pyIntOf(cfg.OB_MAX_AGE_CANDLES), Boolean(cfg.SWEEP_CLOSE_REQUIRED), pyIntOf(cfg.VOL_LEN),
  ];
}

/** The analyzer config of a key: SMCConfig(<those six>) with class defaults for everything else. */
function configFromAnalysisKey(key) {
  return smcConfig({
    FVG_ENABLED: key[0], CHOCH_ENABLED: key[1], OB_USE_BREAKER: key[2],
    OB_MAX_AGE_CANDLES: key[3], SWEEP_CLOSE_REQUIRED: key[4], VOL_LEN: key[5],
  });
}

module.exports = { SMC_CONFIG_DEFAULTS, isUpperKey, smcConfig, analysisKey, configFromAnalysisKey };
