'use strict';
/**
 * pricePrecision.js — one-to-one port of `price_precision.py` (shared by all 4 traders).
 *
 *   stepDecimals(step)              decimals of f"{step:.10f}".rstrip("0") (6 if step <= 0)
 *   roundQty(qty, step)             FLOOR to step (never over-size), formatted with step decimals
 *   roundPrice(price, tick)         Decimal half-up to tick (entry / plain prices)
 *   roundPriceSl(price, tick, dir)  LONG floor / SHORT ceil  (away from entry)
 *   roundPriceTp(price, tick, dir)  LONG floor / SHORT ceil  (towards entry)
 *   fmtPriceDisplay(price)          user-facing price without float noise
 *
 * The Python helpers run `Decimal(str(price)) / Decimal(str(tick))` in the default
 * decimal context (28 significant digits, ROUND_HALF_EVEN), quantize the quotient to an
 * integer with the requested rounding, multiply back by the tick (again 28 digits),
 * convert to float and format with `f"{x:.{decimals}f}"` (round-half-even on the exact
 * binary value). All of that is reproduced with BigInt arithmetic; a quantize that would
 * need more than 28 digits raises InvalidOperation in Python and takes the float fallback
 * path, as here.
 */

const { fmtFixed, fmtPriceDisplay: _fmtPriceDisplay, pyRepr: floatRepr } = require('../../strategies/common/pyfmt');
const { ValueError, OverflowError } = require('./pyCompat');

const PREC = 28;
const TEN = 10n;

function pow10(n) { return TEN ** BigInt(n); }
function digitsOf(b) { return b === 0n ? 1 : (b < 0n ? -b : b).toString().length; }

/** Decimal(str(x)) for a finite positive float → { coef: BigInt, exp: int } (value = coef·10^exp). */
function decFromFloat(x) {
  const r = floatRepr(x); // shortest round-trip digits, Python repr layout
  const m = /^(-?)(\d+)(?:\.(\d*))?(?:e([+-]\d+))?$/.exec(r);
  if (!m) throw new Error(`decFromFloat: unexpected repr ${r}`);
  const intPart = m[2];
  const frac = m[3] || '';
  const e = m[4] ? parseInt(m[4], 10) : 0;
  let coef = BigInt(intPart + frac);
  if (m[1] === '-') coef = -coef;
  return { coef, exp: e - frac.length };
}

/** Round non-negative num/den to an integer: mode 'even' | 'half_up' | 'floor' | 'ceiling'. */
function roundDiv(num, den, mode) {
  const q = num / den;
  const r = num - q * den;
  if (r === 0n) return q;
  switch (mode) {
    case 'floor': return q;
    case 'ceiling': return q + 1n;
    case 'half_up': return (r * 2n >= den) ? q + 1n : q;
    case 'even': {
      const twice = r * 2n;
      if (twice > den) return q + 1n;
      if (twice < den) return q;
      return (q & 1n) === 0n ? q : q + 1n;
    }
    default: throw new Error(`roundDiv: bad mode ${mode}`);
  }
}

/** Round {coef≥0, exp} to at most `prec` significant digits, half-even (Decimal context rounding). */
function roundToPrec(coef, exp) {
  const d = digitsOf(coef);
  if (d <= PREC) return { coef, exp };
  const drop = d - PREC;
  let c = roundDiv(coef, pow10(drop), 'even');
  let e = exp + drop;
  if (digitsOf(c) > PREC) { c /= TEN; e += 1; } // carry 999.. → 1000..
  return { coef: c, exp: e };
}

/** Decimal division a/b (both positive) in the 28-digit context → {coef, exp}. */
function decDiv(a, b) {
  // value = (a.coef / b.coef) · 10^(a.exp − b.exp); find k so that the quotient has PREC digits.
  const shift = a.exp - b.exp;
  let k = (digitsOf(a.coef) - digitsOf(b.coef)) + shift - PREC;
  for (let guard = 0; guard < 4; guard++) {
    let num = a.coef;
    let den = b.coef;
    if (shift - k >= 0) num *= pow10(shift - k);
    else den *= pow10(k - shift);
    const q = num / den;
    const nd = digitsOf(q);
    if (nd > PREC) { k += 1; continue; }
    if (nd < PREC && num % den !== 0n) { k -= 1; continue; }
    let c = roundDiv(num, den, 'even');
    let e = k;
    if (digitsOf(c) > PREC) { c /= TEN; e += 1; }
    return { coef: c, exp: e };
  }
  throw new Error('decDiv: no convergence');
}

class InvalidOperation extends Error {}

/** quantize({coef, exp}, Decimal('1'), rounding) → BigInt integer (raises InvalidOperation like Python). */
function quantizeInt(v, mode) {
  let out;
  if (v.exp >= 0) out = v.coef * pow10(v.exp);
  else out = roundDiv(v.coef, pow10(-v.exp), mode);
  if (digitsOf(out) > PREC) throw new InvalidOperation('quantize result has too many digits for current context');
  return out;
}

function stepDecimals(step) {
  step = Number(step);
  if (step <= 0) return 6;
  const s = fmtFixed(step, 10).replace(/0+$/, '');
  const dot = s.indexOf('.');
  return dot >= 0 ? s.length - dot - 1 : 0;
}

/** Python math.floor(x) for a float (ValueError / OverflowError on nan / inf). */
function pyFloorF(x) {
  if (Number.isNaN(x)) throw ValueError('cannot convert float NaN to integer');
  if (!Number.isFinite(x)) throw OverflowError('cannot convert float infinity to integer');
  return Math.floor(x);
}
function pyCeilF(x) {
  if (Number.isNaN(x)) throw ValueError('cannot convert float NaN to integer');
  if (!Number.isFinite(x)) throw OverflowError('cannot convert float infinity to integer');
  return Math.ceil(x);
}

function roundQty(qty, qtyStep) {
  qty = Number(qty);
  qtyStep = Number(qtyStep);
  if (qtyStep <= 0) qtyStep = 0.001;
  if (qty <= 0) return fmtFixed(0.0, stepDecimals(qtyStep));
  const decimals = stepDecimals(qtyStep);
  const factor = 1.0 / qtyStep;
  const qtyFloor = pyFloorF(qty * factor) / factor;
  return fmtFixed(qtyFloor, decimals);
}

/** Shared Decimal path: quantize(price / tick) with `mode`, × tick, float, format. */
function _decRound(price, tickSize, mode, fallback) {
  const decimals = stepDecimals(tickSize);
  if (Number.isNaN(price)) return 'nan'; // Decimal('NaN') propagates → float nan → 'nan'
  try {
    if (!Number.isFinite(price)) throw new InvalidOperation('infinite');
    const dPrice = decFromFloat(price);
    const dTick = decFromFloat(tickSize);
    const q = decDiv(dPrice, dTick);
    const ticks = quantizeInt(q, mode);
    const prod = roundToPrec(ticks * dTick.coef, dTick.exp);
    const asFloat = Number(`${prod.coef}e${prod.exp}`);
    return fmtFixed(asFloat, decimals);
  } catch (e) {
    if (!(e instanceof InvalidOperation)) throw e;
    const factor = 1.0 / tickSize;
    return fmtFixed(fallback(price, factor) / factor, decimals);
  }
}

function roundPrice(price, tickSize) {
  price = Number(price);
  tickSize = Number(tickSize);
  if (tickSize <= 0) tickSize = 0.0001;
  if (price <= 0) return fmtFixed(0.0, stepDecimals(tickSize));
  return _decRound(price, tickSize, 'half_up', (p, f) => pyFloorF(p * f + 0.5));
}

function _isLong(direction) { return String(direction).toUpperCase() === 'LONG'; }

function roundPriceSl(price, tickSize, direction) {
  price = Number(price);
  tickSize = Number(tickSize);
  if (tickSize <= 0) tickSize = 0.0001;
  if (price <= 0) return fmtFixed(0.0, stepDecimals(tickSize));
  const long = _isLong(direction);
  return _decRound(price, tickSize, long ? 'floor' : 'ceiling',
    (p, f) => (long ? pyFloorF(p * f) : pyCeilF(p * f)));
}

/** Same rounding as roundPriceSl (LONG floor / SHORT ceil) — kept separate like the bot. */
function roundPriceTp(price, tickSize, direction) {
  price = Number(price);
  tickSize = Number(tickSize);
  if (tickSize <= 0) tickSize = 0.0001;
  if (price <= 0) return fmtFixed(0.0, stepDecimals(tickSize));
  const long = _isLong(direction);
  return _decRound(price, tickSize, long ? 'floor' : 'ceiling',
    (p, f) => (long ? pyFloorF(p * f) : pyCeilF(p * f)));
}

const fmtPriceDisplay = _fmtPriceDisplay;

module.exports = {
  stepDecimals, roundQty, roundPrice, roundPriceSl, roundPriceTp, fmtPriceDisplay,
  // internals (tests)
  _decFromFloat: decFromFloat, _decDiv: decDiv, InvalidOperation,
};
