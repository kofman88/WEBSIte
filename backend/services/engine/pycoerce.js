/**
 * pycoerce — Python's built-in constructors as the bot calls them on user
 * input: `int(v)`, `float(v)`, `bool(v)`. Each throws a `PyValueError` /
 * `PyTypeError` exactly where Python raises, so callers can keep the bot's
 * `try/except (TypeError, ValueError)` branches one-to-one.
 */

'use strict';

class PyValueError extends Error {}
class PyTypeError extends Error {}

// PEP 515: single underscores are allowed between digits ("1_000", "1_0.5_5", "1e1_0").
const DIGITS = '\\d(?:_?\\d)*';
const INT_RE = new RegExp(`^\\s*[+-]?${DIGITS}\\s*$`);
// float(): decimal / exponent forms (with PEP 515 underscores), inf / nan spellings (case-insensitive)
const FLOAT_RE = new RegExp(`^\\s*[+-]?(?:(?:${DIGITS}(?:\\.(?:${DIGITS})?)?|\\.${DIGITS})(?:e[+-]?${DIGITS})?|inf|infinity|nan)\\s*$`, 'i');

/** int(v): bool → 0/1; number → truncated (finite only); numeric string; else raises. */
function pyInt(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new PyValueError('cannot convert float to integer');
    return Math.trunc(v);
  }
  if (typeof v === 'string') {
    if (!INT_RE.test(v)) throw new PyValueError(`invalid literal for int() with base 10: '${v}'`);
    return parseInt(v.trim().replace(/_/g, ''), 10);
  }
  throw new PyTypeError(`int() argument must be a string, a bytes-like object or a real number, not '${v === null ? 'NoneType' : typeof v}'`);
}

/** float(v): bool → 0.0/1.0; number as is; numeric string (incl. inf/nan, PEP 515 underscores); else raises. */
function pyFloat(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    if (!FLOAT_RE.test(v)) throw new PyValueError(`could not convert string to float: '${v}'`);
    const t = v.trim().toLowerCase().replace(/_/g, '');
    if (t.endsWith('inf') || t.endsWith('infinity')) return t.startsWith('-') ? -Infinity : Infinity;
    if (t.endsWith('nan')) return NaN;
    return Number(t);
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
