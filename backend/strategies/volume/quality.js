'use strict';
/**
 * quality.js — the VOLUME entry-quality thresholds of the bot's batch D (volume_strategy.py,
 * [VOL-MIN-SL 2026-10] / [VOL-MIN-VOLUME 2026-10]), one-to-one:
 *
 *   envNumber(name, marker)        env_number: unset / blank → null; float(raw.strip()) finite → it;
 *                                  not a number / nan / inf → null + ONE WARNING per (name, raw)
 *   setupVolFloor()                setup_vol_floor: VOLUME_MIN_SETUP_VOL_MULT (default 1.5), ≤ 0 → 0 (off)
 *   goldenVolMin()                 golden_vol_min: max(1.0, floor) — golden / death cross volume threshold
 *   minSlPctFor(cfg, timeframe)    min_sl_pct_for: 15m only; env VOLUME_MIN_SL_PCT_15M over
 *                                  cfg.min_sl_pct_15m (default 1.0); ≤ 0 / non-finite → 0 (off)
 *   applySetupVolFloor(cfg)        VolumeConfig._apply_setup_vol_floor: bounce_vol_mult / ribbon_vol_mult
 *                                  raised to the floor (non-finite → the floor), one INFO line per
 *                                  (field, old value, floor) and process
 *
 * The environment is read on every call (like os.environ in the bot: a changed env applies to new
 * configs / checks without a restart). Log lines go to the bot's "CHM.VolumeStrategy" logger: by
 * default the market-data logger (services/marketData/mdLog, plugged into the site logger by the
 * engine worker), `setLog()` replaces it (tests).
 */

const N = require('../common/pynum');
const { pyStrip, pyLower, pyStrRepr } = require('../common/pyUnicode');
const { pyRepr } = require('../common/pyfmt');
const { pyMax } = require('../common/pyround');

const MIN_SL_TF = '15m';                                  // [VOL-MIN-SL] the TF of the stop floor
const ENV_MIN_SL_PCT_15M = 'VOLUME_MIN_SL_PCT_15M';
const ENV_MIN_SETUP_VOL_MULT = 'VOLUME_MIN_SETUP_VOL_MULT';
const DEFAULT_MIN_SETUP_VOL_MULT = 1.5;                   // [VOL-MIN-VOLUME] ribbon / bounce / golden ≥ ×1.5
const FLOORED_VOL_FIELDS = Object.freeze(['bounce_vol_mult', 'ribbon_vol_mult']);
const GOLDEN_VOL_MIN_BASE = 1.0;                          // volume_strategy._GOLDEN_VOL_MIN
/** The four batch-D env names of the VOLUME strategy + scanner (tests clear them for determinism). */
const ENV_NAMES = Object.freeze([ENV_MIN_SL_PCT_15M, ENV_MIN_SETUP_VOL_MULT, 'VOLUME_15M_COINS_FLOOR_USDT',
  'VOLUME_POST_SL_PAUSE_BARS']);

let _env = null;            // null → process.env
let _log = null;            // null → mdLog
const _envWarned = new Set();      // _ENV_WARNED
const _floorLogged = new Set();    // _FLOOR_LOGGED

function env() {
  return _env || process.env;
}

function log() {
  return _log || require('../../services/marketData/mdLog').log;
}

/** Python float(v) for the values a config / env can hold; throws where CPython raises. */
function toFloat(v) {
  if (typeof v === 'boolean') return v ? 1.0 : 0.0;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') {
    const x = N.floatFromStr(v);
    if (x === undefined) throw new TypeError(N.floatErrorText(v));
    return x;
  }
  throw new TypeError(`float() argument must be a string or a real number, not '${v === null || v === undefined ? 'NoneType' : typeof v}'`);
}

/** Python truthiness of a scalar (`x or default`). */
function truthy(v) {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  if (typeof v === 'bigint') return v !== 0n;
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === 'object') return Object.keys(v).length > 0;
  return true;   // NaN is truthy in Python
}

/** env_number(name, marker): a finite number from the env or null (see the header). */
function envNumber(name, marker) {
  const raw = env()[name];
  if (raw === undefined || raw === null || !pyStrip(String(raw))) return null;
  const x = N.floatFromStr(pyStrip(String(raw)));
  if (x !== undefined && Number.isFinite(x)) return x;
  const key = `${name}\u0000${String(raw)}`;
  if (!_envWarned.has(key)) {
    _envWarned.add(key);
    log().warning(`${marker} env ${name}=${pyStrRepr(String(raw))} → not a number, using the default`);
  }
  return null;
}

/** setup_vol_floor(): the minimum signal-bar volume (× average) of ribbon / bounce / golden; 0 = off. */
function setupVolFloor() {
  let v = envNumber(ENV_MIN_SETUP_VOL_MULT, '[VOL-MIN-VOLUME]');
  if (v === null) v = DEFAULT_MIN_SETUP_VOL_MULT;
  return v > 0 ? v : 0.0;
}

/** golden_vol_min(): max(1.0, setup_vol_floor()). */
function goldenVolMin() {
  return pyMax(GOLDEN_VOL_MIN_BASE, setupVolFloor());
}

/** min_sl_pct_for(cfg, timeframe): the stop floor in % of the entry for the signal TF (15m only). */
function minSlPctFor(cfg, timeframe) {
  if (pyLower(pyStrip(String(truthy(timeframe) ? timeframe : ''))) !== MIN_SL_TF) return 0.0;
  let v = envNumber(ENV_MIN_SL_PCT_15M, '[VOL-MIN-SL]');
  if (v === null) {
    const raw = cfg !== null && cfg !== undefined && cfg.min_sl_pct_15m !== undefined ? cfg.min_sl_pct_15m : 0.0;
    try {
      v = toFloat(truthy(raw) ? raw : 0.0);
    } catch (_e) {
      v = 0.0;
    }
  }
  return Number.isFinite(v) && v > 0 ? v : 0.0;
}

/** VolumeConfig._apply_setup_vol_floor(): mutates `cfg` (a VolumeConfig or a plain config dict). */
function applySetupVolFloor(cfg) {
  const fl = setupVolFloor();
  if (fl <= 0) return cfg;
  for (const name of FLOORED_VOL_FIELDS) {
    let cur;
    try {
      cur = toFloat(cfg[name]);
    } catch (_e) {
      continue;
    }
    if (!Number.isFinite(cur) || cur < fl) {
      cfg[name] = fl;
      // the tuple (name, cur, fl) of the bot: -0.0 == 0.0 in Python
      const key = `${name}\u0000${pyRepr(cur === 0 ? 0 : cur)}\u0000${pyRepr(fl)}`;
      if (!_floorLogged.has(key)) {
        _floorLogged.add(key);
        log().info(`[VOL-MIN-VOLUME] ${name} ${pyRepr(cur)} → ${pyRepr(fl)} (floor ${ENV_MIN_SETUP_VOL_MULT}=${pyRepr(fl)}; `
          + `golden ≥ ×${pyRepr(goldenVolMin())})`);
      }
    }
  }
  return cfg;
}

/** math.isclose(a, b) with the defaults rel_tol=1e-09, abs_tol=0.0. */
function pyIsclose(a, b) {
  if (a === b) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const diff = Math.abs(b - a);
  return diff <= Math.abs(1e-9 * b) || diff <= Math.abs(1e-9 * a);
}

/** Tests / wiring: the env source (null → process.env) and the "CHM.VolumeStrategy" logger. */
function setEnv(e) { _env = e || null; }
function setLog(l) { _log = l || null; }
/** Forget the once-per-process warning / floor-log state (a fresh bot process). */
function _resetForTests() {
  _envWarned.clear();
  _floorLogged.clear();
}

module.exports = {
  MIN_SL_TF, ENV_MIN_SL_PCT_15M, ENV_MIN_SETUP_VOL_MULT, DEFAULT_MIN_SETUP_VOL_MULT, FLOORED_VOL_FIELDS,
  GOLDEN_VOL_MIN_BASE, ENV_NAMES,
  envNumber, setupVolFloor, goldenVolMin, minSlPctFor, applySetupVolFloor, pyIsclose, toFloat,
  setEnv, setLog, _resetForTests,
};
