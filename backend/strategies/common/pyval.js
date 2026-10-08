'use strict';
/**
 * pyval.js — CPython value semantics the engines lean on when they mirror
 * `dict.get(...) or default`, `max(a, b)`, `min(list)`, `float(x)`:
 *
 *   pyTruthy(x)   bool(x): None/False/0/0.0/""/[]/{} are falsy; NaN is TRUTHY (bool(nan) → True)
 *   pyOr(x, d)    `x or d`
 *   pyGet(o, k, d) dict.get(k, d): a key present with None returns None, not d
 *   pyFloat(x)    float(x) for the value kinds the engines meet (bool/number/numeric string);
 *                 None / non-numeric → throws (TypeError/ValueError in Python)
 *   pyMax2/pyMin2 max(a, b) / min(a, b): the FIRST argument wins unless the second compares
 *                 strictly greater/smaller (so max(nan, 1) → nan, max(1, nan) → 1)
 *   pyMaxList/pyMinList max(iterable) / min(iterable) with the same left-to-right rule
 *
 * Pure; no pandas/numpy involved (those live in series.js / pyround.js / pyfmt.js).
 */

function pyTruthy(x) {
  if (x === null || x === undefined || x === false) return false;
  if (typeof x === 'number') return x !== 0;          // NaN !== 0 → true, like Python
  if (typeof x === 'string') return x.length > 0;
  if (Array.isArray(x)) return x.length > 0;
  if (typeof x === 'object') return Object.keys(x).length > 0;
  return Boolean(x);
}

function pyOr(x, dflt) {
  return pyTruthy(x) ? x : dflt;
}

function pyGet(obj, key, dflt) {
  if (obj === null || obj === undefined) throw new TypeError(`'NoneType' object has no attribute 'get' (key ${key})`);
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : dflt;
}

// float(str): CPython 3.11 (Unicode digits and spaces, PEP 515 underscores) — common/pynum.js.
const N = require('./pynum');

function pyFloat(x) {
  if (typeof x === 'number') return x;
  if (typeof x === 'boolean') return x ? 1 : 0;
  if (typeof x === 'string') {
    const v = N.floatFromStr(x);
    if (v === undefined) throw new RangeError(N.floatErrorText(x));
    return v;
  }
  throw new TypeError(`float() argument must be a string or a real number, not '${x === null ? 'NoneType' : typeof x}'`);
}

function pyMax2(a, b) {
  return b > a ? b : a;
}

function pyMin2(a, b) {
  return b < a ? b : a;
}

function pyMaxList(xs) {
  if (!xs.length) throw new RangeError('max() arg is an empty sequence');
  let m = xs[0];
  for (let i = 1; i < xs.length; i++) if (xs[i] > m) m = xs[i];
  return m;
}

function pyMinList(xs) {
  if (!xs.length) throw new RangeError('min() arg is an empty sequence');
  let m = xs[0];
  for (let i = 1; i < xs.length; i++) if (xs[i] < m) m = xs[i];
  return m;
}

module.exports = { pyTruthy, pyOr, pyGet, pyFloat, pyMax2, pyMin2, pyMaxList, pyMinList };
