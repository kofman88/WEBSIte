'use strict';
/**
 * config.js — VOLUME strategy configuration (volume_strategy.VolumeConfig), ported
 * one-to-one from /home/user/MAIN_BOT/CHM_BREAKER_V4/volume_strategy.py
 * (spec: port/specs/strategy-volume.md §3).
 *
 *   VolumeConfig.fromParams(params)  — the ONLY path that coerces + normalises (`_fix`),
 *                                      exactly like the kv / genome / Mini App loaders;
 *   new VolumeConfig(overrides)      — dataclass __init__: fields set as given, NO fix;
 *   cfg.replace(overrides)           — dataclasses.replace: copy with overrides, NO fix
 *                                      (the scanner pre-pass relies on this);
 *   cfg.toDict()                     — asdict() in field order; cfg.paramsDict() drops the
 *                                      six user-preference keys (USER_PREF_KEYS).
 *
 * Coercion mirrors CPython: bool fields accept the strings "1/true/yes/on" (anything
 * else → false) and `bool(v)` for non-strings; int fields use `int(v)` (a float is
 * truncated, "1.5" raises → key skipped, inf raises OverflowError → propagates);
 * float fields use `float(v)`; the str field uses `str(v).strip().lower()`.
 */

const { pyRound, pyMax, pyMin } = require('../common/pyround');
const { pyLower, pyStrip } = require('../common/pyUnicode');

const STRATEGY_NAME = 'VOLUME';
const SETUP_KEYS = Object.freeze(['cross', 'turn', 'bounce', 'golden', 'ribbon']);
/** [VOLUME-RIBBON] EMA ribbon spans (ascending). */
const RIBBON_SPANS = Object.freeze([5, 9, 14, 20, 27, 35, 44, 55]);
const RIBBON_LOOKBACK = 8;        // pullback window (bars)
const RIBBON_MIN_ORDER = 0.75;    // ordered-pair share before the pullback
/** User preferences (UI toggles) — the genome never touches them. */
const USER_PREF_KEYS = Object.freeze(['setup_cross', 'setup_turn', 'setup_bounce', 'setup_golden', 'setup_ribbon', 'use_htf']);

const BOUNCE_LOOKBACK = 10;       // bars "before the pullback" (price above the EMA)
const GOLDEN_VOL_MIN = 1.0;       // golden cross: volume not below average
const CLIMAX_MOVE_ATR = 3.0;      // climax: move ≥ 3 ATR over 5 bars
const HTF_SLOPE_BARS = 3;
const SL_RECENT_BARS = 3;         // [VOL-SL-VOLATILITY] bars of "fresh" volatility

/**
 * Dataclass fields in declaration order: [name, type, default]. The type drives the
 * from_params coercion exactly like `isinstance(cur, bool/int/float/str)` does in Python
 * (bool is checked before int there, hence the explicit tags).
 */
const FIELDS = Object.freeze([
  // ── setups ──
  ['setup_cross', 'bool', true],
  ['setup_turn', 'bool', true],
  ['setup_bounce', 'bool', true],
  ['setup_golden', 'bool', true],
  ['setup_ribbon', 'bool', true],
  ['ribbon_vol_mult', 'float', 1.0],
  // ── moving averages ──
  ['ma_type', 'str', 'sma'],
  ['ma_fast', 'int', 10],
  ['ma_mid', 'int', 20],
  ['ma_slow', 'int', 50],
  ['ema_mid', 'int', 50],
  ['ema_trend', 'int', 200],
  ['trend_filter', 'bool', true],
  // ── MA Cross ──
  ['cross_lookback', 'int', 2],
  // ── MA Turn ──
  ['turn_period', 'int', 20],
  ['turn_lookback', 'int', 5],
  ['turn_slope_bars', 'int', 2],
  ['turn_min_slope_atr', 'float', 0.05],
  // ── EMA Bounce ──
  ['bounce_tol_atr', 'float', 0.25],
  ['bounce_vol_mult', 'float', 1.0],
  // ── volume ──
  ['vol_len', 'int', 20],
  ['vol_mult', 'float', 1.5],
  ['climax_mult', 'float', 4.5],
  // ── filters ──
  ['extension_atr', 'float', 2.5],
  ['rsi_period', 'int', 14],
  ['rsi_long_max', 'float', 70.0],
  ['rsi_short_min', 'float', 30.0],
  ['atr_period', 'int', 14],
  ['use_htf', 'bool', true],
  ['htf_ema', 'int', 50],
  // ── risk ──
  ['sl_atr_mult', 'float', 2.0],
  ['sl_buffer_atr', 'float', 0.25],
  ['swing_lookback', 'int', 10],
  ['max_sl_pct', 'float', 4.0],
  ['tp1_rr', 'float', 1.0],
  ['tp2_rr', 'float', 2.0],
  ['tp3_rr', 'float', 3.0],
  ['min_quality', 'int', 3],
]);

const FIELD_NAMES = Object.freeze(FIELDS.map((f) => f[0]));
const FIELD_TYPE = Object.freeze(Object.fromEntries(FIELDS.map((f) => [f[0], f[1]])));
const DEFAULTS = Object.freeze(Object.fromEntries(FIELDS.map((f) => [f[0], f[2]])));
/** `CONFIG_FIELDS` of the Python module (set of the 38 dataclass field names). */
const CONFIG_FIELDS = Object.freeze(new Set(FIELD_NAMES));

// ─────────────────────────────────────────────────────────────────────────────
// CPython coercions used by from_params
// ─────────────────────────────────────────────────────────────────────────────

/** Raised where CPython raises TypeError/ValueError (→ the key is skipped). */
class PyValueError extends Error {}
/** Raised where CPython raises OverflowError (int(inf)) — NOT caught by from_params. */
class PyOverflowError extends Error {}

/** Python bool(v) for a non-string value; strings follow the from_params rule. */
function pyBool(v) {
  if (typeof v === 'string') return ['1', 'true', 'yes', 'on'].includes(pyLower(pyStrip(v)));   // v.strip().lower()
  if (typeof v === 'number') return v !== 0;          // bool(nan) is True, bool(0.0) False
  if (typeof v === 'bigint') return v !== 0n;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map || v instanceof Set) return v.size > 0;
  if (v && typeof v === 'object') return Object.keys(v).length > 0;
  return Boolean(v);
}

// int() / float() of a str: CPython 3.11 (Unicode digits and spaces, PEP 515) — common/pynum.js.
const N = require('../common/pynum');

/** Python int(v): bool → 0/1, float → trunc (nan → ValueError, inf → OverflowError), str → base-10 literal. */
function pyInt(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') {
    const t = N.intFromFloat(v);
    if (t !== null) return t;
    if (Number.isNaN(v)) throw new PyValueError(N.floatToIntErrorText(v));
    throw new PyOverflowError(N.floatToIntErrorText(v));
  }
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') {
    const lit = N.intLiteral(v);
    if (lit === null) throw new PyValueError(N.intErrorText(v));
    if (lit.limit !== undefined) throw new PyValueError(N.intLimitText(lit.limit));
    return N.intFromLiteral(lit);
  }
  throw new PyValueError(`int() argument must be a string, a bytes-like object or a real number, not '${typeof v}'`);
}

/** Python float(v): bool → 0.0/1.0, number as is (nan/inf allowed), str → float literal incl. inf/nan. */
function pyFloat(v) {
  if (typeof v === 'boolean') return v ? 1.0 : 0.0;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') {
    const x = N.floatFromStr(v);
    if (x === undefined) throw new PyValueError(N.floatErrorText(v));
    return x;
  }
  throw new PyValueError(`float() argument must be a string or a real number, not '${typeof v}'`);
}

/** Python str(v) for the values a config loader can see (bool → "True"/"False"). */
function pyStr(v) {
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (v === null) return 'None';
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch (_e) { return String(v); }
  }
  return String(v);
}

// ─────────────────────────────────────────────────────────────────────────────
// VolumeConfig
// ─────────────────────────────────────────────────────────────────────────────

class VolumeConfig {
  /** dataclass __init__: defaults, then the given fields verbatim (no coercion, no fix). */
  constructor(overrides = null) {
    for (const name of FIELD_NAMES) this[name] = DEFAULTS[name];
    if (overrides) {
      for (const k of Object.keys(overrides)) {
        if (!CONFIG_FIELDS.has(k)) throw new TypeError(`VolumeConfig: unexpected field '${k}'`);
        this[k] = overrides[k];
      }
    }
  }

  /**
   * Build a config from a dict (genome / kv / Mini App), ignoring unknown keys and
   * `None` values, coercing by the type of the field's default, then `_fix()`.
   * `TypeError`/`ValueError` during coercion skip the key silently (Python
   * `except (TypeError, ValueError): continue`); OverflowError propagates.
   */
  static fromParams(params) {
    const cfg = new VolumeConfig();
    if (!params || (typeof params === 'object' && Object.keys(params).length === 0)) return cfg;  // `if not params`
    for (const [k, v] of Object.entries(params)) {
      if (!CONFIG_FIELDS.has(k) || v === null || v === undefined) continue;   // hasattr / `v is None`
      const type = FIELD_TYPE[k];
      try {
        if (type === 'bool') cfg[k] = pyBool(v);
        else if (type === 'int') cfg[k] = pyInt(v);
        else if (type === 'float') cfg[k] = pyFloat(v);
        else if (type === 'str') cfg[k] = pyLower(pyStrip(pyStr(v)));   // str(v).strip().lower()
      } catch (e) {
        if (e instanceof PyValueError) continue;
        throw e;
      }
    }
    cfg.fix();
    return cfg;
  }

  /** `_fix()` — protection against invalid combinations (same 25 steps, same order). */
  fix() {
    if (this.ma_type !== 'sma' && this.ma_type !== 'ema') this.ma_type = 'sma';          // (1)
    this.ma_fast = pyMax(2, this.ma_fast);                                               // (2)
    if (this.ma_mid <= this.ma_fast) this.ma_mid = this.ma_fast * 2;                        // (3)
    if (this.ma_slow <= this.ma_mid) this.ma_slow = pyMax(50, this.ma_mid * 2);          // (4)
    this.ema_mid = pyMax(5, this.ema_mid);                                               // (5)
    if (this.ema_trend <= this.ema_mid) this.ema_trend = pyMax(200, this.ema_mid * 2);   // (6)
    if (this.ma_slow >= this.ema_trend) this.ema_trend = pyMax(200, this.ma_slow * 2);   // (7)
    this.cross_lookback = pyMin(5, pyMax(1, this.cross_lookback));                    // (8)
    this.turn_period = pyMax(3, this.turn_period);                                       // (9)
    this.turn_lookback = pyMax(2, this.turn_lookback);                                   // (10)
    this.turn_slope_bars = pyMin(5, pyMax(1, this.turn_slope_bars));                  // (11)
    this.turn_min_slope_atr = pyMax(0.0, this.turn_min_slope_atr);                       // (12)
    this.bounce_tol_atr = pyMax(0.0, this.bounce_tol_atr);                               // (13)
    this.vol_len = pyMax(3, this.vol_len);                                               // (14)
    this.vol_mult = pyMax(0.5, this.vol_mult);                                           // (15)
    this.bounce_vol_mult = pyMax(0.3, this.bounce_vol_mult);                             // (16)
    if (this.climax_mult <= this.vol_mult) this.climax_mult = pyRound(this.vol_mult + 2.0, 2); // (17)
    this.extension_atr = pyMax(0.5, this.extension_atr);                                 // (18)
    this.htf_ema = pyMax(5, this.htf_ema);                                               // (19)
    this.swing_lookback = pyMax(2, this.swing_lookback);                                 // (20)
    this.sl_buffer_atr = pyMax(0.0, this.sl_buffer_atr);                                 // (21)
    this.tp1_rr = pyMax(1.0, this.tp1_rr);                                               // (22) [VOL-TP1-FLOOR]
    if (this.tp2_rr <= this.tp1_rr) this.tp2_rr = pyRound(this.tp1_rr + 0.5, 2);            // (23)
    if (this.tp3_rr <= this.tp2_rr) this.tp3_rr = pyRound(this.tp2_rr + 0.5, 2);            // (24)
    this.min_quality = pyMin(5, pyMax(1, this.min_quality));                          // (25)
  }

  /** dataclasses.replace(cfg, **overrides): a copy with the overrides, no fix. */
  replace(overrides = {}) {
    const out = new VolumeConfig();
    for (const name of FIELD_NAMES) out[name] = this[name];
    for (const k of Object.keys(overrides)) {
      if (!CONFIG_FIELDS.has(k)) throw new TypeError(`VolumeConfig.replace: unexpected field '${k}'`);
      out[k] = overrides[k];
    }
    return out;
  }

  /** asdict(): plain object in field order. */
  toDict() {
    const d = {};
    for (const name of FIELD_NAMES) d[name] = this[name];
    return d;
  }

  /** `[k for k in SETUP_KEYS if setup_<k>]` (this order). */
  setupsEnabled() {
    return SETUP_KEYS.filter((k) => this[`setup_${k}`]);
  }

  maPrefix() {
    return this.ma_type === 'ema' ? 'EMA' : 'SMA';
  }

  /** Parameters without the user preferences (for the "genome vs default" label). */
  paramsDict() {
    const d = this.toDict();
    for (const k of USER_PREF_KEYS) delete d[k];
    return d;
  }
}

/** Bars required for a correct computation (EMA_trend + windows). */
function minBars(cfg) {
  const extra = Math.max(cfg.vol_len, cfg.swing_lookback, BOUNCE_LOOKBACK,
    cfg.turn_lookback + cfg.turn_slope_bars + 2);
  return Math.trunc(Math.max(cfg.ema_trend, cfg.ma_slow, cfg.turn_period) + extra + 5);
}

module.exports = {
  STRATEGY_NAME, SETUP_KEYS, RIBBON_SPANS, RIBBON_LOOKBACK, RIBBON_MIN_ORDER, USER_PREF_KEYS,
  BOUNCE_LOOKBACK, GOLDEN_VOL_MIN, CLIMAX_MOVE_ATR, HTF_SLOPE_BARS, SL_RECENT_BARS,
  FIELDS, FIELD_NAMES, FIELD_TYPE, DEFAULTS, CONFIG_FIELDS,
  VolumeConfig, minBars,
  pyBool, pyInt, pyFloat, pyStr, PyValueError, PyOverflowError,
};
