'use strict';
/**
 * smcUserCfg.js — the bot's per-user SMC config (`user_manager.SMCUserCfg`, JSON in
 * `users.smc_cfg`) and the way `smc/scanner._scan_cycle` turns it into the builder
 * config object, the analyzer-sharing key and the `build_smc_signal` keyword
 * arguments (`make_golden._smc_cfg_from_user` replicates the same code path).
 * Spec strategy-smc.md §1 (TF map), §2.2 (fields, bot ranges), §6 (scanner derivation).
 *
 *   defaults()                       SMCUserCfg()
 *   fromJson(s)                      SMCUserCfg.from_json: known keys only, values NOT coerced,
 *                                    any parse error / non-object → defaults
 *   tfGroup(tfKey)                   _SMC_TF_MAP[tf_key] (unknown → the "1H" group)
 *   allowedDirs(ucfg, long, short)   [SMC-DIR] direction + smc_long_active / smc_short_active
 *   builderConfig(ucfg, opts)        { cfg (cfg_obj), analysisKey, buildKwargs, pdFilter, mtfCheck }
 *
 * Pure. The value ranges of the bot keyboards / handler clamps are exported as
 * RANGES for the settings layer (M7/M12); the engine itself never clamps.
 */

const { smcConfig, analysisKey } = require('./config');
const { pyTruthy, pyOr, pyGet, pyFloat, pyMax2 } = require('../common/pyval');
const { pyInt } = require('../common/pyround');

// [name, pyType, default] — dataclass order (user_manager.SMCUserCfg).
const FIELDS = Object.freeze([
  ['tf_key', 'str', '1H'],
  ['scan_interval', 'int', 300],
  ['direction', 'str', 'BOTH'],
  ['min_confirmations', 'int', 3],
  ['min_rr', 'float', 2.0],
  ['sl_buffer_pct', 'float', 0.35],
  ['min_volume_usdt', 'float', 300000],
  ['fvg_enabled', 'bool', true],
  ['choch_enabled', 'bool', true],
  ['ob_use_breaker', 'bool', true],
  ['ob_max_age', 'int', 80],
  ['sweep_close_req', 'bool', true],
  ['smc_conf_type', 'str', 'BODY_CLOSE'],
  ['smc_pd_filter', 'bool', false],
  ['smc_retrace_depth', 'float', 0.2],
  ['smc_mtf_check', 'bool', false],
  ['smc_use_volume_filter', 'bool', false],
  ['smc_vol_mult', 'float', 1.2],
  ['smc_vol_len', 'int', 20],
]);

const FIELD_NAMES = Object.freeze(FIELDS.map((f) => f[0]));
const FIELD_TYPES = Object.freeze(Object.fromEntries(FIELDS.map((f) => [f[0], f[1]])));
const DEFAULTS = Object.freeze(Object.fromEntries(FIELDS.map((f) => [f[0], f[2]])));

/** Python `k in valid` on the dataclass field set — own keys only (never "constructor" & co.). */
function isField(k) {
  return Object.prototype.hasOwnProperty.call(FIELD_TYPES, k);
}

/** Bot keyboard options / handler clamps (spec §2.2). Defaults missing from a list are a bot quirk (§11.16). */
const RANGES = Object.freeze({
  tf_key: Object.freeze(['15m', '1H', '4H']),
  scan_interval: Object.freeze([300, 600, 900, 1800, 3600]),
  direction: Object.freeze(['BOTH', 'LONG', 'SHORT']),
  min_confirmations: Object.freeze([2, 3, 4, 5]),
  min_rr: Object.freeze([1.5, 2.0, 2.5, 3.0]),
  sl_buffer_pct: Object.freeze([0.1, 0.15, 0.25, 0.5]),
  min_volume_usdt: Object.freeze([100000, 300000, 1000000, 5000000, 10000000, 20000000, 50000000, 100000000, 200000000, 500000000]),
  ob_max_age: Object.freeze([20, 30, 50, 100]),
  smc_conf_type: Object.freeze(['BODY_CLOSE', 'WICK_TOUCH']),
  smc_retrace_depth: Object.freeze({ options: [0.0, 0.3, 0.5], min: 0.0, max: 1.0 }),
  smc_vol_mult: Object.freeze({ options: [1.0, 1.2, 1.5, 2.0, 3.0], min: 0.5, max: 5.0 }),
});

/** _SMC_TF_MAP: tf_key → [HTF, MTF, LTF]. */
const SMC_TF_MAP = Object.freeze({
  '4H': Object.freeze(['1D', '4H', '1H']),
  '1H': Object.freeze(['4H', '1H', '15m']),
  '15m': Object.freeze(['1H', '15m', '15m']),   // [NO-5M] LTF == MTF for the 15m group
});

function defaults() {
  return { ...DEFAULTS };
}

/** SMCUserCfg.from_json(s): `cls(**{k: v for k, v in d.items() if k in valid})`, any error → cls(). */
function fromJson(s) {
  try {
    const d = JSON.parse(s || '{}');
    if (!d || typeof d !== 'object' || Array.isArray(d)) return defaults();
    const cfg = defaults();
    for (const k of Object.keys(d)) if (isField(k)) cfg[k] = d[k];
    return cfg;
  } catch {
    return defaults();
  }
}

/** SMCUserCfg(**overrides) — unknown keys raise in Python; here they are ignored (settings layer validates). */
function fromOverrides(overrides = {}) {
  const cfg = defaults();
  for (const k of Object.keys(overrides || {})) if (isField(k)) cfg[k] = overrides[k];
  return cfg;
}

/**
 * The (HTF, MTF, LTF) group of a tf_key; unknown keys fall back to the "1H" group
 * (`if tf_key not in _SMC_TF_MAP: tf_key = "1H"` — a dict lookup, so a key like
 * "constructor" is unknown too, not an inherited property).
 */
function tfGroup(tfKey) {
  return Object.prototype.hasOwnProperty.call(SMC_TF_MAP, tfKey) ? SMC_TF_MAP[tfKey] : SMC_TF_MAP['1H'];
}

/**
 * momentum_detector.relax_confirmations / relax_min_rr while the global relaxed mode is on
 * (BTC/ETH moved > 2 % in 1 h or volume > 2.5× average, 30 min): max(2, x − 1) / max(1.5, x − 0.5).
 * Outside relaxed mode both are the identity (spec §2.5).
 */
function relaxConfirmations(x, relaxed = true) {
  return relaxed ? pyMax2(2, x - 1) : x;
}
function relaxMinRr(x, relaxed = true) {
  return relaxed ? pyMax2(1.5, x - 0.5) : x;
}

/**
 * [SMC-DIR] allowed directions of a user: ucfg.direction narrows to one side, then the
 * smc_long_active / smc_short_active toggles filter (only when at least one is on).
 * An empty list means the scanner skips the user for this symbol.
 */
function allowedDirs(ucfg, smcLongActive = false, smcShortActive = false) {
  let dirs = ['LONG', 'SHORT'];
  const direction = pyGet(ucfg, 'direction', 'BOTH');
  if (direction === 'LONG' || direction === 'SHORT') dirs = [direction];
  const l0 = Boolean(smcLongActive);
  const s0 = Boolean(smcShortActive);
  if (l0 || s0) dirs = dirs.filter((d) => (d === 'LONG' ? l0 : s0));
  return dirs;
}

/**
 * smc/scanner._scan_cycle user-cache construction, i.e. make_golden._smc_cfg_from_user(ucfg,
 * high_wr_mode) plus the momentum relaxed mode the generator keeps off:
 *   cfg_obj = SMCConfig() with the user fields copied on; MIN_CONFIRMATIONS / MIN_RR go through
 *   relax_confirmations / relax_min_rr first (identity unless `relaxedMode`); key = _analysis_key(cfg_obj);
 *   high_wr_mode → MIN_CONFIRMATIONS = max(., 4), pd_filter = mtf_check = True.
 * Returns { cfg, analysisKey, buildKwargs, pdFilter, mtfCheck }; `buildKwargs` are the
 * exact keyword arguments of build_smc_signal (tf_* from the user's tf_key group).
 */
function builderConfig(ucfg, { highWrMode = false, relaxedMode = false, smcLongActive = false, smcShortActive = false, allowedDirs: dirsOverride = null } = {}) {
  const cfg = smcConfig();
  cfg.MIN_CONFIRMATIONS = relaxConfirmations(ucfg.min_confirmations, pyTruthy(relaxedMode));
  cfg.MIN_RR = relaxMinRr(ucfg.min_rr, pyTruthy(relaxedMode));
  cfg.SL_BUFFER_PCT = ucfg.sl_buffer_pct;
  cfg.FVG_ENABLED = ucfg.fvg_enabled;
  cfg.CHOCH_ENABLED = ucfg.choch_enabled;
  cfg.OB_USE_BREAKER = ucfg.ob_use_breaker;
  cfg.OB_MAX_AGE_CANDLES = ucfg.ob_max_age;
  cfg.SWEEP_CLOSE_REQUIRED = ucfg.sweep_close_req;
  cfg.VOL_MULT = pyFloat(pyOr(pyGet(ucfg, 'smc_vol_mult', 1.2), 1.2));
  cfg.VOL_LEN = pyInt(pyOr(pyGet(ucfg, 'smc_vol_len', 20), 20));
  cfg.USE_VOLUME_FILTER = pyTruthy(pyGet(ucfg, 'smc_use_volume_filter', false));
  const key = analysisKey(cfg);   // [SMC-USER-CFG] computed BEFORE the high-WR override
  let pdFilter;
  let mtfCheck;
  if (highWrMode) {
    cfg.MIN_CONFIRMATIONS = pyMax2(cfg.MIN_CONFIRMATIONS, 4);
    pdFilter = true;
    mtfCheck = true;
  } else {
    pdFilter = pyGet(ucfg, 'smc_pd_filter', false);
    mtfCheck = pyGet(ucfg, 'smc_mtf_check', false);
  }
  const [tfHtf, tfMtf, tfLtf] = tfGroup(pyGet(ucfg, 'tf_key', '1H'));
  const dirs = dirsOverride !== null ? dirsOverride : allowedDirs(ucfg, smcLongActive, smcShortActive);
  const buildKwargs = {
    tf_htf: tfHtf,
    tf_mtf: tfMtf,
    tf_ltf: tfLtf,
    allowed_dirs: dirs,
    conf_type: pyGet(ucfg, 'smc_conf_type', 'WICK_TOUCH'),
    pd_filter: pdFilter,
    retrace_depth: pyGet(ucfg, 'smc_retrace_depth', 0.0),
    mtf_check: mtfCheck,
  };
  return { cfg, analysisKey: key, buildKwargs, pdFilter, mtfCheck };
}

module.exports = {
  FIELDS, FIELD_NAMES, FIELD_TYPES, DEFAULTS, RANGES, SMC_TF_MAP,
  defaults, fromJson, fromOverrides, isField, tfGroup, allowedDirs, relaxConfirmations, relaxMinRr, builderConfig,
};
