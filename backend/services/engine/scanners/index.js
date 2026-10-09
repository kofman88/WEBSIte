'use strict';
/**
 * scanners/index.js — lazy registry of the three strategy scanners, by the bot's names.
 *
 *   bot.py                                         site
 *   from scanner_mid import MidScanner             get('MidScanner')     → ../levelsScanner.js
 *   __import__("volume_scanner").run_volume_scanner get('VolumeScanner')  → ../volumeScanner.js
 *   from smc.scanner import run_smc_scanner        get('SmcScanner')     → ../smcScanner.js
 *
 * Each module is required on first use (never at import time: the scanners pull the strategy
 * engines and the market-data layer, which the main thread does not need). A module that is not
 * there (MODULE_NOT_FOUND for exactly that path) resolves to `null` — the bot's `_SMC_OK = False`
 * / `_WS_FEED_OK = False` pattern: the scheduler logs it and starts the other loops. Any other load
 * error (a syntax error, a throwing top level) propagates, like an ImportError inside the bot's
 * `_guarded_restart` factory.
 *
 * Contract the scheduler calls (camelCase of the Python signatures):
 *
 *   MidScanner      class: new MidScanner(config, bot, um, { stopEvent }) → .fetcher, ._health = health,
 *                   .runForever() (Promise; resolves on a clean stop, rejects on a crash)
 *   VolumeScanner   runVolumeScanner(bot, um, fetcher, { health, signal, intervalSec }) → Promise
 *   SmcScanner      runSmcScanner(bot, um, fetcher, { health, signal, intervalSec }) → Promise
 *
 * `bot` is the delivery facade (signalDelivery.createRemoteDelivery in the worker, the local
 * createSignalDelivery in-process): deliver(msg) → Promise<bool>, deliverChart(msg),
 * sendText(uid, text, opts) → Promise<bool>, alertAdmins(text), notifier { dispatch }, sse { broadcast }.
 *
 * Tests replace an entry with `_setOverride(name, moduleOrNull)`; `_reset()` drops overrides and
 * the memo.
 */

const path = require('path');

const REGISTRY = Object.freeze({
  MidScanner: Object.freeze({ file: '../levelsScanner', exports: Object.freeze(['MidScanner']), bot: 'scanner_mid.MidScanner' }),
  VolumeScanner: Object.freeze({ file: '../volumeScanner', exports: Object.freeze(['runVolumeScanner', 'VolumeScanner']), bot: 'volume_scanner.run_volume_scanner' }),
  SmcScanner: Object.freeze({ file: '../smcScanner', exports: Object.freeze(['runSmcScanner']), bot: 'smc.scanner.run_smc_scanner' }),
});

const _memo = new Map();       // name → module | null
const _overrides = new Map();  // name → module | null

function _resolvedPath(name) {
  return require.resolve(path.join(__dirname, REGISTRY[name].file));
}

/** True when the error is "this very module file does not exist" (not a missing dependency inside it). */
function _isOwnNotFound(err, name) {
  if (!err || err.code !== 'MODULE_NOT_FOUND') return false;
  const want = path.join(__dirname, REGISTRY[name].file);
  const msg = String(err.message || '');
  return msg.includes(`'${want}'`) || msg.includes(`"${want}"`) || msg.includes(want);
}

/** The scanner module for a bot name, or null when it is not installed. Unknown names throw. */
function loadModule(name) {
  if (!Object.prototype.hasOwnProperty.call(REGISTRY, name)) throw new Error(`unknown scanner: ${name}`);
  if (_overrides.has(name)) return _overrides.get(name);
  if (_memo.has(name)) return _memo.get(name);
  let mod = null;
  try {
    // eslint-disable-next-line global-require
    mod = require(_resolvedPath(name));
  } catch (e) {
    if (_isOwnNotFound(e, name)) mod = null;
    else throw e;
  }
  _memo.set(name, mod);
  return mod;
}

/**
 * The entry point: MidScanner → the class; VolumeScanner / SmcScanner → the run function.
 * A module that exports the function itself (module.exports = fn) is accepted as-is.
 */
function get(name) {
  const mod = loadModule(name);
  if (mod === null || mod === undefined) return null;
  if (typeof mod === 'function') return mod;
  for (const k of REGISTRY[name].exports) {
    if (typeof mod[k] === 'function') return mod[k];
  }
  return null;
}

function isAvailable(name) {
  return get(name) !== null;
}

/** Bot names with their module path and availability (diagnostics / the worker's ready message). */
function describe() {
  const out = {};
  for (const name of Object.keys(REGISTRY)) {
    let ok = false;
    let error = null;
    try { ok = isAvailable(name); } catch (e) { error = String(e && e.message); }
    out[name] = { file: `services/engine/${REGISTRY[name].file.replace('../', '')}.js`, bot: REGISTRY[name].bot, available: ok, error };
  }
  return out;
}

function _setOverride(name, mod) {
  if (!Object.prototype.hasOwnProperty.call(REGISTRY, name)) throw new Error(`unknown scanner: ${name}`);
  _overrides.set(name, mod === undefined ? null : mod);
}

function _reset() {
  _overrides.clear();
  _memo.clear();
}

module.exports = { REGISTRY, loadModule, get, isAvailable, describe, _setOverride, _reset };
