/**
 * volumeCfgShim — the user-config surface of the bot's `VolumeConfig`
 * (volume_strategy.py, strategy-volume.md §2.3–§3.1): the 39 fields with
 * their defaults, `from_params` coercion, the 27-step `_fix()` and the
 * helpers the settings layer needs (setups_enabled, ma_prefix, params_dict).
 * [VOL-MIN-VOLUME 2026-10] `defaults()` (= `VolumeConfig()`, `__post_init__`) and `fix()` raise
 * bounce_vol_mult / ribbon_vol_mult to the setup volume floor through the engine's own
 * strategies/volume/quality.js (one implementation); [VOL-MIN-SL] adds `min_sl_pct_15m`.
 *
 * ┌────────────────────────────────────────────────────────────────────────┐
 * │ HOOK(M2): the VOLUME engine (backend/strategies/volume/config.js) owns  │
 * │ the authoritative VolumeConfig. Once it is merged, plug it in through   │
 * │ `useEngineConfig(mod)` (or make `resolveImpl()` require it) — the       │
 * │ contract is {fromParams(params) → cfg, toDict(cfg) → object,            │
 * │ defaults() → cfg, USER_PREF_KEYS, SETUP_KEYS}. Until then this shim is  │
 * │ the implementation, written from the spec and pinned by tests.         │
 * └────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const { pyInt, pyFloat, pyBool } = require('./pycoerce');
const { pyLower, pyStrip } = require('../../strategies/common/pyUnicode');   // CPython 3.11 str case / whitespace methods
const { pyMax, pyMin } = require('../../strategies/common/pyround');   // builtin max()/min(): a NaN 2nd argument is ignored
const quality = require('../../strategies/volume/quality');            // [VOL-MIN-SL] / [VOL-MIN-VOLUME] 2026-10

const SETUP_KEYS = Object.freeze(['cross', 'turn', 'bounce', 'golden', 'ribbon']);
// UI preferences — genome / reset never touch them (keep_prefs).
const USER_PREF_KEYS = Object.freeze(['setup_cross', 'setup_turn', 'setup_bounce', 'setup_golden', 'setup_ribbon', 'use_htf']);

// [name, pyType, default] — dataclass order (= json.dumps key order).
const FIELDS = Object.freeze([
  ['setup_cross', 'bool', true],
  ['setup_turn', 'bool', true],
  ['setup_bounce', 'bool', true],
  ['setup_golden', 'bool', true],
  ['setup_ribbon', 'bool', true],
  ['ribbon_vol_mult', 'float', 1.0],
  ['ma_type', 'str', 'sma'],
  ['ma_fast', 'int', 10],
  ['ma_mid', 'int', 20],
  ['ma_slow', 'int', 50],
  ['ema_mid', 'int', 50],
  ['ema_trend', 'int', 200],
  ['trend_filter', 'bool', true],
  ['cross_lookback', 'int', 2],
  ['turn_period', 'int', 20],
  ['turn_lookback', 'int', 5],
  ['turn_slope_bars', 'int', 2],
  ['turn_min_slope_atr', 'float', 0.05],
  ['bounce_tol_atr', 'float', 0.25],
  ['bounce_vol_mult', 'float', 1.0],
  ['vol_len', 'int', 20],
  ['vol_mult', 'float', 1.5],
  ['climax_mult', 'float', 4.5],
  ['extension_atr', 'float', 2.5],
  ['rsi_period', 'int', 14],
  ['rsi_long_max', 'float', 70.0],
  ['rsi_short_min', 'float', 30.0],
  ['atr_period', 'int', 14],
  ['use_htf', 'bool', true],
  ['htf_ema', 'int', 50],
  ['sl_atr_mult', 'float', 2.0],
  ['sl_buffer_atr', 'float', 0.25],
  ['swing_lookback', 'int', 10],
  ['max_sl_pct', 'float', 4.0],
  ['min_sl_pct_15m', 'float', 1.0],          // [VOL-MIN-SL 2026-10]
  ['tp1_rr', 'float', 1.0],
  ['tp2_rr', 'float', 2.0],
  ['tp3_rr', 'float', 3.0],
  ['min_quality', 'int', 3],
]);

const FIELD_NAMES = Object.freeze(FIELDS.map((f) => f[0]));
const FIELD_TYPES = Object.freeze(Object.fromEntries(FIELDS.map((f) => [f[0], f[1]])));
const DEFAULTS = Object.freeze(Object.fromEntries(FIELDS.map((f) => [f[0], f[2]])));
const FLOAT_KEYS = Object.freeze(FIELDS.filter((f) => f[1] === 'float').map((f) => f[0]));
const CONFIG_FIELDS = new Set(FIELD_NAMES);

/** VolumeConfig(): the dataclass defaults + __post_init__ ([VOL-MIN-VOLUME] floor). */
function defaults() {
  return quality.applySetupVolFloor({ ...DEFAULTS });
}

/** Python round(x, 2) for the values _fix produces (x + 0.5 / x + 2.0 — exact in binary). */
function round2(x) {
  return Math.round(x * 100) / 100;
}

/** VolumeConfig._fix() — exact order (strategy-volume.md §3.1 steps 1–25 + the batch-D steps 21a / 21b). */
function fix(cfg) {
  if (cfg.ma_type !== 'sma' && cfg.ma_type !== 'ema') cfg.ma_type = 'sma';
  cfg.ma_fast = pyMax(2, cfg.ma_fast);
  if (cfg.ma_mid <= cfg.ma_fast) cfg.ma_mid = cfg.ma_fast * 2;
  if (cfg.ma_slow <= cfg.ma_mid) cfg.ma_slow = pyMax(50, cfg.ma_mid * 2);
  cfg.ema_mid = pyMax(5, cfg.ema_mid);
  if (cfg.ema_trend <= cfg.ema_mid) cfg.ema_trend = pyMax(200, cfg.ema_mid * 2);
  if (cfg.ma_slow >= cfg.ema_trend) cfg.ema_trend = pyMax(200, cfg.ma_slow * 2);
  cfg.cross_lookback = pyMin(5, pyMax(1, cfg.cross_lookback));
  cfg.turn_period = pyMax(3, cfg.turn_period);
  cfg.turn_lookback = pyMax(2, cfg.turn_lookback);
  cfg.turn_slope_bars = pyMin(5, pyMax(1, cfg.turn_slope_bars));
  cfg.turn_min_slope_atr = pyMax(0.0, cfg.turn_min_slope_atr);
  cfg.bounce_tol_atr = pyMax(0.0, cfg.bounce_tol_atr);
  cfg.vol_len = pyMax(3, cfg.vol_len);
  cfg.vol_mult = pyMax(0.5, cfg.vol_mult);
  cfg.bounce_vol_mult = pyMax(0.3, cfg.bounce_vol_mult);
  if (cfg.climax_mult <= cfg.vol_mult) cfg.climax_mult = round2(cfg.vol_mult + 2.0);
  cfg.extension_atr = pyMax(0.5, cfg.extension_atr);
  cfg.htf_ema = pyMax(5, cfg.htf_ema);
  cfg.swing_lookback = pyMax(2, cfg.swing_lookback);
  cfg.sl_buffer_atr = pyMax(0.0, cfg.sl_buffer_atr);
  if (!Number.isFinite(cfg.min_sl_pct_15m) || cfg.min_sl_pct_15m < 0) cfg.min_sl_pct_15m = 0.0;   // [VOL-MIN-SL]
  quality.applySetupVolFloor(cfg);                                                                // [VOL-MIN-VOLUME]
  cfg.tp1_rr = pyMax(1.0, cfg.tp1_rr);
  if (cfg.tp2_rr <= cfg.tp1_rr) cfg.tp2_rr = round2(cfg.tp1_rr + 0.5);
  if (cfg.tp3_rr <= cfg.tp2_rr) cfg.tp3_rr = round2(cfg.tp2_rr + 0.5);
  cfg.min_quality = pyMin(5, pyMax(1, cfg.min_quality));
  return cfg;
}

/**
 * VolumeConfig.from_params(params): per-key coercion by the default's type
 * (bool: strings → {"1","true","yes","on"}, else bool(v); int: int(v);
 * float: float(v); str: str(v).strip().lower()); unknown keys and None
 * values ignored; TypeError/ValueError → key skipped; then _fix().
 */
function fromParams(params) {
  const cfg = defaults();
  if (!params || typeof params !== 'object') return cfg;
  for (const k of Object.keys(params)) {
    const v = params[k];
    if (!FIELD_TYPES[k] || v === null || v === undefined) continue;
    try {
      switch (FIELD_TYPES[k]) {
        case 'bool':
          cfg[k] = typeof v === 'string' ? ['1', 'true', 'yes', 'on'].includes(pyLower(pyStrip(v))) : pyBool(v);
          break;
        case 'int':
          cfg[k] = pyInt(v);
          break;
        case 'float':
          cfg[k] = pyFloat(v);
          break;
        default:
          cfg[k] = pyLower(pyStrip(String(v)));
      }
    } catch (_e) {
      // Python: `except (TypeError, ValueError): continue`
    }
  }
  return fix(cfg);
}

/** VolumeConfig.to_dict() = asdict(self) (dataclass order). */
function toDict(cfg) {
  const out = {};
  for (const name of FIELD_NAMES) out[name] = cfg[name];
  return out;
}

function setupsEnabled(cfg) {
  return SETUP_KEYS.filter((k) => cfg[`setup_${k}`]);
}

function maPrefix(cfg) {
  return cfg.ma_type === 'ema' ? 'EMA' : 'SMA';
}

/** to_dict() minus the six preference keys (genome comparison). */
function paramsDict(cfg) {
  const d = toDict(cfg);
  for (const k of USER_PREF_KEYS) delete d[k];
  return d;
}

// ── implementation hook ─────────────────────────────────────────────────
const SHIM = Object.freeze({ fromParams, toDict, defaults, fix, USER_PREF_KEYS, SETUP_KEYS, FLOAT_KEYS, FIELD_NAMES, setupsEnabled });
let _impl = SHIM;

/**
 * HOOK(M2): plug the engine's VolumeConfig module in (same contract as SHIM).
 * Pass null to go back to the shim. Returns the active implementation.
 */
function useEngineConfig(mod) {
  if (mod === null || mod === undefined) {
    _impl = SHIM;
  } else {
    for (const fn of ['fromParams', 'toDict', 'defaults']) {
      if (typeof mod[fn] !== 'function') throw new TypeError(`volume config module must export ${fn}()`);
    }
    _impl = { ...SHIM, ...mod };
  }
  return _impl;
}

function impl() {
  return _impl;
}

module.exports = {
  FIELDS, FIELD_NAMES, FIELD_TYPES, DEFAULTS, FLOAT_KEYS, CONFIG_FIELDS, SETUP_KEYS, USER_PREF_KEYS,
  defaults, fix, fromParams, toDict, setupsEnabled, maPrefix, paramsDict,
  useEngineConfig, impl, SHIM,
};
