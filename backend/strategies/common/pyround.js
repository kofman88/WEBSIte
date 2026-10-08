'use strict';
/**
 * pyround.js — CPython float rounding semantics.
 *
 * Python's round(x, k) (float.__round__ → double_round) converts the double to
 * its correctly rounded decimal string with k digits via _Py_dg_dtoa(mode 3),
 * rounding HALF-EVEN on the EXACT binary value, and parses it back. So
 *   round(2.675, 2) == 2.67   (2.675 is really 2.67499999999999982236431605997495353221893310546875)
 *   round(0.125, 2) == 0.12   (exact tie → even)
 *   round(0.375, 2) == 0.38
 *   round(1.005, 2) == 1.0    (1.00499999999999989...)
 *   round(2.5) == 2, round(3.5) == 4
 * This module reproduces that with exact BigInt decimal arithmetic.
 */

const BIG_TEN = 10n;

/**
 * Exact decimal decomposition of a finite double: |x| = digits / 10^scale,
 * where `digits` is a BigInt (no rounding anywhere).
 */
function exactDecimal(x) {
  const neg = x < 0 || Object.is(x, -0);
  const ax = Math.abs(x);
  if (ax === 0) return { neg, digits: 0n, scale: 0 };
  // decompose into mantissa * 2^exp
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, ax);
  const hi = buf.getUint32(0), lo = buf.getUint32(4);
  const expBits = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let exp;
  if (expBits === 0) { // subnormal
    exp = -1074;
  } else {
    mant |= 1n << 52n;
    exp = expBits - 1075;
  }
  // lowest terms: drop trailing zero bits so the decimal scale is minimal
  while (exp < 0 && (mant & 1n) === 0n) { mant >>= 1n; exp++; }
  if (exp >= 0) {
    return { neg, digits: mant << BigInt(exp), scale: 0 };
  }
  const s = -exp; // |x| = mant / 2^s = mant * 5^s / 10^s
  return { neg, digits: mant * (5n ** BigInt(s)), scale: s };
}

/** Round the non-negative integer `num / 10^drop` half-even; returns BigInt. */
function roundHalfEvenDiv(num, drop) {
  if (drop <= 0) return num * (BIG_TEN ** BigInt(-drop));
  const p = BIG_TEN ** BigInt(drop);
  const q = num / p;
  const r = num - q * p;
  const twice = r * 2n;
  if (twice > p) return q + 1n;
  if (twice < p) return q;
  return (q & 1n) === 0n ? q : q + 1n;
}

/**
 * Python round(x, k) → float. k may be negative. Non-finite x returned unchanged
 * (Python raises for inf/nan only when ndigits is None).
 */
function pyRound(x, k) {
  if (k === undefined || k === null) return pyRoundInt(x);
  if (typeof x !== 'number') x = Number(x);
  if (!Number.isFinite(x)) return x;
  const { neg, digits, scale } = exactDecimal(x);
  const drop = scale - k; // divide by 10^drop
  const q = roundHalfEvenDiv(digits, drop);
  // value = q * 10^-k
  const str = k >= 0 ? `${q}e-${k}` : `${q}e${-k}`;
  const v = Number(str);
  return neg ? -v : v;
}

/**
 * Python round(x) with no ndigits → int (returned here as a JS number; may be −0
 * only in the sense that Python returns int 0). Half-way cases go to even.
 */
function pyRoundInt(x) {
  if (typeof x !== 'number') x = Number(x);
  if (!Number.isFinite(x)) throw new RangeError('cannot round a non-finite number to an integer');
  const ax = Math.abs(x);
  const f = Math.floor(ax);
  const frac = ax - f; // exact
  let r;
  if (frac > 0.5) r = f + 1;
  else if (frac < 0.5) r = f;
  else r = (f % 2 === 0) ? f : f + 1;
  r = x < 0 ? -r : r;
  return r === 0 ? 0 : r;
}

/** Python int(x) for floats: truncation toward zero. */
function pyInt(x) {
  if (!Number.isFinite(x)) throw new RangeError('cannot convert non-finite float to integer');
  const t = Math.trunc(x);
  return t === 0 ? 0 : t;
}

/** Python math.floor(x) → int. */
function pyFloor(x) {
  if (!Number.isFinite(x)) throw new RangeError('cannot convert non-finite float to integer');
  const t = Math.floor(x);
  return t === 0 ? 0 : t;
}

/** Python float % float (result takes the sign of the divisor). */
function pyMod(a, b) {
  if (b === 0) throw new RangeError('float modulo by zero');
  const r = a % b; // JS: sign of dividend
  if (r !== 0 && (r < 0) !== (b < 0)) return r + b;
  return r;
}

/** Python a // b for floats. */
function pyFloorDiv(a, b) {
  if (b === 0) throw new RangeError('float floor division by zero');
  // CPython: mod = fmod(a, b); div = (a - mod) / b; adjust for sign; floor
  const mod = a % b;
  let div = (a - mod) / b;
  if (mod !== 0 && ((b < 0) !== (mod < 0))) div -= 1.0;
  if (div !== 0) {
    const floordiv = Math.floor(div);
    return (div - floordiv > 0.5) ? floordiv + 1.0 : floordiv;
  }
  const q = a / b;
  return (q < 0 || Object.is(q, -0)) ? -0 : 0;
}

/**
 * Python builtin max(a, b) for two numbers: the FIRST argument wins unless the second is
 * strictly greater (`b > a`), so a NaN first argument stays, a NaN second argument is
 * ignored and max(0.0, -0.0) keeps the first zero — unlike Math.max, which propagates NaN
 * and prefers +0.
 */
function pyMax(a, b) {
  return b > a ? b : a;
}

/** Python builtin min(a, b): the first argument wins unless `b < a`. */
function pyMin(a, b) {
  return b < a ? b : a;
}

module.exports = { exactDecimal, roundHalfEvenDiv, pyRound, pyRoundInt, pyInt, pyFloor, pyMod, pyFloorDiv, pyMax, pyMin };
