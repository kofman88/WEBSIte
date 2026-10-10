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
const { pyLower } = require('../strategies/common/pyUnicode');   // CPython 3.11 str case / whitespace methods
const volCfg = require('../strategies/volume/config');             // unflooredVolValues / keepPreFloorValues
const quality = require('../strategies/volume/quality');           // [VOL-MIN-VOLUME] setup_vol_floor

const KV_CFG_PREFIX = 'volume_cfg_';          // kv: volume_cfg_<uid> → JSON of the full config
const ALLOWED_TFS = Object.freeze(['15m', '1h', '4h']);
const DEFAULT_TF = '1h';

function impl() {
  return shim.impl();
}

/** volume_scanner.user_tf(user) */
function userTf(user) {
  const tf = pyLower(String((user && user.vol_timeframe) || DEFAULT_TF));
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
 * written — with the [VOL-MIN-VOLUME 2026-10] storage rule of the bot: kv keeps
 * the user's / genome's own (pre-floor) bounce_vol_mult / ribbon_vol_mult, a full
 * to_dict() round trip (every UI save: settings/all, profiles) does not turn the
 * floor echoed back into a stored choice, and the system threshold
 * min_sl_pct_15m is never stored ([VOL-MIN-SL]).
 */
function saveUserCfg(userId, params, keepPrefs = true) {
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const p = { ...(params || {}) };
  // CONFIG_FIELDS ⊆ params, on the incoming dict (before the pref merge below)
  const roundtrip = (impl().FIELD_NAMES || shim.FIELD_NAMES).every((k) => own(p, k));
  const prefKeys = impl().USER_PREF_KEYS || shim.USER_PREF_KEYS;
  if (keepPrefs && prefKeys.some((k) => !own(p, k))) {
    const cur = loadUserCfg(userId);
    for (const k of prefKeys) if (!own(p, k)) p[k] = cur[k];
  }
  const cfg = impl().fromParams(p);
  const data = impl().toDict(cfg);
  const unfl = volCfg.unflooredVolValues(p);
  const fl = quality.setupVolFloor();
  if (roundtrip && fl > 0) {
    let stored = null;
    try {
      const raw = kv.get(kvKey(userId));
      const st = raw ? require('./engine/signalTradesRepo').pyLoads(raw) : {};
      stored = volCfg.unflooredVolValues(st !== null && typeof st === 'object' && !Array.isArray(st) ? st : {});
    } catch (e) {
      logger.warn(`[VOL-MIN-VOLUME] save_user_cfg uid=${userId}: stored kv unreadable (${e && e.message ? e.message : e}) — floored values written`);
      stored = null;
    }
    if (stored !== null) volCfg.keepPreFloorValues(unfl, stored, fl);
  }
  Object.assign(data, unfl);
  for (const k of volCfg.SYSTEM_CFG_KEYS) delete data[k];
  kv.set(kvKey(userId), pyJsonDumps(data, impl().FLOAT_KEYS || shim.FLOAT_KEYS));
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
