/**
 * pyjson — `json.dumps(obj)` with Python's defaults, so the JSON strings the
 * site writes into trader_settings (long_cfg / short_cfg / smc_cfg /
 * ai_filter_settings) and engine_kv (volume_cfg_<uid>) are byte-identical to
 * what the bot writes for the same values:
 *
 *   • separators (", ", ": "), insertion order kept, ensure_ascii=True
 *     (non-ASCII escaped as \uXXXX, surrogate pairs for astral characters);
 *   • Python floats print with repr() — `1.0`, `300000.0`, `1e-05` — and ints
 *     without a fractional part. JS has one number type, so the caller names
 *     the keys that hold Python *floats* (`floatKeys`); every other integral
 *     number prints as an int, non-integral numbers always print as floats.
 *
 * Also the inverse helper `pyJsonLoads` (= JSON.parse that never throws for
 * callers that want the bot's "on any error → {}" behaviour).
 */

'use strict';

const { pyRepr } = require('../../strategies/common/pyfmt');

function escapeString(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const code = s.charCodeAt(i);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (code < 0x20 || code > 0x7e) out += '\\u' + code.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}

function dumpNumber(n, isFloat) {
  if (!Number.isFinite(n)) {
    // json.dumps(float("inf")) → Infinity / NaN (allow_nan=True default)
    if (Number.isNaN(n)) return 'NaN';
    return n > 0 ? 'Infinity' : '-Infinity';
  }
  if (isFloat || !Number.isInteger(n)) return pyRepr(n);
  return String(n);
}

/**
 * @param {*} value   dict / list / str / number / bool / null
 * @param {Iterable<string>|null} floatKeys  keys whose numeric values are Python floats
 */
function pyJsonDumps(value, floatKeys = null) {
  const floats = floatKeys ? new Set(floatKeys) : null;
  const walk = (v, key) => {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return dumpNumber(v, Boolean(floats && key !== null && floats.has(key)));
    if (typeof v === 'string') return escapeString(v);
    if (Array.isArray(v)) return '[' + v.map((x) => walk(x, null)).join(', ') + ']';
    if (typeof v === 'object') {
      const parts = [];
      for (const k of Object.keys(v)) parts.push(escapeString(String(k)) + ': ' + walk(v[k], k));
      return '{' + parts.join(', ') + '}';
    }
    return escapeString(String(v));
  };
  return walk(value, null);
}

/** JSON.parse with the bot's tolerance: not a string / empty / invalid → fallback. */
function pyJsonLoads(text, fallback = {}) {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(String(text));
  } catch (_e) {
    return fallback;
  }
}

module.exports = { pyJsonDumps, pyJsonLoads };
