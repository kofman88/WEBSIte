'use strict';
/**
 * pyfmt.js — CPython str.format / f-string float formatting, bit-exact.
 *
 * CPython formats floats with PyOS_double_to_string → _Py_dg_dtoa, i.e. the
 * decimal digits are CORRECTLY ROUNDED from the exact binary value, ties
 * (which only exist for exactly representable values such as 0.125) go to
 * EVEN. JS toFixed() rounds half-up on the exact value instead ("0.125".toFixed(2)
 * gives "0.13", Python gives '0.12'), so everything here is built on the exact
 * BigInt decimal expansion from pyround.js.
 *
 * Supported specs — exactly the ones the bot uses in signal texts/objects:
 *   fmtFixed(x, k)   '{:.kf}'       (k = 0..n)             risk_pct:.1f, rr:.2f, {order0*100:.0f}
 *   fmtComma(x, k)   '{:,.kf}'                             fp() ≥ 100 / ≥ 10 000 prices
 *   fmtSigned(x, k)  '{:+.kf}'                             pct_signed() "+1.23%"
 *   fmtPct(x, k)     '{:.k%}'
 *   fmtG(x, p)       '{:.pg}'  (and r10 = float('{:.10g}') of the fixtures)
 *   pyRepr(x)        repr(float) / str(float)
 *   fp(v)            LEVELS/SMC `_fp` adaptive price formatter
 *   fpVolume(v)      VOLUME `_fp` (volume_scanner)
 *   fmtPriceDisplay  price_precision.fmt_price_display
 *   smartFormat      chart_renderer._smart_format / _price_decimals
 */

const { exactDecimal, roundHalfEvenDiv, pyRound } = require('./pyround');

function nonFiniteStr(x, plus = false) {
  if (Number.isNaN(x)) return plus ? '+nan' : 'nan';
  if (x > 0) return plus ? '+inf' : 'inf';
  return '-inf';
}

/** Digits of |x| rounded half-even to k decimals, as an integer string (no sign). */
function fixedDigits(x, k) {
  const { digits, scale } = exactDecimal(x);
  const q = roundHalfEvenDiv(digits, scale - k);
  return q.toString();
}

function insertPoint(intStr, k) {
  if (k <= 0) return intStr;
  const padded = intStr.padStart(k + 1, '0');
  return padded.slice(0, padded.length - k) + '.' + padded.slice(padded.length - k);
}

function groupThousands(intPart) {
  let out = '';
  let count = 0;
  for (let i = intPart.length - 1; i >= 0; i--) {
    out = intPart[i] + out;
    count++;
    if (count % 3 === 0 && i > 0) out = ',' + out;
  }
  return out;
}

/** Python f"{x:.{k}f}" */
function fmtFixed(x, k = 6) {
  x = Number(x);
  if (!Number.isFinite(x)) return nonFiniteStr(x);
  const neg = x < 0 || Object.is(x, -0);
  const body = insertPoint(fixedDigits(x, k), k);
  return (neg ? '-' : '') + body;
}

/** Python f"{x:,.{k}f}" */
function fmtComma(x, k = 6) {
  x = Number(x);
  if (!Number.isFinite(x)) return nonFiniteStr(x);
  const neg = x < 0 || Object.is(x, -0);
  const s = insertPoint(fixedDigits(x, k), k);
  const dot = s.indexOf('.');
  const intPart = dot < 0 ? s : s.slice(0, dot);
  const frac = dot < 0 ? '' : s.slice(dot);
  return (neg ? '-' : '') + groupThousands(intPart) + frac;
}

/** Python f"{x:+.{k}f}" */
function fmtSigned(x, k = 6) {
  x = Number(x);
  if (!Number.isFinite(x)) return nonFiniteStr(x, true);
  const neg = x < 0 || Object.is(x, -0);
  const body = insertPoint(fixedDigits(x, k), k);
  return (neg ? '-' : '+') + body;
}

/** Python f"{x:.{k}%}" — multiplies by 100 (float) then fixed format + '%'. */
function fmtPct(x, k = 6) {
  return fmtFixed(Number(x) * 100, k) + '%';
}

/**
 * Digits of |x| rounded half-even to `p` significant digits (dtoa mode 2):
 * returns { digits: string without trailing zeros (at least '0'), decpt } where
 * |rounded| = 0.d1d2... × 10^decpt.
 */
function sigDigits(x, p) {
  const { digits, scale } = exactDecimal(x);
  if (digits === 0n) return { digits: '0', decpt: 1 };
  const s = digits.toString();
  // value = s / 10^scale → decimal point position = s.length - scale
  let decpt = s.length - scale;
  let q;
  if (s.length <= p) {
    q = s;
  } else {
    const drop = s.length - p;
    let r = roundHalfEvenDiv(digits, drop).toString();
    if (r.length > p) { // carried to a new digit (e.g. 9.99 → 10.0)
      decpt += 1;
      r = r.slice(0, p);
    }
    q = r;
  }
  q = q.replace(/0+$/, '');
  if (q === '') q = '0';
  return { digits: q, decpt };
}

function expStr(e) {
  const sign = e < 0 ? '-' : '+';
  const a = Math.abs(e).toString().padStart(2, '0');
  return 'e' + sign + a;
}

/**
 * Python f"{x:.{p}g}" (no '#' flag): p significant digits, exponent form when
 * decpt ≤ −4 or decpt > p, trailing zeros removed.
 */
function fmtG(x, p = 6) {
  x = Number(x);
  if (!Number.isFinite(x)) return nonFiniteStr(x);
  if (p === 0) p = 1;
  const neg = x < 0 || Object.is(x, -0);
  const { digits, decpt } = sigDigits(x, p);
  let body;
  if (digits === '0') {
    body = '0';
  } else if (decpt <= -4 || decpt > p) {
    body = digits[0] + (digits.length > 1 ? '.' + digits.slice(1) : '') + expStr(decpt - 1);
  } else if (decpt <= 0) {
    body = '0.' + '0'.repeat(-decpt) + digits;
  } else if (decpt >= digits.length) {
    body = digits + '0'.repeat(decpt - digits.length);
  } else {
    body = digits.slice(0, decpt) + '.' + digits.slice(decpt);
  }
  return (neg ? '-' : '') + body;
}

/** float(f"{x:.10g}") — the rounding applied to every float in the golden fixtures. */
function r10(x) {
  if (typeof x !== 'number') return x;
  if (!Number.isFinite(x)) return null;
  return Number(fmtG(x, 10));
}

/**
 * Python repr(float): shortest round-trip digits, exponent form when the decimal
 * exponent is < −4 or ≥ 16, always at least one fractional digit otherwise.
 */
function pyRepr(x) {
  x = Number(x);
  if (!Number.isFinite(x)) return nonFiniteStr(x);
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const neg = x < 0;
  const ax = Math.abs(x);
  const ex = ax.toExponential(); // shortest round-trip digits
  const m = /^(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(ex);
  const digits = (m[1] + (m[2] || '')).replace(/0+$/, '') || '0';
  const decpt = parseInt(m[3], 10) + 1;
  let body;
  if (decpt <= -4 || decpt > 16) {
    body = digits[0] + (digits.length > 1 ? '.' + digits.slice(1) : '') + expStr(decpt - 1);
  } else if (decpt <= 0) {
    body = '0.' + '0'.repeat(-decpt) + digits;
  } else if (decpt >= digits.length) {
    body = digits + '0'.repeat(decpt - digits.length) + '.0';
  } else {
    body = digits.slice(0, decpt) + '.' + digits.slice(decpt);
  }
  return (neg ? '-' : '') + body;
}

/** str.rstrip("0").rstrip(".") */
function stripZeros(s) {
  return s.replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * LEVELS/SMC/scanner `_fp` / `_fmt_p` / signal_format._fmt_price:
 *   v <= 0 → "0"; ≥ 10 000 → '{:,.0f}'; ≥ 100 → '{:,.1f}'; ≥ 1 → '{:.4f}' stripped;
 *   else decimals = −floor(log10 v) + 3, '{:.{decimals}f}' stripped.
 * NaN raises in Python (math.floor(nan)) → throws here too.
 */
function fp(v) {
  v = Number(v);
  if (Number.isNaN(v)) throw new RangeError('fp(): cannot convert float NaN to integer');
  if (v <= 0) return '0';
  if (v >= 10000) return fmtComma(v, 0);
  if (v >= 100) return fmtComma(v, 1);
  if (v >= 1) return stripZeros(fmtFixed(v, 4));
  const decimals = -Math.floor(Math.log10(v)) + 3;
  return stripZeros(fmtFixed(v, decimals));
}

/**
 * VOLUME `_fp` (volume_scanner): ≥ 10 000 → '{:,.0f}'; ≥ 100 → '{:,.2f}';
 * ≥ 1 → '{:.4f}' stripped; else '{:.8f}' stripped (negative/zero fall here too).
 */
function fpVolume(v) {
  v = Number(v);
  if (Number.isNaN(v)) return 'nan';
  if (v >= 10000) return fmtComma(v, 0);
  if (v >= 100) return fmtComma(v, 2);
  if (v >= 1) return stripZeros(fmtFixed(v, 4));
  return stripZeros(fmtFixed(v, 8));
}

/** chart_renderer._price_decimals */
function priceDecimals(price) {
  const p = Math.abs(Number(price));
  if (!Number.isFinite(p) || p <= 0 || Number.isNaN(p)) return 2;
  if (p >= 10000) return 1;
  if (p >= 1000) return 2;
  const mag = Math.floor(Math.log10(p));
  return Math.min(12, Math.max(2, (p >= 1 ? 4 : 3) - mag));
}

/** chart_renderer._smart_format(price, decimals=None) */
function smartFormat(price, decimals = null) {
  const d = decimals == null ? priceDecimals(price) : decimals;
  return fmtFixed(Number(price), d);
}

/** price_precision.fmt_price_display */
function fmtPriceDisplay(price) {
  if (price === null || price === undefined) return '0';
  const p = Number(price);
  if (Number.isNaN(p)) return String(price);
  if (p === 0) return '0';
  const absP = Math.abs(p);
  let decimals;
  if (absP >= 1) decimals = 6;
  else if (absP >= 0.01) decimals = 7;
  else if (absP >= 0.0001) decimals = 8;
  else {
    let magnitude;
    try { magnitude = -Math.floor(Math.log10(absP)); } catch (_e) { magnitude = 12; }
    if (!Number.isFinite(magnitude)) magnitude = 12;
    decimals = magnitude + 5;
  }
  const rounded = pyRound(p, decimals);
  let s = fmtFixed(rounded, decimals);
  if (s.includes('.')) s = stripZeros(s);
  return s || '0';
}

module.exports = {
  fmtFixed, fmtComma, fmtSigned, fmtPct, fmtG, r10, pyRepr, stripZeros,
  fp, fpVolume, priceDecimals, smartFormat, fmtPriceDisplay, sigDigits,
};
