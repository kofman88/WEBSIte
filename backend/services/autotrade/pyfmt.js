'use strict';
/**
 * pyfmt.js — Python `%`-formatting (logging) and `str.format` (i18n.t) on the auto-trade
 * value model, so every log line and message is the bot's text byte for byte.
 *
 * Value model: JS strings / booleans / null / arrays / plain objects map to Python str /
 * bool / None / list / dict. A JS number is a Python int when it is integral, else a float;
 * a Python float that happens to be integral (1.0, 45.0) must be wrapped: F(1) → prints
 * "1.0" under %s / {x}. `%d`, `%.2f`, `{x:.1f}` … format the number and need no wrapper.
 *
 *   F(x)                  mark a Python float
 *   pyStr(v)              str(v)
 *   pyReprV(v)            repr(v)
 *   pf(fmt, ...args)      fmt % tuple(args)          (log.info("...%s...", a, b))
 *   sformat(tpl, kwargs)  tpl.format(**kwargs) — throws PyFormatError like CPython
 */

const { pyRepr: floatRepr, fmtFixed, fmtComma, fmtG } = require('../../strategies/common/pyfmt');
const { pyRepr: valueRepr, pyStrRepr, pyTypeName } = require('../exchanges/pyCompat');

/** type(v).__name__ on the value model (a PyFloat is a float). */
const typeName = (v) => (v instanceof PyFloat ? 'float' : pyTypeName(v));

class PyFloat {
  constructor(v) { this.v = Number(v); }
  valueOf() { return this.v; }
}
const F = (v) => (v instanceof PyFloat ? v : new PyFloat(v));
const num = (v) => (v instanceof PyFloat ? v.v : v);
const isFloatVal = (v) => v instanceof PyFloat || (typeof v === 'number' && (!Number.isInteger(v) || Object.is(v, -0) || Math.abs(v) >= 1e16));

class PyFormatError extends Error {
  constructor(pyType, msg) { super(msg); this.pyType = pyType; this.name = pyType; }
}

function pyReprV(v) {
  if (v instanceof PyFloat) return floatRepr(v.v);
  if (v !== null && typeof v === 'object' && typeof v.__pyrepr__ === 'string') return v.__pyrepr__;
  if (v === undefined) return 'None';
  if (typeof v === 'string') return pyStrRepr(v);
  if (typeof v === 'number') return isFloatVal(v) ? floatRepr(v) : String(v);
  if (Array.isArray(v)) return '[' + v.map(pyReprV).join(', ') + ']';
  if (v !== null && typeof v === 'object' && v.constructor === Object) {
    return '{' + Object.keys(v).map((k) => `${pyStrRepr(k)}: ${pyReprV(v[k])}`).join(', ') + '}';
  }
  if (v instanceof Error) return `${v.pyType || v.name || 'Exception'}(${pyStrRepr(String(v.message))})`;
  return valueRepr(v);
}

function pyStr(v) {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return String(v.message);
  return pyReprV(v);
}

function toIntStr(v) {
  const x = num(v);
  if (typeof x === 'boolean') return x ? '1' : '0';
  if (typeof x !== 'number') throw new PyFormatError('TypeError', `%d format: a real number is required, not ${typeName(x)}`);
  if (Number.isNaN(x)) throw new PyFormatError('ValueError', 'cannot convert float NaN to integer');
  if (!Number.isFinite(x)) throw new PyFormatError('OverflowError', 'cannot convert float infinity to integer');
  const t = Math.trunc(x);
  return Object.is(t, -0) ? '0' : (Math.abs(t) >= 1e21 ? BigInt(t).toString() : String(t));
}

function toNum(v, conv) {
  const x = num(v);
  if (typeof x === 'boolean') return x ? 1 : 0;
  if (typeof x !== 'number') throw new PyFormatError('TypeError', `must be real number, not ${typeName(x)}`);
  void conv;
  return x;
}

function fmtExp(x, prec) {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? 'nan' : (x > 0 ? 'inf' : '-inf');
  const s = x.toExponential(prec);
  const m = /^(-?[\d.]+)e([+-])(\d+)$/.exec(s);
  return `${m[1]}e${m[2]}${m[3].padStart(2, '0')}`;
}

/** One numeric/str conversion with flags (+, -, 0, ' ', ','), width, precision. */
function convert(v, { flags = '', width = null, prec = null, conv, comma = false }) {
  let body;
  let isNum = false;
  switch (conv) {
    case 's': body = pyStr(v); break;
    case 'r': case 'a': body = pyReprV(v); break;
    case 'd': case 'i': case 'u': body = toIntStr(v); isNum = true; break;
    case 'f': case 'F': {
      const x = toNum(v, conv);
      body = comma ? fmtComma(x, prec === null ? 6 : prec) : fmtFixed(x, prec === null ? 6 : prec);
      isNum = true;
      break;
    }
    case 'g': case 'G': {
      const x = toNum(v, conv);
      body = fmtG(x, prec === null ? 6 : prec);
      if (conv === 'G') body = body.toUpperCase();
      isNum = true;
      break;
    }
    case 'e': case 'E':
      body = fmtExp(toNum(v, conv), prec === null ? 6 : prec);
      if (conv === 'E') body = body.toUpperCase();
      isNum = true;
      break;
    case 'x': body = BigInt(toIntStr(v)).toString(16); isNum = true; break;
    default: throw new PyFormatError('ValueError', `unsupported format character '${conv}'`);
  }
  if (conv === 's' || conv === 'r') {
    if (prec !== null) body = Array.from(body).slice(0, prec).join('');
  }
  if (isNum && flags.includes('+') && !body.startsWith('-')) body = '+' + body;
  else if (isNum && flags.includes(' ') && !body.startsWith('-')) body = ' ' + body;
  if (width !== null) {
    const len = Array.from(body).length;
    if (len < width) {
      const pad = width - len;
      if (flags.includes('-') || flags.includes('<')) body += ' '.repeat(pad);
      else if (flags.includes('0') && isNum) {
        const sign = /^[+\- ]/.test(body) ? body[0] : '';
        body = sign + '0'.repeat(pad) + body.slice(sign.length);
      } else body = ' '.repeat(pad) + body;
    }
  }
  return body;
}

const PCT_RE = /%(?:\(([^)]*)\))?([-+ #0]*)(\d+|\*)?(?:\.(\d+))?([sdifFgGeExXruac%])/g;

/** fmt % args (logging's msg % args). */
function pf(fmt, ...args) {
  let i = 0;
  const out = fmt.replace(PCT_RE, (_m, _key, flags, width, prec, conv) => {
    if (conv === '%') return '%';
    if (i >= args.length) throw new PyFormatError('TypeError', 'not enough arguments for format string');
    const v = args[i++];
    return convert(v, { flags, width: width ? Number(width) : null, prec: prec === undefined ? null : Number(prec), conv });
  });
  if (i < args.length) throw new PyFormatError('TypeError', 'not all arguments converted during string formatting');
  return out;
}

/** format(value, spec) for the specs the bot's i18n templates use. */
function formatSpec(v, spec) {
  if (!spec) return pyStr(v);
  const m = /^([<>^=]?)([+\- ]?)(0?)(\d*)(,?)(?:\.(\d+))?([sdfFgGeE%]?)$/.exec(spec);
  if (!m) throw new PyFormatError('ValueError', `Invalid format specifier '${spec}'`);
  const [, align, sign, zero, width, comma, prec, type] = m;
  const p = prec === undefined ? null : Number(prec);
  if (v === null || v === undefined) throw new PyFormatError('TypeError', 'unsupported format string passed to NoneType.__format__');
  if (typeof v === 'string' && type && type !== 's') throw new PyFormatError('ValueError', `Unknown format code '${type}' for object of type 'str'`);
  let body;
  if (!type && comma && typeof num(v) === 'number') {
    // format(x, ',') — int: thousands groups; float: repr with grouped integer digits
    if (!isFloatVal(v)) body = fmtComma(num(v), 0);
    else {
      const r = floatRepr(num(v));
      const mm = /^(-?)(\d+)(.*)$/.exec(r);
      body = mm ? mm[1] + mm[2].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + mm[3] : r;
    }
  } else if (type === 's' || (!type && typeof v === 'string')) {
    if (typeof v !== 'string') throw new PyFormatError('ValueError', `Unknown format code 's' for object of type '${typeof v}'`);
    body = p === null ? v : Array.from(v).slice(0, p).join('');
  } else if (type === 'd') {
    if (isFloatVal(v)) throw new PyFormatError('ValueError', "Unknown format code 'd' for object of type 'float'");
    body = toIntStr(v);
    if (comma) body = fmtComma(Number(body), 0);
  } else if (type === 'f' || type === 'F' || type === '%') {
    let x = toNum(v);
    if (type === '%') x *= 100;
    body = (comma ? fmtComma(x, p === null ? 6 : p) : fmtFixed(x, p === null ? 6 : p)) + (type === '%' ? '%' : '');
  } else if (type === 'g' || type === 'G') {
    body = fmtG(toNum(v), p === null ? 6 : p);
  } else if (type === 'e' || type === 'E') {
    body = fmtExp(toNum(v), p === null ? 6 : p);
  } else if (!type && p !== null) {
    // '.2' on a float → general format with repr-like rules (rare in the bot's texts)
    body = fmtG(toNum(v), p);
  } else {
    body = pyStr(v);
  }
  if (sign === '+' && typeof num(v) === 'number' && !body.startsWith('-')) body = '+' + body;
  else if (sign === ' ' && typeof num(v) === 'number' && !body.startsWith('-')) body = ' ' + body;
  const w = width ? Number(width) : 0;
  const len = Array.from(body).length;
  if (len < w) {
    const pad = w - len;
    const a = align || (typeof v === 'string' ? '<' : '>');
    if (zero && !align) body = (body[0] === '-' || body[0] === '+' ? body[0] + '0'.repeat(pad) + body.slice(1) : '0'.repeat(pad) + body);
    else if (a === '<') body += ' '.repeat(pad);
    else if (a === '^') body = ' '.repeat(Math.floor(pad / 2)) + body + ' '.repeat(pad - Math.floor(pad / 2));
    else body = ' '.repeat(pad) + body;
  }
  return body;
}

/** str.format(**kwargs): {name}, {name:spec}, {{ }} escapes. KeyError / ValueError like CPython. */
function sformat(tpl, kwargs = {}) {
  let out = '';
  for (let i = 0; i < tpl.length; i++) {
    const c = tpl[i];
    if (c === '{') {
      if (tpl[i + 1] === '{') { out += '{'; i += 1; continue; }
      const end = tpl.indexOf('}', i);
      if (end < 0) {
        throw new PyFormatError('ValueError', i === tpl.length - 1 ? "Single '{' encountered in format string" : "expected '}' before end of string");
      }
      const field = tpl.slice(i + 1, end);
      const colon = field.indexOf(':');
      const name = colon < 0 ? field : field.slice(0, colon);
      const spec = colon < 0 ? '' : field.slice(colon + 1);
      if (name === '') throw new PyFormatError('IndexError', 'Replacement index 0 out of range for positional args tuple');
      if (!Object.prototype.hasOwnProperty.call(kwargs, name)) throw new PyFormatError('KeyError', pyStrRepr(name));
      out += formatSpec(kwargs[name], spec);
      i = end;
    } else if (c === '}') {
      if (tpl[i + 1] === '}') { out += '}'; i += 1; continue; }
      throw new PyFormatError('ValueError', "Single '}' encountered in format string");
    } else {
      out += c;
    }
  }
  return out;
}

module.exports = { PyFloat, F, num, isFloatVal, PyFormatError, pyStr, pyReprV, pf, sformat, formatSpec, convert };
