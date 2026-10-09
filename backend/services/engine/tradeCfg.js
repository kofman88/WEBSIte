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

const { pyJsonDumps, tagJsonTokens } = require('./pyjson');
const { isClose } = require('./pycoerce');
const { floatFromStr } = require('../../strategies/common/pynum');
const { pyMax } = require('../../strategies/common/pyround');   // builtin max(): a NaN 2nd argument is ignored
const { pyLoads, pyTypeName } = require('./signalTradesRepo');          // json.loads (NaN / Infinity) + type(x).__name__

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
// QUIRK(user_manager.TradeCfg): `min_volume_usdt: float = 300_000` — the dataclass
// default is an int literal, so `_val_eq(raw, default)` never takes the
// math.isclose branch for it (both operands must be Python floats) and a legacy
// override such as 300000.15 is kept, not dropped. Every other float default is
// a float literal.
const INT_LITERAL_DEFAULTS = Object.freeze(new Set(['min_volume_usdt']));
// Config.LEVELS_MIN_RR = float(os.environ.get("LEVELS_MIN_RR", "1.8")) — CPython float() of the text
const LEVELS_MIN_RR = (process.env.LEVELS_MIN_RR ? floatFromStr(process.env.LEVELS_MIN_RR) : undefined) ?? 1.8;

// ── CPython comparison / addition of the __post_init__ operands ─────────────────────
// A JSON override is not coerced, so a clamp can meet a str / None / list / dict value: CPython
// compares numbers (bool included) numerically, two str by code point, and raises TypeError for
// any other pair; `+` adds numbers and raises for the rest. The TypeError text names
// type(x).__name__ of both operands, so the Python type of every field value is tracked: a JSON
// literal's own type (2 → int, 2.0 → float), a stored column / default by its declared type,
// a clamp assignment by the assigned object.
const isNum = (v) => typeof v === 'number' || typeof v === 'boolean';
function tname(v) {
  if (v === null || v === undefined) return 'NoneType';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
  if (typeof v === 'string') return 'str';
  return Array.isArray(v) ? 'list' : 'dict';
}
/** `a <op> b` with CPython's rules; aType / bType = type(a).__name__ / type(b).__name__. */
function pyCmp(a, op, b, aType, bType) {
  if (isNum(a) && isNum(b)) {
    const x = Number(a);
    const y = Number(b);
    return op === '<' ? x < y : op === '<=' ? x <= y : op === '>' ? x > y : x >= y;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    const x = Array.from(a).map((c) => c.codePointAt(0));
    const y = Array.from(b).map((c) => c.codePointAt(0));
    let c = 0;
    for (let i = 0; i < Math.min(x.length, y.length) && c === 0; i++) c = x[i] - y[i];
    if (c === 0) c = x.length - y.length;
    return op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : c >= 0;
  }
  throw new TypeError(`'${op}' not supported between instances of '${aType}' and '${bType}'`);
}
/** `a + 1.0` / `a + 1.5` with CPython's rules. */
function pyAddFloat(a, b, aType) {
  if (isNum(a)) return Number(a) + b;
  if (typeof a === 'string') throw new TypeError('can only concatenate str (not "float") to str');
  throw new TypeError(`unsupported operand type(s) for +: '${aType}' and 'float'`);
}
/** builtin max(lo, min(hi, v)): min keeps v when `v < hi`, max keeps m when `m > lo` → [value, type]. */
function pyBetween(lo, hi, v, vType, litType) {
  const m = pyCmp(v, '<', hi, vType, litType) ? [v, vType] : [hi, litType];
  return pyCmp(m[0], '>', lo, m[1], litType) ? m : [lo, litType];
}

/**
 * TradeCfg.__post_init__ — exact order. Mutates and returns cfg. `ty(name)` is the Python type of
 * the field's current value. QUIRK: an override value of a type CPython cannot compare (e.g.
 * "300" for scan_interval) raises TypeError out of the constructor — `_sparse_merge`
 * (get_long_cfg) propagates it, from_json logs and falls back.
 */
function clamp(cfg, ty = (k) => tname(cfg[k])) {
  const T = {};
  const t = (k) => (Object.prototype.hasOwnProperty.call(T, k) ? T[k] : ty(k));
  const set = (k, v, vt) => { cfg[k] = v; T[k] = vt; };
  if (pyCmp(cfg.min_rr, '<', 1.0, t('min_rr'), 'float')) set('min_rr', 1.0, 'float');
  if (pyCmp(cfg.max_risk_pct, '>', 5.0, t('max_risk_pct'), 'float')) set('max_risk_pct', 5.0, 'float');
  if (pyCmp(cfg.max_risk_pct, '<', 0.1, t('max_risk_pct'), 'float')) set('max_risk_pct', 0.1, 'float');
  if (pyCmp(cfg.cooldown_bars, '<', 0, t('cooldown_bars'), 'int')) set('cooldown_bars', 0, 'int');
  if (pyCmp(cfg.tp1_rr, '<', cfg.min_rr, t('tp1_rr'), t('min_rr'))) set('tp1_rr', cfg.min_rr, t('min_rr'));
  if (pyCmp(cfg.tp2_rr, '<=', cfg.tp1_rr, t('tp2_rr'), t('tp1_rr'))) set('tp2_rr', pyAddFloat(cfg.tp1_rr, 1.0, t('tp1_rr')), 'float');
  if (pyCmp(cfg.tp3_rr, '<=', cfg.tp2_rr, t('tp3_rr'), t('tp2_rr'))) set('tp3_rr', pyAddFloat(cfg.tp2_rr, 1.5, t('tp2_rr')), 'float');
  if (pyCmp(cfg.scan_interval, '<', 60, t('scan_interval'), 'int')) set('scan_interval', 60, 'int');
  if (pyCmp(cfg.scan_interval, '>', 86400, t('scan_interval'), 'int')) set('scan_interval', 86400, 'int');
  cfg.min_quality = pyBetween(0, 10, cfg.min_quality, t('min_quality'), 'int')[0];
  cfg.vol_mult = pyBetween(0.1, 5.0, cfg.vol_mult, t('vol_mult'), 'float')[0];
  return cfg;
}

/** Python type of a stored field value (a column / the dataclass default): its declared type. */
function declaredType(name, v, isDefault) {
  if (typeof v !== 'number') return tname(v);
  if (isDefault && INT_LITERAL_DEFAULTS.has(name)) return 'int';
  return FIELD_TYPES[name] === 'float' ? 'float' : tname(v);
}

/** top-level key → 'int' | 'float' of the number literals of a JSON object text (json.loads types). */
function literalKinds(text) {
  const kinds = new Map();
  try {
    const r = tagJsonTokens(String(text), () => true);
    const obj = r ? JSON.parse(r.text) : null;
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string' && v.startsWith(r.tag)) kinds.set(k, /^-?\d+$/.test(v.slice(r.tag.length)) ? 'int' : 'float');
      }
    }
  } catch (_e) { /* json.loads already accepted it; nothing to type */ }
  return kinds;
}

/** typeOf for values read from JSON text: a number is typed by its literal, the rest by value. */
function jsonTypeOf(text) {
  let kinds = null;
  return (k, v) => {
    if (typeof v !== 'number') return tname(v);
    kinds = kinds || literalKinds(text);
    return kinds.get(k) || tname(v);
  };
}

/**
 * TradeCfg(**partial): unknown keys ignored, defaults filled, clamps applied. `typeOf(name, v)`
 * (optional) = the Python type of partial[name] (JSON literals); without it a partial value has
 * its declared type, like a stored column.
 */
function tradeCfg(partial = null, typeOf = null) {
  const cfg = {};
  const given = {};
  for (const name of FIELD_NAMES) {
    given[name] = Boolean(partial) && Object.prototype.hasOwnProperty.call(partial, name);
    cfg[name] = given[name] ? partial[name] : DEFAULTS[name];
  }
  return clamp(cfg, (k) => (given[k] && typeOf ? typeOf(k, cfg[k]) : declaredType(k, cfg[k], !given[k])));
}

/** TradeCfg.to_json() = json.dumps(asdict(self)) */
function toJson(cfg) {
  const ordered = {};
  for (const name of FIELD_NAMES) ordered[name] = cfg[name];
  return pyJsonDumps(ordered, FLOAT_KEYS);
}

/**
 * TradeCfg.from_json(s): json.loads, known keys only; any error (unparsable text, a non-object:
 * `d.items()` raises) → WARNING "user_manager.from_json() unhandled exception" + TradeCfg().
 */
function fromJson(s) {
  try {
    const d = pyLoads(s || '{}');
    if (d === null || typeof d !== 'object' || Array.isArray(d)) throw attributeError(d, 'items', s);
    return tradeCfg(d, jsonTypeOf(s));
  } catch (_e) {
    logOf().warning('user_manager.from_json() unhandled exception');
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

// user_manager's logger ("CHM.Users"); the engine's default logger unless setLog() wired one.
let _log = null;
const logOf = () => _log || require('../marketData/mdLog').log;
function setLog(log) { _log = log || null; }

/** AttributeError: '<type>' object has no attribute '<attr>' (the bot's `raw.get(...)` on a non-dict). */
function attributeError(v, attr, literal = '') {
  const e = new TypeError(`'${pyTypeName(v, literal)}' object has no attribute '${attr}'`);
  e.name = 'AttributeError';
  return e;
}

/**
 * `_load_sparse(raw_json)` → dict of explicit overrides. Legacy full-dump
 * JSON (no `_sparse`) is normalised by dropping values equal to the
 * TradeCfg() defaults; a sparse JSON is taken as-is (values untouched, not
 * coerced). The text is read with json.loads (NaN / Infinity tokens accepted);
 * invalid JSON → {} — `_sparse_merge` (opts.warn) logs it as WARNING
 * "user_manager._val_eq() unhandled exception", `_common._load_sparse` at DEBUG.
 * QUIRK: valid JSON that is not an object ([...], 1, "x", null, true) reaches
 * `raw.get("_sparse")` outside the bot's try → AttributeError, which propagates
 * (get_long_cfg() raises; in `_build_jobs` that ends the whole LEVELS cycle).
 */
function loadSparse(rawJson, { warn = false } = {}) {
  let raw;
  try {
    raw = pyLoads(rawJson || '{}');
  } catch (_e) {
    if (warn) logOf().warning('user_manager._val_eq() unhandled exception');
    raw = {};
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw attributeError(raw, 'get', rawJson);
  const isSparse = Boolean(raw._sparse);
  const out = {};
  for (const k of Object.keys(raw)) {
    if (!FIELD_TYPES[k]) continue;                       // drops "_sparse" and unknown keys
    const cmpType = INT_LITERAL_DEFAULTS.has(k) ? 'int' : FIELD_TYPES[k];
    if (!isSparse && valEq(raw[k], DEFAULTS[k], cmpType)) continue;
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
  const raw = loadSparse(overrideJson, { warn: true });
  const merged = {};
  for (const name of FIELD_NAMES) {
    merged[name] = Object.prototype.hasOwnProperty.call(raw, name) ? raw[name] : base[name];
  }
  const fromJson = jsonTypeOf(overrideJson);
  return tradeCfg(merged, (k, v) => (Object.prototype.hasOwnProperty.call(raw, k) ? fromJson(k, v) : declaredType(k, v, false)));
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
    MIN_RR: pyMax(cfg.min_rr, levelsMinRr), MAX_LEVEL_TESTS: cfg.max_level_tests,
    HIGH_WR_MODE: Boolean(highWrMode),
  };
}

module.exports = {
  FIELDS, FIELD_NAMES, FIELD_TYPES, DEFAULTS, FLOAT_KEYS, LEVELS_MIN_RR,
  tradeCfg, clamp, toJson, fromJson, valEq, loadSparse, saveSparse, sparseMerge,
  sharedCfg, getLongCfg, getShortCfg,
  updateSharedField, updateLongField, updateShortField, applySharedCfg, overrideKeys,
  cfgToInd, setLog,
};
