/**
 * tradeCfg — the bot's `TradeCfg` dataclass (user_manager.py) and the
 * shared / LONG / SHORT storage model around it (data-and-market.md §2.1–2.3,
 * handlers/_common.py `_load_sparse` / `_save_sparse` / `_update_*_field`).
 *
 *   • `tradeCfg(partial)`       = `TradeCfg(**partial)` → defaults + __post_init__ clamps
 *   • `sharedCfg(user)`         = `UserSettings.shared_cfg()` (flat columns → TradeCfg)
 *   • `getLongCfg/getShortCfg`  = `_sparse_merge(shared, long_cfg)` then tf / interval
 *   • `sparseMerge`, `loadSparse`, `saveSparse` reproduce the legacy-vs-sparse rule exactly
 *   • `updateSharedField / updateLongField / updateShortField / applySharedCfg`
 *   • `cfgToInd(cfg, {highWrMode})` = scanner_mid._cfg_to_ind (IndConfig keys,
 *     MIN_RR = max(min_rr, LEVELS_MIN_RR=1.8))
 *
 * Pure: plain objects in, plain objects out; no DB, no clock.
 *
 * QUIRK(data-and-market §2.1): the clamps run only when a TradeCfg is
 * constructed. The flat UserSettings columns are never clamped, so a stored
 * min_rr=0.8 reads back as 1.0 from sharedCfg()/getLongCfg().
 */

'use strict';

const { pyJsonDumps } = require('./pyjson');
const { isClose } = require('./pycoerce');

// [name, pyType, default] — dataclass order (= json.dumps key order).
const FIELDS = Object.freeze([
  ['timeframe', 'str', '1h'],
  ['scan_interval', 'int', 300],
  ['pivot_strength', 'int', 7],
  ['max_level_age', 'int', 100],
  ['max_retest_bars', 'int', 30],
  ['zone_buffer', 'float', 0.3],
  ['ema_fast', 'int', 50],
  ['ema_slow', 'int', 200],
  ['htf_ema_period', 'int', 50],
  ['rsi_period', 'int', 14],
  ['rsi_ob', 'int', 65],
  ['rsi_os', 'int', 35],
  ['vol_mult', 'float', 1.0],
  ['vol_len', 'int', 20],
  ['use_rsi', 'bool', true],
  ['use_volume', 'bool', true],
  ['use_pattern', 'bool', false],
  ['use_htf', 'bool', false],
  ['atr_period', 'int', 14],
  ['atr_mult', 'float', 1.0],
  ['max_risk_pct', 'float', 1.5],
  ['tp1_rr', 'float', 2.0],
  ['tp2_rr', 'float', 3.0],
  ['tp3_rr', 'float', 4.5],
  ['min_volume_usdt', 'float', 300000],
  ['min_quality', 'int', 3],
  ['cooldown_bars', 'int', 5],
  ['trend_only', 'bool', false],
  ['zone_pct', 'float', 0.7],
  ['max_dist_pct', 'float', 1.5],
  ['min_rr', 'float', 2.0],
  ['max_level_tests', 'int', 4],
]);

const FIELD_NAMES = Object.freeze(FIELDS.map((f) => f[0]));
const FIELD_TYPES = Object.freeze(Object.fromEntries(FIELDS.map((f) => [f[0], f[1]])));
const DEFAULTS = Object.freeze(Object.fromEntries(FIELDS.map((f) => [f[0], f[2]])));
const FLOAT_KEYS = Object.freeze(FIELDS.filter((f) => f[1] === 'float').map((f) => f[0]));
const LEVELS_MIN_RR = Number(process.env.LEVELS_MIN_RR || '1.8');   // Config.LEVELS_MIN_RR

/** TradeCfg.__post_init__ — exact order. Mutates and returns cfg. */
function clamp(cfg) {
  if (cfg.min_rr < 1.0) cfg.min_rr = 1.0;
  if (cfg.max_risk_pct > 5.0) cfg.max_risk_pct = 5.0;
  if (cfg.max_risk_pct < 0.1) cfg.max_risk_pct = 0.1;
  if (cfg.cooldown_bars < 0) cfg.cooldown_bars = 0;
  if (cfg.tp1_rr < cfg.min_rr) cfg.tp1_rr = cfg.min_rr;
  if (cfg.tp2_rr <= cfg.tp1_rr) cfg.tp2_rr = cfg.tp1_rr + 1.0;
  if (cfg.tp3_rr <= cfg.tp2_rr) cfg.tp3_rr = cfg.tp2_rr + 1.5;
  if (cfg.scan_interval < 60) cfg.scan_interval = 60;
  if (cfg.scan_interval > 86400) cfg.scan_interval = 86400;
  cfg.min_quality = Math.max(0, Math.min(10, cfg.min_quality));
  cfg.vol_mult = Math.max(0.1, Math.min(5.0, cfg.vol_mult));
  return cfg;
}

/** TradeCfg(**partial): unknown keys ignored, defaults filled, clamps applied. */
function tradeCfg(partial = null) {
  const cfg = {};
  for (const name of FIELD_NAMES) {
    cfg[name] = partial && Object.prototype.hasOwnProperty.call(partial, name) ? partial[name] : DEFAULTS[name];
  }
  return clamp(cfg);
}

/** TradeCfg.to_json() = json.dumps(asdict(self)) */
function toJson(cfg) {
  const ordered = {};
  for (const name of FIELD_NAMES) ordered[name] = cfg[name];
  return pyJsonDumps(ordered, FLOAT_KEYS);
}

/** TradeCfg.from_json(s): known keys only; any error → TradeCfg(). */
function fromJson(s) {
  try {
    const d = JSON.parse(s || '{}');
    if (!d || typeof d !== 'object' || Array.isArray(d)) return tradeCfg();
    return tradeCfg(d);
  } catch (_e) {
    return tradeCfg();
  }
}

/**
 * `_val_eq(a, b)` of _sparse_merge / `_eq` of _load_sparse: two Python floats
 * compare with math.isclose(rel_tol=1e-6, abs_tol=1e-9); everything else with
 * `==` (bool/int/float compare numerically, str never equals a number). The
 * field's declared type tells us when the stored default is a Python float.
 */
function valEq(a, b, type) {
  const numA = typeof a === 'number' || typeof a === 'boolean';
  const numB = typeof b === 'number' || typeof b === 'boolean';
  if (numA && numB) {
    if (type === 'float' && typeof a === 'number' && typeof b === 'number') return isClose(a, b, 1e-6, 1e-9);
    return Number(a) === Number(b);
  }
  return a === b;
}

/**
 * `_load_sparse(raw_json)` → dict of explicit overrides. Legacy full-dump
 * JSON (no `_sparse`) is normalised by dropping values equal to the
 * TradeCfg() defaults; a sparse JSON is taken as-is (values untouched, not
 * coerced). Invalid JSON → {}.
 */
function loadSparse(rawJson) {
  let raw;
  try {
    raw = JSON.parse(rawJson || '{}');
  } catch (_e) {
    raw = {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
  const isSparse = Boolean(raw._sparse);
  const out = {};
  for (const k of Object.keys(raw)) {
    if (!FIELD_TYPES[k]) continue;                       // drops "_sparse" and unknown keys
    if (!isSparse && valEq(raw[k], DEFAULTS[k], FIELD_TYPES[k])) continue;
    out[k] = raw[k];
  }
  return out;
}

/** `_save_sparse(overrides)` → json.dumps({...known keys, "_sparse": true}) */
function saveSparse(overrides) {
  const out = {};
  for (const k of Object.keys(overrides || {})) if (FIELD_TYPES[k]) out[k] = overrides[k];
  out._sparse = true;
  return pyJsonDumps(out, FLOAT_KEYS);
}

/**
 * `_sparse_merge(base, override_json)` → TradeCfg (clamped): every field of
 * `base` unless the (normalised) override names it.
 */
function sparseMerge(base, overrideJson) {
  const raw = loadSparse(overrideJson);
  const merged = {};
  for (const name of FIELD_NAMES) {
    merged[name] = Object.prototype.hasOwnProperty.call(raw, name) ? raw[name] : base[name];
  }
  return tradeCfg(merged);
}

/** UserSettings.shared_cfg(): the flat columns as a (clamped) TradeCfg. */
function sharedCfg(user) {
  const partial = {};
  for (const name of FIELD_NAMES) partial[name] = user[name];
  return tradeCfg(partial);
}

/** UserSettings.get_long_cfg(): sparse merge, then timeframe / scan_interval from long_tf / long_interval (no re-clamp). */
function getLongCfg(user) {
  const merged = sparseMerge(sharedCfg(user), user.long_cfg);
  merged.timeframe = user.long_tf;
  merged.scan_interval = user.long_interval;
  return merged;
}

function getShortCfg(user) {
  const merged = sparseMerge(sharedCfg(user), user.short_cfg);
  merged.timeframe = user.short_tf;
  merged.scan_interval = user.short_interval;
  return merged;
}

/** handlers._common._update_shared_field: setattr only when the attribute exists; long/short JSON untouched. */
function updateSharedField(user, field, value) {
  if (Object.prototype.hasOwnProperty.call(user, field)) user[field] = value;
}

/** handlers._common._update_long_field: explicit override in the sparse long_cfg JSON. */
function updateLongField(user, field, value) {
  const overrides = loadSparse(user.long_cfg);
  overrides[field] = value;
  user.long_cfg = saveSparse(overrides);
}

function updateShortField(user, field, value) {
  const overrides = loadSparse(user.short_cfg);
  overrides[field] = value;
  user.short_cfg = saveSparse(overrides);
}

/** handlers._common._apply_shared_cfg: TradeCfg → flat columns only (long/short JSON untouched). */
function applySharedCfg(user, cfg) {
  for (const name of FIELD_NAMES) {
    if (Object.prototype.hasOwnProperty.call(user, name)) user[name] = cfg[name];
  }
}

/** The explicit per-direction overrides (keys only) — what the web UI marks as "overridden". */
function overrideKeys(rawJson) {
  return Object.keys(loadSparse(rawJson));
}

/**
 * scanner_mid._cfg_to_ind(cfg, high_wr_mode) → IndConfig keyword set.
 * MIN_RR floor = Config.LEVELS_MIN_RR (env LEVELS_MIN_RR, default 1.8).
 */
function cfgToInd(cfg, { highWrMode = false, levelsMinRr = LEVELS_MIN_RR } = {}) {
  return {
    TIMEFRAME: cfg.timeframe, PIVOT_STRENGTH: cfg.pivot_strength,
    ATR_PERIOD: cfg.atr_period, ATR_MULT: cfg.atr_mult,
    MAX_RISK_PCT: cfg.max_risk_pct, EMA_FAST: cfg.ema_fast, EMA_SLOW: cfg.ema_slow,
    RSI_PERIOD: cfg.rsi_period, RSI_OB: cfg.rsi_ob, RSI_OS: cfg.rsi_os,
    VOL_MULT: cfg.vol_mult, VOL_LEN: cfg.vol_len,
    MAX_LEVEL_AGE: cfg.max_level_age, MAX_RETEST_BARS: cfg.max_retest_bars,
    COOLDOWN_BARS: cfg.cooldown_bars, ZONE_BUFFER: cfg.zone_buffer,
    TP1_RR: cfg.tp1_rr, TP2_RR: cfg.tp2_rr, TP3_RR: cfg.tp3_rr,
    HTF_EMA_PERIOD: cfg.htf_ema_period,
    USE_RSI_FILTER: cfg.use_rsi, USE_VOLUME_FILTER: cfg.use_volume,
    USE_PATTERN_FILTER: cfg.use_pattern, USE_HTF_FILTER: cfg.use_htf,
    ZONE_PCT: cfg.zone_pct, MAX_DIST_PCT: cfg.max_dist_pct,
    MIN_RR: Math.max(cfg.min_rr, levelsMinRr), MAX_LEVEL_TESTS: cfg.max_level_tests,
    HIGH_WR_MODE: Boolean(highWrMode),
  };
}

module.exports = {
  FIELDS, FIELD_NAMES, FIELD_TYPES, DEFAULTS, FLOAT_KEYS, LEVELS_MIN_RR,
  tradeCfg, clamp, toJson, fromJson, valEq, loadSparse, saveSparse, sparseMerge,
  sharedCfg, getLongCfg, getShortCfg,
  updateSharedField, updateLongField, updateShortField, applySharedCfg, overrideKeys,
  cfgToInd,
};
