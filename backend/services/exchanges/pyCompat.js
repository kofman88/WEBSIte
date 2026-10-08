'use strict';
/**
 * pyCompat.js — the small slice of CPython semantics the exchange traders depend on.
 *
 * The bot's traders are Python: error texts are built with str(dict) / str(exception),
 * query strings with urllib.parse.quote / urlencode, request bodies with json.dumps, and
 * numbers are parsed with float()/int(). Users see several of those strings verbatim
 * (`{"ok": False, "error": str(e)}`), and the BingX/Binance humanizers run regexes over
 * str(response_dict). So the port reproduces exactly:
 *
 *   pyRepr(v)             repr() of JSON-shaped values (dict/list/str/int/float/bool/None)
 *   pyStr(v)              str()
 *   pyStrRepr(s)          repr(str) — quote choice, escapes, str.isprintable()
 *   reprFromJsonText(t)   repr(json.loads(t)) computed from the RAW text, so ints vs floats
 *                         (`1` vs `1.0`), big ints and key order survive (JSON.parse loses them)
 *   attachRepr(obj, t)    pins that repr on a parsed response (non-enumerable `__pyrepr__`)
 *   pyGet(d, k, dflt)     dict.get with AttributeError for non-dicts ('NoneType' object …)
 *   pyIndex(d, k)         d[k] with KeyError / IndexError / TypeError
 *   pyFloat(v) / pyInt(v) float() / int() with Python's ValueError / TypeError messages
 *   pyTruthy / pyOr       Python truthiness (NaN is truthy, {} and [] are falsy)
 *   pyQuote / pyQuotePlus / pyUrlencode   urllib.parse
 *   htmlEscape            html.escape(s, quote=True)
 *   pyCapitalize          str.capitalize()
 *   pyStrftimeHMS(t)      datetime.fromtimestamp(t, utc).strftime('%H:%M:%S')
 *
 * Python exceptions are JS Errors with `pyType` and `message` = str(e).
 */

const { pyRepr: floatRepr } = require('../../strategies/common/pyfmt');

class PyError extends Error {
  constructor(pyType, message) {
    super(message);
    this.pyType = pyType;
    this.name = pyType;
  }
  toString() { return this.message; }
}
const AttributeError = (m) => new PyError('AttributeError', m);
const KeyError = (key) => new PyError('KeyError', pyRepr(key));
const IndexError = (m) => new PyError('IndexError', m);
const TypeError_ = (m) => new PyError('TypeError', m);
const ValueError = (m) => new PyError('ValueError', m);
const ZeroDivisionError = (m = 'float division by zero') => new PyError('ZeroDivisionError', m);
const OverflowError = (m) => new PyError('OverflowError', m);

/** str(e) for any thrown value (Python exceptions, JS errors, strings). */
function errStr(e) {
  if (e === null || e === undefined) return 'None';
  if (typeof e === 'string') return e;
  if (e instanceof Error) return String(e.message);
  return pyStr(e);
}

function isDict(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function pyTypeName(v) {
  if (v === null || v === undefined) return 'NoneType';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
  if (typeof v === 'string') return 'str';
  if (Array.isArray(v)) return 'list';
  if (typeof v === 'object') return 'dict';
  return typeof v;
}

/** Python truthiness. */
function pyTruthy(v) {
  if (v === null || v === undefined || v === false) return false;
  if (typeof v === 'number') return v !== 0; // NaN is truthy in Python
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return Boolean(v);
}

/** `a or b` */
function pyOr(...vals) {
  for (let i = 0; i < vals.length - 1; i++) if (pyTruthy(vals[i])) return vals[i];
  return vals[vals.length - 1];
}

/** dict.get(key, default) — raises AttributeError for non-dicts like CPython. */
function pyGet(d, key, dflt = null) {
  if (!isDict(d)) throw AttributeError(`'${pyTypeName(d)}' object has no attribute 'get'`);
  return Object.prototype.hasOwnProperty.call(d, key) ? d[key] : dflt;
}

/** d[key] / lst[i] */
function pyIndex(d, key) {
  if (Array.isArray(d)) {
    if (typeof key !== 'number') throw TypeError_(`list indices must be integers or slices, not ${pyTypeName(key)}`);
    const i = key < 0 ? d.length + key : key;
    if (i < 0 || i >= d.length) throw IndexError('list index out of range');
    return d[i];
  }
  if (isDict(d)) {
    if (!Object.prototype.hasOwnProperty.call(d, key)) throw KeyError(key);
    return d[key];
  }
  if (typeof d === 'string') {
    if (typeof key !== 'number') throw TypeError_(`string indices must be integers, not '${pyTypeName(key)}'`);
    const i = key < 0 ? d.length + key : key;
    if (i < 0 || i >= d.length) throw IndexError('string index out of range');
    return d[i];
  }
  throw TypeError_(`'${pyTypeName(d)}' object is not subscriptable`);
}

// ── repr ────────────────────────────────────────────────────────────────────

const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

function hex(n, width) { return n.toString(16).padStart(width, '0'); }

/** repr(str) — CPython unicode_repr. */
function pyStrRepr(s) {
  s = String(s);
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === quote || ch === '\\') out += '\\' + ch;
    else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (cp < 0x20 || cp === 0x7f) out += '\\x' + hex(cp, 2);
    else if (cp < 0x7f) out += ch;
    else if (ch !== ' ' && NON_PRINTABLE.test(ch)) {
      if (cp <= 0xff) out += '\\x' + hex(cp, 2);
      else if (cp <= 0xffff) out += '\\u' + hex(cp, 4);
      else out += '\\U' + hex(cp, 8);
    } else out += ch;
  }
  return out + quote;
}

/** repr() of a JSON-shaped JS value (integral numbers print as int). */
function pyRepr(v) {
  if (v !== null && typeof v === 'object' && typeof v.__pyrepr__ === 'string') return v.__pyrepr__;
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return Object.is(v, -0) ? '0' : String(v);
    return floatRepr(v);
  }
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'string') return pyStrRepr(v);
  if (Array.isArray(v)) return '[' + v.map(pyRepr).join(', ') + ']';
  if (typeof v === 'object') {
    return '{' + Object.keys(v).map((k) => `${pyStrRepr(k)}: ${pyRepr(v[k])}`).join(', ') + '}';
  }
  return String(v);
}

/** str() */
function pyStr(v) {
  if (typeof v === 'string') return v;
  return pyRepr(v);
}

/** str(float) — for values the Python code holds as floats (`str(1.0)` → '1.0'). */
function pyFloatStr(x) {
  return floatRepr(Number(x));
}

/** Attach a precomputed repr to a parsed object (non-enumerable, survives equality checks). */
function attachRepr(obj, repr) {
  if (obj !== null && typeof obj === 'object') {
    try {
      Object.defineProperty(obj, '__pyrepr__', { value: repr, enumerable: false, configurable: true, writable: true });
    } catch (_e) { /* frozen objects keep the generic repr */ }
  }
  return obj;
}

/**
 * repr(json.loads(text)) computed straight from the JSON text, so Python's int/float
 * distinction, arbitrary-size ints and dict key order (first position, last value) are kept.
 * Throws SyntaxError on invalid JSON.
 */
function reprFromJsonText(text) {
  let i = 0;
  const s = String(text);
  const ws = () => { while (i < s.length && ' \t\n\r'.includes(s[i])) i++; };
  const fail = () => { throw new SyntaxError(`JSON repr: unexpected token at ${i}`); };
  const parseString = () => {
    // reuse JSON.parse for unescaping a single string token
    const start = i;
    i++; // opening quote
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
      const vals = new Map();
      ws();
      if (s[i] === '}') { i++; return '{}'; }
      for (;;) {
        ws();
        if (s[i] !== '"') fail();
        const k = parseString();
        ws();
        if (s[i] !== ':') fail();
        i++;
        const v = value();
        if (!vals.has(k)) keys.push(k);
        vals.set(k, v);
        ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === '}') { i++; break; }
        fail();
      }
      return '{' + keys.map((k) => `${pyStrRepr(k)}: ${vals.get(k)}`).join(', ') + '}';
    }
    if (c === '[') {
      i++;
      const items = [];
      ws();
      if (s[i] === ']') { i++; return '[]'; }
      for (;;) {
        items.push(value());
        ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === ']') { i++; break; }
        fail();
      }
      return '[' + items.join(', ') + ']';
    }
    if (c === '"') return pyStrRepr(parseString());
    if (s.startsWith('true', i)) { i += 4; return 'True'; }
    if (s.startsWith('false', i)) { i += 5; return 'False'; }
    if (s.startsWith('null', i)) { i += 4; return 'None'; }
    if (s.startsWith('NaN', i)) { i += 3; return 'nan'; }
    if (s.startsWith('Infinity', i)) { i += 8; return 'inf'; }
    if (s.startsWith('-Infinity', i)) { i += 9; return '-inf'; }
    const m = /^-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(s.slice(i));
    if (!m) return fail();
    i += m[0].length;
    if (m[1] !== undefined || m[2] !== undefined) return floatRepr(Number(m[0]));
    const b = BigInt(m[0]);
    return b.toString();
  };
  const out = value();
  ws();
  if (i !== s.length) fail();
  return out;
}

// ── float() / int() ─────────────────────────────────────────────────────────

const FLOAT_RE = /^[+-]?(?:(?:\d(?:_?\d)*)?\.?\d(?:_?\d)*(?:[eE][+-]?\d(?:_?\d)*)?|\d(?:_?\d)*\.|inf(?:inity)?|nan)$/i;

/** float(v) */
function pyFloat(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!FLOAT_RE.test(t)) throw ValueError(`could not convert string to float: ${pyStrRepr(v)}`);
    const low = t.toLowerCase().replace(/^\+/, '');
    if (low === 'inf' || low === 'infinity') return Infinity;
    if (low === '-inf' || low === '-infinity') return -Infinity;
    if (low === 'nan' || low === '-nan') return NaN;
    return Number(t.replace(/_/g, ''));
  }
  throw TypeError_(`float() argument must be a string or a real number, not '${pyTypeName(v)}'`);
}

/** int(v) */
function pyInt(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') {
    if (Number.isNaN(v)) throw ValueError('cannot convert float NaN to integer');
    if (!Number.isFinite(v)) throw OverflowError('cannot convert float infinity to integer');
    const t = Math.trunc(v);
    return t === 0 ? 0 : t;
  }
  if (typeof v === 'string') {
    const t = v.trim();
    if (!/^[+-]?\d(?:_?\d)*$/.test(t)) throw ValueError(`invalid literal for int() with base 10: ${pyStrRepr(v)}`);
    return Number(t.replace(/_/g, ''));
  }
  throw TypeError_(`int() argument must be a string, a bytes-like object or a real number, not '${pyTypeName(v)}'`);
}

/** int(v) as an exact BigInt (Python ints are unbounded): bool, integral-valued float, int literal str. */
function pyBigInt(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'boolean') return v ? 1n : 0n;
  if (typeof v === 'number') return BigInt(pyInt(v));
  if (typeof v === 'string') {
    const t = v.trim();
    if (!/^[+-]?\d(?:_?\d)*$/.test(t)) throw ValueError(`invalid literal for int() with base 10: ${pyStrRepr(v)}`);
    return BigInt(t.replace(/_/g, '').replace(/^\+/, ''));
  }
  throw TypeError_(`int() argument must be a string, a bytes-like object or a real number, not '${pyTypeName(v)}'`);
}

/** len(v): str (code points) / list / dict; anything else raises like CPython. */
function pyLen(v) {
  if (typeof v === 'string') return Array.from(v).length;
  if (Array.isArray(v)) return v.length;
  if (isDict(v)) return Object.keys(v).length;
  throw TypeError_(`object of type '${pyTypeName(v)}' has no len()`);
}

/**
 * Python ordering comparison `a <op> b` (op: '<' '<=' '>' '>='): numbers and bools compare as
 * numbers, str with str; anything else raises TypeError like CPython (`None >= 0`, `'1' < 0`).
 */
function pyCmp(a, op, b) {
  const num = (x) => typeof x === 'number' || typeof x === 'boolean';
  let x;
  let y;
  if (num(a) && num(b)) { x = Number(a); y = Number(b); } else if (typeof a === 'string' && typeof b === 'string') { x = a; y = b; } else {
    throw TypeError_(`'${op}' not supported between instances of '${pyTypeName(a)}' and '${pyTypeName(b)}'`);
  }
  switch (op) {
    case '<': return x < y;
    case '<=': return x <= y;
    case '>': return x > y;
    case '>=': return x >= y;
    default: throw new Error(`pyCmp: bad operator ${op}`);
  }
}

/** Python `for x in v` over a JSON value: list items / str chars / dict keys; others raise TypeError. */
function pyIter(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return Array.from(v);
  if (isDict(v)) return Object.keys(v);
  throw TypeError_(`'${pyTypeName(v)}' object is not iterable`);
}

/** float(x or 0) — the bot's most common coercion. */
function pyFloatOr0(v) { return pyFloat(pyOr(v, 0)); }

// ── urllib.parse ────────────────────────────────────────────────────────────

const ALWAYS_SAFE = /[A-Za-z0-9_.\-~]/;

/** urllib.parse.quote(string, safe='') */
function pyQuote(s, safe = '') {
  const bytes = Buffer.from(String(s), 'utf8');
  let out = '';
  for (const b of bytes) {
    const ch = String.fromCharCode(b);
    if (b < 0x80 && (ALWAYS_SAFE.test(ch) || safe.includes(ch))) out += ch;
    else out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

/** urllib.parse.quote_plus(string, safe='') */
function pyQuotePlus(s, safe = '') {
  s = String(s);
  if (s.includes(' ')) return pyQuote(s, safe + ' ').replace(/ /g, '+');
  return pyQuote(s, safe);
}

/** urllib.parse.urlencode(dict) (doseq=False, quote_via=quote_plus). Values via str(). */
function pyUrlencode(params) {
  const parts = [];
  for (const k of Object.keys(params)) {
    parts.push(`${pyQuotePlus(pyStr(k))}=${pyQuotePlus(pyStr(params[k]))}`);
  }
  return parts.join('&');
}

// ── yarl (aiohttp URL normalisation) ───────────────────────────────────────

const YARL_ALLOWED = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~!$'()*,";

/**
 * yarl `_Quoter.__call__` (pure-Python implementation, yarl 1.25):
 * bytes in safe+ALLOWED(+QS unless qs)+protected pass, ' ' → '+' in qs mode, valid %XX escapes
 * are uppercased and DECODED when the char is safe (kept when protected / unsafe),
 * a stray '%' becomes %25, everything else is %XX.
 */
function yarlQuote(val, { safe = '', protected: prot = '', qs = false, requote = true } = {}) {
  if (!val) return '';
  const b = Buffer.from(String(val), 'utf8');
  let safeSet = safe + YARL_ALLOWED;
  if (!qs) safeSet += '+&=;';
  safeSet += prot;
  let ret = '';
  let pct = '';
  let idx = 0;
  const isHex = (s) => /^[A-Z0-9][A-Z0-9]$/.test(s);
  while (idx < b.length) {
    let ch = b[idx];
    idx += 1;
    if (pct) {
      if (ch >= 0x61 && ch <= 0x7a) ch -= 32;
      pct += String.fromCharCode(ch);
      if (pct.length === 3) {
        const buf = pct.slice(1);
        const code = isHex(buf) ? parseInt(buf, 16) : NaN;
        if (!isHex(buf) || Number.isNaN(code) || !/^[0-9A-F]{2}$/.test(buf)) {
          ret += '%25';
          pct = '';
          idx -= 2;
          continue;
        }
        const unq = String.fromCharCode(code);
        if (prot.includes(unq)) ret += pct;
        else if (safeSet.includes(unq)) ret += unq;
        else ret += pct;
        pct = '';
      } else if (pct.length === 2 && idx === b.length) {
        ret += '%25';
        pct = '';
        idx -= 1;
      }
      continue;
    }
    if (ch === 0x25 && requote) {
      pct = '%';
      if (idx === b.length) ret += '%25';
      continue;
    }
    if (qs && ch === 0x20) { ret += '+'; continue; }
    const c = String.fromCharCode(ch);
    if (ch < 0x80 && safeSet.includes(c)) { ret += c; continue; }
    ret += '%' + ch.toString(16).toUpperCase().padStart(2, '0');
  }
  return ret;
}

/** QUERY_REQUOTER — what aiohttp does to the query of a str URL. */
function yarlRequoteQuery(q) {
  return yarlQuote(q, { safe: '?/:@', protected: '=+&;', qs: true, requote: true });
}

/** `URL(str)` for an absolute URL: requote the query part (paths here are plain). */
function yarlUrl(url) {
  const i = String(url).indexOf('?');
  if (i < 0) return String(url);
  return String(url).slice(0, i + 1) + yarlRequoteQuery(String(url).slice(i + 1));
}

/** QUERY_PART_QUOTER per key / value — aiohttp `params={...}`. */
function yarlQueryFromParams(params) {
  const q = (v) => yarlQuote(pyStr(v), { safe: '?/:@', qs: true, requote: false });
  return Object.keys(params).map((k) => `${q(k)}=${q(params[k])}`).join('&');
}

// ── misc ────────────────────────────────────────────────────────────────────

/** html.escape(s, quote=True) */
function htmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/** str.capitalize() */
function pyCapitalize(s) {
  s = String(s);
  if (!s) return s;
  const first = String.fromCodePoint(s.codePointAt(0));
  return first.toUpperCase() + s.slice(first.length).toLowerCase();
}

/** datetime.now(timezone.utc).strftime("%H:%M:%S") for a unix-seconds clock value. */
function pyStrftimeHMS(t) {
  const d = new Date(Math.floor(t * 1000));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** str[:n] on code points (Python slices by code point, JS by UTF-16 unit). */
function pySlice(s, n) {
  const arr = Array.from(String(s));
  return arr.length <= n ? String(s) : arr.slice(0, n).join('');
}

/** `x in (a, b, …)` with Python equality for numbers/strings. */
function pyIn(x, ...vals) {
  return vals.some((v) => v === x);
}

module.exports = {
  PyError, AttributeError, KeyError, IndexError, TypeError: TypeError_, ValueError, OverflowError, ZeroDivisionError,
  errStr, isDict, pyTypeName, pyTruthy, pyOr, pyGet, pyIndex, pyBigInt, pyLen, pyIter, pyCmp,
  pyStrRepr, pyRepr, pyStr, pyFloatStr, attachRepr, reprFromJsonText,
  pyFloat, pyInt, pyFloatOr0,
  pyQuote, pyQuotePlus, pyUrlencode, yarlQuote, yarlRequoteQuery, yarlUrl, yarlQueryFromParams,
  htmlEscape, pyCapitalize, pyStrftimeHMS, pySlice, pyIn,
};
