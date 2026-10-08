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
 * Also the inverse helpers `pyJsonParse` (json.loads: NaN / Infinity literals, `-0` is the int 0)
 * and `pyJsonLoads` (the same, never throwing, for the bot's "on any error → {}" behaviour).
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

/**
 * json.loads(text) for a str: JSON.parse plus the NaN / Infinity / -Infinity literals Python's
 * json module reads where a value is expected. Throws SyntaxError wherever json.loads raises
 * (a literal used as an object key, `-NaN`, `1NaN`, … stay errors). The int literal `-0` is the
 * int 0 in Python (only `-0.0` is a negative zero); JSON.parse gives -0 for both, so the reviver
 * reads the literal's source text (Node ≥ 21) to tell them apart.
 */
const NEG_ZERO_INT_RE = /-0(?![.\deE])/;
const intZero = (v, ctx) => (Object.is(v, -0) && ctx && ctx.source === '-0' ? 0 : v);

function pyJsonParse(text) {
  const src = String(text);
  if (!/NaN|Infinity/.test(src)) return NEG_ZERO_INT_RE.test(src) ? JSON.parse(src, (k, v, ctx) => intZero(v, ctx)) : JSON.parse(src);
  const tag = `\u0001pyjson${Math.random().toString(36).slice(2)}\u0001`;
  const lit = { NaN: NaN, Infinity: Infinity, '-Infinity': -Infinity };
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"') {                                  // copy a string literal untouched
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const m = /^(-Infinity|Infinity|NaN)/.exec(src.slice(i, i + 9));
    if (m) {
      out += JSON.stringify(tag + m[1]);
      i += m[1].length;
      continue;
    }
    out += ch;
    i += 1;
  }
  return JSON.parse(out, (k, v, ctx) => {
    if (k.startsWith(tag)) throw new SyntaxError('Expecting property name enclosed in double quotes');
    return typeof v === 'string' && v.startsWith(tag) ? lit[v.slice(tag.length)] : intZero(v, ctx);
  });
}

/** json.loads with the bot's tolerance (`except Exception: return fallback`): not a string / empty / invalid → fallback. */
function pyJsonLoads(text, fallback = {}) {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return pyJsonParse(String(text));     // NaN / Infinity literals like json.loads
  } catch (_e) {
    return fallback;
  }
}

module.exports = { pyJsonDumps, pyJsonLoads, pyJsonParse };
