'use strict';
/**
 * pyBody.js — the Python types of a Mini App request body.
 *
 * botBody.readBotBody gives the routes plain JS values, where `1` and `1.0`, a 400-digit int
 * and the float `1e400`, are the same number. The bot's handlers call `str()` / `int()` /
 * truthiness on raw body values (`str(body.get("text", "") or "")`, `int(body.get("days", 30))`,
 * `str(body.get("symbol", ""))`), and those results depend on the Python type json.loads made:
 * str(10.0) = '10.0' but str(10) = '10', int(1e400) raises OverflowError but int(10**400) is
 * an exact int, str([1, 2]) = '[1, 2]'. readBotBody therefore pins the decoded JSON text on the
 * parsed object (non-enumerable, `BODY_TEXT`), and this module re-reads it with json.loads'
 * types:
 *
 *   node = { t: 'str', v } | { t: 'int', v: BigInt } | { t: 'float', v } | { t: 'bool', v }
 *        | { t: 'none' } | { t: 'list', items } | { t: 'dict', keys, map }
 *
 *   field(body, key)      the node of a top-level key (json.loads: last duplicate wins), or undefined
 *   pyStr(node)           str(value)            pyRepr(node)   repr(value)
 *   pyTruthy(node)        bool(value)           pyIntOf(node)  int(value) → Number | BigInt-backed
 *                                                              Number, raising PyTypeError /
 *                                                              PyValueError / PyOverflowError
 * A body without the pinned text (tests that call a handler with a plain object) falls back to
 * the JS values (integral numbers read as ints).
 */

const { pyRepr: floatRepr } = require('../../strategies/common/pyfmt');
const { pyStrRepr } = require('../../strategies/common/pyUnicode');
const { pyInt, PyValueError, PyTypeError } = require('./pycoerce');

const BODY_TEXT = Symbol.for('chm.botBody.text');

class PyOverflowError extends Error {}

const NUM_RE = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;

/** Pin the decoded body text on the parsed object (readBotBody). */
function attachText(obj, text) {
  if (obj && typeof obj === 'object') {
    try { Object.defineProperty(obj, BODY_TEXT, { value: String(text), enumerable: false, configurable: true }); } catch (_e) { /* frozen */ }
  }
  return obj;
}

/** json.loads(text) → typed node tree (the text is valid JSON: pyJsonParse already accepted it). */
function parseTyped(text) {
  const s = String(text);
  let i = 0;
  const ws = () => { while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r')) i++; };
  const fail = () => { throw new SyntaxError(`typed json: unexpected token at ${i}`); };
  const str = () => {
    const start = i;
    i++;
    while (i < s.length) {
      const c = s[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '"') { i++; return JSON.parse(s.slice(start, i)); }
      i++;
    }
    return fail();
  };
  const value = () => {
    ws();
    const c = s[i];
    if (c === '{') {
      i++;
      const keys = [];
      const map = new Map();
      ws();
      if (s[i] === '}') { i++; return { t: 'dict', keys, map }; }
      for (;;) {
        ws();
        if (s[i] !== '"') fail();
        const k = str();
        ws();
        if (s[i] !== ':') fail();
        i++;
        const v = value();
        if (!map.has(k)) keys.push(k);
        map.set(k, v);
        ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === '}') { i++; break; }
        fail();
      }
      return { t: 'dict', keys, map };
    }
    if (c === '[') {
      i++;
      const items = [];
      ws();
      if (s[i] === ']') { i++; return { t: 'list', items }; }
      for (;;) {
        items.push(value());
        ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === ']') { i++; break; }
        fail();
      }
      return { t: 'list', items };
    }
    if (c === '"') return { t: 'str', v: str() };
    if (s.startsWith('true', i)) { i += 4; return { t: 'bool', v: true }; }
    if (s.startsWith('false', i)) { i += 5; return { t: 'bool', v: false }; }
    if (s.startsWith('null', i)) { i += 4; return { t: 'none' }; }
    if (s.startsWith('NaN', i)) { i += 3; return { t: 'float', v: NaN }; }
    if (s.startsWith('Infinity', i)) { i += 8; return { t: 'float', v: Infinity }; }
    if (s.startsWith('-Infinity', i)) { i += 9; return { t: 'float', v: -Infinity }; }
    NUM_RE.lastIndex = i;
    const m = NUM_RE.exec(s);
    if (!m) return fail();
    i += m[0].length;
    if (m[1] !== undefined || m[2] !== undefined) return { t: 'float', v: Number(m[0]) };
    return { t: 'int', v: BigInt(m[0]) };
  };
  const out = value();
  ws();
  if (i !== s.length) fail();
  return out;
}

const INT_MAX_STR_DIGITS = 4300;   // sys.int_info.default_max_str_digits (CPython 3.11)

/** json.loads would raise ValueError: an int literal with more than 4300 digits somewhere in `text`. */
function intDigitsExceeded(text) {
  const s = String(text);
  if (!/\d{4301}/.test(s)) return false;
  let tree;
  try { tree = parseTyped(s); } catch (_e) { return false; }
  const walk = (n) => {
    if (n.t === 'int') return (n.v < 0n ? -n.v : n.v).toString().length > INT_MAX_STR_DIGITS;
    if (n.t === 'list') return n.items.some(walk);
    if (n.t === 'dict') return n.keys.some((k) => walk(n.map.get(k)));
    return false;
  };
  return walk(tree);
}

/** A plain JS value → node (the fallback without the raw text). */
function nodeOf(v) {
  if (v === null || v === undefined) return { t: 'none' };
  if (typeof v === 'boolean') return { t: 'bool', v };
  if (typeof v === 'number') return Number.isInteger(v) && Number.isSafeInteger(v) ? { t: 'int', v: BigInt(v) } : { t: 'float', v };
  if (typeof v === 'bigint') return { t: 'int', v };
  if (typeof v === 'string') return { t: 'str', v };
  if (Array.isArray(v)) return { t: 'list', items: v.map(nodeOf) };
  const keys = Object.keys(v);
  return { t: 'dict', keys, map: new Map(keys.map((k) => [k, nodeOf(v[k])])) };
}

const typedCache = new WeakMap();

/** The typed top-level dict of a readBotBody result (null when it is not a dict). */
function typedTop(body) {
  if (!body || typeof body !== 'object') return null;
  if (typedCache.has(body)) return typedCache.get(body);
  let top = null;
  const text = body[BODY_TEXT];
  if (typeof text === 'string') {
    try { top = parseTyped(text); } catch (_e) { top = null; }
  }
  if (!top || top.t !== 'dict') top = nodeOf(body);
  typedCache.set(body, top);
  return top;
}

/** body.get(key) as a typed node; undefined when the key is absent. */
function field(body, key) {
  const top = typedTop(body);
  return top && top.map.has(key) ? top.map.get(key) : undefined;
}

function pyRepr(n) {
  switch (n.t) {
    case 'str': return pyStrRepr(n.v);
    case 'list': return `[${n.items.map(pyRepr).join(', ')}]`;
    case 'dict': return `{${n.keys.map((k) => `${pyStrRepr(k)}: ${pyRepr(n.map.get(k))}`).join(', ')}}`;
    default: return pyStr(n);
  }
}

/** str(value) */
function pyStr(n) {
  switch (n.t) {
    case 'str': return n.v;
    case 'int': return n.v.toString();
    case 'float': return floatRepr(n.v);
    case 'bool': return n.v ? 'True' : 'False';
    case 'none': return 'None';
    default: return pyRepr(n);
  }
}

/** bool(value) */
function pyTruthy(n) {
  switch (n.t) {
    case 'str': return n.v !== '';
    case 'int': return n.v !== 0n;
    case 'float': return n.v !== 0;
    case 'bool': return n.v;
    case 'none': return false;
    case 'list': return n.items.length > 0;
    case 'dict': return n.keys.length > 0;
    default: return true;
  }
}

/** int(value) → Number (exact for |x| ≤ 2^53; a huge int is ±Infinity-free: clamped by magnitude). */
function pyIntOf(n) {
  switch (n.t) {
    case 'bool': return n.v ? 1 : 0;
    case 'int': return Number(n.v);           // only compared / clamped by the callers
    case 'float': {
      if (Number.isNaN(n.v)) throw new PyValueError('cannot convert float NaN to integer');
      if (!Number.isFinite(n.v)) throw new PyOverflowError('cannot convert float infinity to integer');
      const t = Math.trunc(n.v);
      return t === 0 ? 0 : t;
    }
    case 'str': return pyInt(n.v);
    case 'none': throw new PyTypeError("int() argument must be a string, a bytes-like object or a real number, not 'NoneType'");
    case 'list': throw new PyTypeError("int() argument must be a string, a bytes-like object or a real number, not 'list'");
    case 'dict': throw new PyTypeError("int() argument must be a string, a bytes-like object or a real number, not 'dict'");
    default: throw new PyTypeError('int() argument');
  }
}

/** The plain JS value of a node (strings stay strings; ints beyond 2^53 lose precision). */
function jsOf(n) {
  switch (n.t) {
    case 'str': case 'float': case 'bool': return n.v;
    case 'int': return Number(n.v);
    case 'none': return null;
    case 'list': return n.items.map(jsOf);
    case 'dict': return Object.fromEntries(n.keys.map((k) => [k, jsOf(n.map.get(k))]));
    default: return null;
  }
}

module.exports = {
  BODY_TEXT, INT_MAX_STR_DIGITS, PyOverflowError, attachText, parseTyped, intDigitsExceeded, nodeOf, typedTop, field,
  pyStr, pyRepr, pyTruthy, pyIntOf, jsOf,
};
