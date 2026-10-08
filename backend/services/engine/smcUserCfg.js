/**
 * smcUserCfg — the bot's `SMCUserCfg` dataclass (user_manager.py), stored as
 * JSON in trader_settings.smc_cfg (data-and-market.md §2.5).
 *
 *   • `fromJson(s)`  = SMCUserCfg.from_json: known keys only, values NOT coerced,
 *                      any parse error (or a non-object) → defaults
 *   • `toJson(cfg)`  = json.dumps(asdict(cfg)) (dataclass order)
 *   • `defaults()`   = SMCUserCfg()
 *
 * Pure. `users.smc_max_sl_pct` lives outside this JSON (a flat column).
 */

'use strict';

const { pyJsonDumps } = require('./pyjson');

// [name, pyType, default] — dataclass order.
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
const FLOAT_KEYS = Object.freeze(FIELDS.filter((f) => f[1] === 'float').map((f) => f[0]));

function defaults() {
  return { ...DEFAULTS };
}

function fromJson(s) {
  try {
    const d = JSON.parse(s || '{}');
    if (!d || typeof d !== 'object' || Array.isArray(d)) return defaults();
    const cfg = defaults();
    for (const k of Object.keys(d)) if (FIELD_TYPES[k]) cfg[k] = d[k];
    return cfg;
  } catch (_e) {
    return defaults();
  }
}

function toJson(cfg) {
  const ordered = {};
  for (const name of FIELD_NAMES) ordered[name] = cfg[name];
  return pyJsonDumps(ordered, FLOAT_KEYS);
}

/** UserSettings.get_smc_cfg() / set_smc_cfg() */
function getSmcCfg(user) {
  return fromJson(user.smc_cfg);
}

function setSmcCfg(user, cfg) {
  user.smc_cfg = toJson(cfg);
}

module.exports = { FIELDS, FIELD_NAMES, FIELD_TYPES, DEFAULTS, FLOAT_KEYS, defaults, fromJson, toJson, getSmcCfg, setSmcCfg };
