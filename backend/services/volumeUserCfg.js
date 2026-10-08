/**
 * volumeUserCfg — per-user VOLUME strategy parameters in engine_kv
 * (`volume_cfg_<uid>`), one-to-one with volume_scanner.py
 * `user_tf / load_user_cfg / save_user_cfg(keep_prefs) / reset_user_cfg`
 * (strategy-volume.md §2.3).
 *
 * The VolumeConfig coercion (`from_params` + `_fix`) comes from
 * services/engine/volumeCfgShim.js until the engine's own module is plugged
 * in through `volumeCfgShim.useEngineConfig()` — see the HOOK there.
 */

'use strict';

const kv = require('./engineKvService');
const shim = require('./engine/volumeCfgShim');
const { pyJsonDumps } = require('./engine/pyjson');
const logger = require('../utils/logger');

const KV_CFG_PREFIX = 'volume_cfg_';          // kv: volume_cfg_<uid> → JSON of the full config
const ALLOWED_TFS = Object.freeze(['15m', '1h', '4h']);
const DEFAULT_TF = '1h';

function impl() {
  return shim.impl();
}

/** volume_scanner.user_tf(user) */
function userTf(user) {
  const tf = String((user && user.vol_timeframe) || DEFAULT_TF).toLowerCase();
  return ALLOWED_TFS.includes(tf) ? tf : DEFAULT_TF;
}

function kvKey(userId) {
  return KV_CFG_PREFIX + String(userId);
}

/** json.dumps(cfg.to_dict()) with the bot's float formatting. */
function serialize(cfg) {
  const d = impl().toDict(cfg);
  return pyJsonDumps(d, impl().FLOAT_KEYS || shim.FLOAT_KEYS);
}

/** load_user_cfg(uid): kv → from_params; missing → defaults; any error → warning + defaults. */
function loadUserCfg(userId) {
  try {
    const raw = kv.get(kvKey(userId));
    if (raw) return impl().fromParams(JSON.parse(raw));
  } catch (e) {
    logger.warn(`[VOLUME-CFG] load_user_cfg uid=${userId}: ${e.message} — используем дефолт`);
  }
  return impl().defaults();
}

/**
 * save_user_cfg(uid, params, keep_prefs=True): `params` may be partial. With
 * keep_prefs, pref keys missing from params are copied from the user's
 * current config (so applying a genome keeps the chosen setups); then
 * from_params (defaults for everything else + _fix) and the full dict is
 * written.
 */
function saveUserCfg(userId, params, keepPrefs = true) {
  const p = { ...(params || {}) };
  const prefKeys = impl().USER_PREF_KEYS || shim.USER_PREF_KEYS;
  if (keepPrefs && prefKeys.some((k) => !Object.prototype.hasOwnProperty.call(p, k))) {
    const cur = loadUserCfg(userId);
    for (const k of prefKeys) if (!Object.prototype.hasOwnProperty.call(p, k)) p[k] = cur[k];
  }
  const cfg = impl().fromParams(p);
  kv.set(kvKey(userId), serialize(cfg));
  return cfg;
}

/**
 * reset_user_cfg(uid, keep_prefs=True): back to defaults; with keep_prefs the
 * pref keys that differ from the default survive (stored as defaults + prefs).
 */
function resetUserCfg(userId, keepPrefs = true) {
  let prefs = {};
  if (keepPrefs) {
    const cur = loadUserCfg(userId);
    const dflt = impl().defaults();
    const prefKeys = impl().USER_PREF_KEYS || shim.USER_PREF_KEYS;
    prefs = Object.fromEntries(prefKeys.filter((k) => cur[k] !== dflt[k]).map((k) => [k, cur[k]]));
  }
  kv.del(kvKey(userId));
  if (Object.keys(prefs).length) saveUserCfg(userId, prefs, false);
}

module.exports = { KV_CFG_PREFIX, ALLOWED_TFS, DEFAULT_TF, userTf, kvKey, serialize, loadUserCfg, saveUserCfg, resetUserCfg };
