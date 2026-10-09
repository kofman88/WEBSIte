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
 * `pyJsonDumpsTyped(value, schema)` is the same with the Python types given per PATH (a key can
 * hold an int in one place and a float in another): the schema mirrors the value — FLOAT ('f') for a
 * Python float leaf, `{key: schema, '*': schema}` for a dict (the '*' entry for every other key),
 * `[schema]` for a list, `{ $tuple: [schema, …] }` for a fixed-position list; numbers the schema
 * leaves out are ints when integral (as pyJsonDumps). The web.json_response bodies of the Mini App
 * routes are written with it (routes/appData.js).
 *
 * `pyDict(entries)` is a Python dict for keys a JS object would reorder (integer-like keys such as
 * a "60" timeframe come first in every JS object) or swallow ("__proto__"): a null-prototype object
 * that remembers the insertion order for both serializers; `pyDictSet(d, k, v)` adds / replaces.
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

// ── ordered Python dicts ────────────────────────────────────────────────
const PY_KEYS = Symbol.for('chm.pyjson.keys');

/** Add or replace key `k` of a pyDict (a new key goes last, a known one keeps its place). */
function pyDictSet(d, k, v) {
  const key = String(k);
  if (Array.isArray(d[PY_KEYS]) && !Object.prototype.hasOwnProperty.call(d, key)) d[PY_KEYS].push(key);
  Object.defineProperty(d, key, { value: v, enumerable: true, writable: true, configurable: true });
  return d;
}

/** A Python dict from [key, value] pairs (insertion order kept for integer-like keys, '__proto__' a plain key). */
function pyDict(entries = []) {
  const d = Object.create(null);
  Object.defineProperty(d, PY_KEYS, { value: [], enumerable: false });
  for (const [k, v] of entries) pyDictSet(d, k, v);
  return d;
}

/** The key order json.dumps would write: a pyDict's insertion order, else Object.keys. */
function dictKeys(v) {
  return Array.isArray(v[PY_KEYS]) ? v[PY_KEYS].slice() : Object.keys(v);
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
      for (const k of dictKeys(v)) parts.push(escapeString(String(k)) + ': ' + walk(v[k], k));
      return '{' + parts.join(', ') + '}';
    }
    return escapeString(String(v));
  };
  return walk(value, null);
}

/** Schema leaf: a Python float (repr: `1.0`, `1e+16`, `NaN` / `Infinity` literals). */
const FLOAT = 'f';

/** json.dumps(value) with the Python types of `schema` (see the header). */
function pyJsonDumpsTyped(value, schema = null) {
  const sub = (sch, k) => {
    if (!sch || typeof sch !== 'object' || Array.isArray(sch)) return null;
    if (k !== '$tuple' && Object.prototype.hasOwnProperty.call(sch, k)) return sch[k];
    return Object.prototype.hasOwnProperty.call(sch, '*') ? sch['*'] : null;
  };
  const walk = (v, sch) => {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return dumpNumber(v, sch === FLOAT);
    if (typeof v === 'string') return escapeString(v);
    if (Array.isArray(v)) {
      if (sch && Array.isArray(sch.$tuple)) return '[' + v.map((x, i) => walk(x, sch.$tuple[i] || null)).join(', ') + ']';
      const el = Array.isArray(sch) ? sch[0] : null;
      return '[' + v.map((x) => walk(x, el)).join(', ') + ']';
    }
    if (typeof v === 'object') {
      const parts = [];
      for (const k of dictKeys(v)) parts.push(escapeString(String(k)) + ': ' + walk(v[k], sub(sch, String(k))));
      return '{' + parts.join(', ') + '}';
    }
    return escapeString(String(v));
  };
  return walk(value, schema);
}

// JSON number grammar (RFC 8259); sticky so it matches exactly at the scan position.
const NUM_TOKEN_RE = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/**
 * One pass over JSON text that works on every Node version (no reviver source-text access,
 * which only Node >= 21 has). String literals are copied untouched; each bare token that can
 * start a value — a JSON number token or NaN / Infinity / -Infinity — is offered to
 * `pick(token)`, and a picked token is replaced by the string literal `tag + token`. Every
 * replacement takes the syntactic slot of a value, so the text stays valid exactly when it was
 * valid, except for a token used as an object key, which reviveTagged rejects.
 * Returns null when nothing was picked.
 */
function tagJsonTokens(src, pick) {
  const tag = `\u0001pyjson${Math.random().toString(36).slice(2)}\u0001`;
  let out = '';
  let last = 0;
  let n = 0;
  let i = 0;
  while (i < src.length) {
    const c = src.charCodeAt(i);
    if (c === 34) {                                    // '"': skip the string literal untouched
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      i = j + 1;
      continue;
    }
    if (c === 78 || c === 73 || c === 45 || (c >= 48 && c <= 57)) {   // N I - 0-9
      let tok = null;
      if (src.startsWith('NaN', i)) tok = 'NaN';
      else if (src.startsWith('Infinity', i)) tok = 'Infinity';
      else if (src.startsWith('-Infinity', i)) tok = '-Infinity';
      else {
        NUM_TOKEN_RE.lastIndex = i;
        const m = NUM_TOKEN_RE.exec(src);
        if (m) tok = m[0];
      }
      if (tok !== null) {
        if (pick(tok)) {
          out += src.slice(last, i) + JSON.stringify(tag + tok);
          last = i + tok.length;
          n += 1;
        }
        i += tok.length;
        continue;
      }
    }
    i += 1;
  }
  return n ? { text: out + src.slice(last), tag } : null;
}

/** JSON.parse of a tagJsonTokens result; `map(token)` gives the value of a picked token. */
function reviveTagged(r, map) {
  return JSON.parse(r.text, (k, v) => {
    if (k.startsWith(r.tag)) throw new SyntaxError('Expecting property name enclosed in double quotes');
    return typeof v === 'string' && v.startsWith(r.tag) ? map(v.slice(r.tag.length)) : v;
  });
}

const PY_LITERALS = { NaN: NaN, Infinity: Infinity, '-Infinity': -Infinity, '-0': 0 };
const PY_LITERAL_HINT = /NaN|Infinity|-0(?![.\deE])/;
const INT_TOKEN_RE = /^-?\d+$/;
const isBigIntToken = (t) => INT_TOKEN_RE.test(t) && !Number.isSafeInteger(Number(t));

/**
 * json.loads(text) for a str: JSON.parse plus the NaN / Infinity / -Infinity literals Python's
 * json module reads where a value is expected. Throws SyntaxError wherever json.loads raises
 * (a literal used as an object key, `-NaN`, `1NaN`, … stay errors). The int literal `-0` is the
 * int 0 in Python (only `-0.0` / `-0e0` are a negative zero); JSON.parse gives -0 for both.
 * With `exactInts`, integer literals beyond 2^53 become their exact decimal STRING (Python keeps
 * the exact int); without it they are the nearest double. Independent of the Node version.
 */
function pyJsonParse(text, { exactInts = false } = {}) {
  const src = String(text);
  const wantLit = PY_LITERAL_HINT.test(src);
  const wantBig = exactInts && /\d{16}/.test(src);
  if (!wantLit && !wantBig) return JSON.parse(src);
  const pick = (t) => (wantLit && Object.prototype.hasOwnProperty.call(PY_LITERALS, t)) || (wantBig && isBigIntToken(t));
  const r = tagJsonTokens(src, pick);
  return r ? reviveTagged(r, (t) => (Object.prototype.hasOwnProperty.call(PY_LITERALS, t) ? PY_LITERALS[t] : t)) : JSON.parse(src);
}

/** json.loads for exchange payloads: pyJsonParse with int64 order ids kept exact (as strings). */
function parseJsonExactInts(text) {
  return pyJsonParse(text, { exactInts: true });
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

module.exports = {
  pyJsonDumps, pyJsonDumpsTyped, FLOAT, pyDict, pyDictSet, dictKeys, PY_KEYS,
  pyJsonLoads, pyJsonParse, parseJsonExactInts, tagJsonTokens,
};
