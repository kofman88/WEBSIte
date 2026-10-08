'use strict';
/**
 * mdLog.js — tiny leveled logger for the market-data layer.
 *
 * The bot logs through `logging.getLogger("CHM.*")`; here every module takes an
 * optional `log` and falls back to this one. `setLogger(winston)` plugs the site
 * logger in at worker start-up without making the pure modules require
 * `utils/logger` (which opens file transports and reads the env at import time).
 */

const LEVELS = { debug: 10, info: 20, warning: 30, warn: 30, error: 40, silent: 100 };

let _impl = null;
let _level = LEVELS[(process.env.MARKET_LOG_LEVEL || (process.env.VITEST ? 'silent' : 'info')).toLowerCase()] ?? LEVELS.info;

function _emit(level, args) {
  if (_impl) {
    const fn = _impl[level === 'warning' ? 'warn' : level] || _impl.info;
    try { fn.call(_impl, ...args); } catch (_e) { /* logger must never throw */ }
    return;
  }
  if ((LEVELS[level] ?? 0) < _level) return;
  const out = level === 'error' || level === 'warning' ? console.error : console.log;
  out(`[marketData:${level}]`, ...args);
}

const log = {
  debug: (...a) => _emit('debug', a),
  info: (...a) => _emit('info', a),
  warning: (...a) => _emit('warning', a),
  warn: (...a) => _emit('warning', a),
  error: (...a) => _emit('error', a),
};

/** Plug an external logger (winston-like: debug/info/warn/error). `null` restores the console one. */
function setLogger(impl) { _impl = impl || null; }
function setLevel(name) { _level = LEVELS[String(name).toLowerCase()] ?? _level; }
/** A logger that swallows everything (tests). */
const silent = { debug() {}, info() {}, warning() {}, warn() {}, error() {} };

module.exports = { log, setLogger, setLevel, silent, LEVELS };
