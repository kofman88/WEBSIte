/**
 * pycoerce — Python's built-in constructors as the bot calls them on user
 * input: `int(v)`, `float(v)`, `bool(v)`. Each throws a `PyValueError` /
 * `PyTypeError` exactly where Python raises, so callers can keep the bot's
 * `try/except (TypeError, ValueError)` branches one-to-one.
 */

'use strict';

class PyValueError extends Error {}
class PyTypeError extends Error {}

// int() / float() of a str: CPython 3.11 (Unicode digits and spaces of unicodedata 14.0.0, PEP 515,
// the 4300-digit limit) — strategies/common/pynum.js.
const N = require('../../strategies/common/pynum');

/** int(v): bool → 0/1; number → truncated (finite only, never -0); numeric string; else raises. */
function pyInt(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') {
    const t = N.intFromFloat(v);
    if (t === null) throw new PyValueError(N.floatToIntErrorText(v));
    return t;
  }
  if (typeof v === 'string') {
    const lit = N.intLiteral(v);
    if (lit === null) throw new PyValueError(N.intErrorText(v));
    if (lit.limit !== undefined) throw new PyValueError(N.intLimitText(lit.limit));
    return N.intFromLiteral(lit);
  }
  throw new PyTypeError(`int() argument must be a string, a bytes-like object or a real number, not '${v === null ? 'NoneType' : typeof v}'`);
}

/** float(v): bool → 0.0/1.0; number as is; numeric string (incl. inf/nan, PEP 515 underscores); else raises. */
function pyFloat(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const x = N.floatFromStr(v);
    if (x === undefined) throw new PyValueError(N.floatErrorText(v));
    return x;
  }
  throw new PyTypeError(`float() argument must be a string or a real number, not '${v === null ? 'NoneType' : typeof v}'`);
}

/** bool(v) for JSON-shaped values: '' / 0 / null / [] / {} are falsy like in Python. */
function pyBool(v) {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  if (typeof v === 'number') return v !== 0;            // bool(float('nan')) is True, bool(-0.0) False
  return Boolean(v);
}

/** math.isclose(a, b, rel_tol, abs_tol) */
function isClose(a, b, relTol = 1e-9, absTol = 0.0) {
  if (a === b) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= Math.max(relTol * Math.max(Math.abs(a), Math.abs(b)), absTol);
}

module.exports = { pyInt, pyFloat, pyBool, isClose, PyValueError, PyTypeError };
