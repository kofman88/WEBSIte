/**
 * pynum — CPython 3.11 int(str) / float(str), the single parser behind every port of the two
 * builtins (challengeService, exchanges/pyCompat, engine/pycoerce, marketData/candleFrame,
 * volume/config, common/pyval, levels/stars, genome/constraints). Each caller keeps its own
 * exception classes; the accept/reject decision, the value and the CPython message texts live here.
 *
 *   PyLong_FromUnicodeObject / PyFloat_FromString:
 *   1. _PyUnicode_TransformDecimalAndSpaceToASCII: ASCII (< 127) is kept, a non-ASCII
 *      str.isspace() character becomes ' ', an Nd digit its ASCII digit (unicodedata 14.0.0:
 *      the Unicode 15.0 Kawi / Nag Mundari digits are no digits), anything else ends the text.
 *   2. only " \t\n\v\f\r" is stripped (U+FEFF, \x1c–\x1f are no number whitespace).
 *   3. PEP 515: one '_' between two digits; float() takes inf / infinity / nan in any case.
 *   4. int() refuses more than sys.get_int_max_str_digits() = 4300 digits.
 */

'use strict';

const { ND_DIGIT, PY_SPACE, pyStrRepr } = require('./pyUnicode');

/** _PyUnicode_TransformDecimalAndSpaceToASCII ('?' marks the first character that is neither). */
function numText(s) {
  let out = '';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (c < 127) out += ch;
    else if (PY_SPACE.has(c)) out += ' ';
    else if (ND_DIGIT.has(c)) out += String(ND_DIGIT.get(c));
    else return `${out}?`;
  }
  return out;
}

const WS = '[ \\t\\n\\v\\f\\r]*';
const DIG = '[0-9](?:_?[0-9])*';                      // PEP 515: one '_' between two digits
const FLOAT_RE = new RegExp(`^${WS}([+-]?)(?:((?:${DIG}(?:\\.(?:${DIG})?)?|\\.${DIG})(?:[eE][+-]?${DIG})?)|(inf|infinity)|(nan))${WS}$`, 'i');
const INT_RE = new RegExp(`^${WS}([+-]?)(${DIG})${WS}$`);
const INT_MAX_STR_DIGITS = 4300;                      // sys.get_int_max_str_digits()

/** float(s) for a str: the double, or undefined where CPython raises ValueError. */
function floatFromStr(s) {
  const m = FLOAT_RE.exec(numText(s));
  if (!m) return undefined;
  const neg = m[1] === '-';
  if (m[3]) return neg ? -Infinity : Infinity;
  if (m[4]) return NaN;
  return Number(`${m[1]}${m[2].split('_').join('')}`);
}

/**
 * int(s) for a str: { neg, digits } (the exact decimal digits, no sign), null where CPython raises
 * "invalid literal", { limit: n } where it raises the 4300-digit limit error.
 */
function intLiteral(s) {
  const m = INT_RE.exec(numText(s));
  if (!m) return null;
  const digits = m[2].split('_').join('');
  if (digits.length > INT_MAX_STR_DIGITS) return { limit: digits.length };
  return { neg: m[1] === '-', digits };
}

/** The value of an intLiteral() as a JS number (exact up to 2**53; int 0 is never -0). */
function intFromLiteral(lit) {
  const n = Number(lit.digits);
  return lit.neg && n !== 0 ? -n : n;
}

/** int(s) as an exact BigInt. */
function bigIntFromLiteral(lit) {
  const b = BigInt(lit.digits);
  return lit.neg ? -b : b;
}

/** str(int(s)) — the exact decimal. */
function intStrFromLiteral(lit) {
  const d = lit.digits.replace(/^0+(?=.)/, '');
  return lit.neg && d !== '0' ? `-${d}` : d;
}

/** The ValueError texts of CPython 3.11. */
const floatErrorText = (s) => `could not convert string to float: ${pyStrRepr(s)}`;
/** `%.200R`: the repr cut to 200 code points. */
const intErrorText = (s) => `invalid literal for int() with base 10: ${Array.from(pyStrRepr(s)).slice(0, 200).join('')}`;
const intLimitText = (n) => `Exceeds the limit (${INT_MAX_STR_DIGITS} digits) for integer string conversion: `
  + `value has ${n} digits; use sys.set_int_max_str_digits() to increase the limit`;

/** int(x) of a float: truncation, never -0; null for nan / inf (ValueError / OverflowError in CPython). */
function intFromFloat(x) {
  if (!Number.isFinite(x)) return null;
  const t = Math.trunc(x);
  return t === 0 ? 0 : t;
}
const floatToIntErrorText = (x) => (Number.isNaN(x) ? 'cannot convert float NaN to integer' : 'cannot convert float infinity to integer');
/** The CPython exception class of int(nan) / int(±inf). */
const floatToIntErrorType = (x) => (Number.isNaN(x) ? 'ValueError' : 'OverflowError');

/**
 * int(s) of a config / env text: the value CPython 3.11 gives, undefined where int() raises (the bot
 * then fails at import; the port's callers fall back to their default instead).
 */
function intOrUndefined(s) {
  const lit = intLiteral(s);
  return lit && lit.limit === undefined ? intFromLiteral(lit) : undefined;
}

module.exports = {
  INT_MAX_STR_DIGITS, numText, floatFromStr, intLiteral, intFromLiteral, bigIntFromLiteral, intStrFromLiteral,
  floatErrorText, intErrorText, intLimitText, intFromFloat, floatToIntErrorText, floatToIntErrorType, intOrUndefined,
};
