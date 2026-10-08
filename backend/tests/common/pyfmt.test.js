/**
 * pyfmt.js — CPython float formatting (correctly rounded, half-even on exact ties).
 *
 * Reference strings from python 3.11.17 (the bot's CPython 3.11; unchanged from 3.12.3):
 *   python3 -c "print([f'{x:.2f}' for x in (0.125, 0.375, 2.675, 1.005, -0.001, -0.0, 2.345, 1e22)])"
 *     → ['0.12', '0.38', '2.67', '1.00', '-0.00', '-0.00', '2.35', '10000000000000000000000.00']
 *   python3 -c "print(f'{2.5:.0f}', f'{3.5:.0f}', f'{0.5:.0f}', f'{1.5:.0f}', f'{1234567.891:,.1f}', f'{12345.678:,.0f}', f'{-1234.5:,.2f}')"
 *     → 2 4 0 2 1,234,567.9 12,346 -1,234.50
 *   python3 -c "print(f'{2.5:+.2f}', f'{-2.5:+.2f}', f'{0.0:+.1f}', f'{0.1234:.1%}', f'{0.125:.1%}')"
 *     → +2.50 -2.50 +0.0 12.3% 12.5%
 *   python3 -c "print(f'{0.00001234:.10g}', f'{1234.5:.10g}', f'{1e10:.10g}', f'{0.0001234:.10g}', f'{123456.7:.4g}', f'{2.5:.1g}', f'{3.5:.1g}', f'{1e-5:.6g}', f'{100.0:.6g}')"
 *     → 1.234e-05 1234.5 1e+10 0.0001234 1.235e+05 2 4 1e-05 100
 *   python3 -c "print(repr(1e16), repr(0.0001), repr(0.00001), repr(123456789012345678.0), repr(1.0), repr(-0.0), repr(1.5e-7), repr(1234567890123456.0))"
 *     → 1e+16 0.0001 1e-05 1.2345678901234568e+17 1.0 -0.0 1.5e-07 1234567890123456.0
 */
import { describe, it, expect } from 'vitest';
import F from '../../strategies/common/pyfmt.js';

const { fmtFixed, fmtComma, fmtSigned, fmtPct, fmtG, r10, pyRepr, fp, fpVolume, smartFormat, priceDecimals, fmtPriceDisplay } = F;

describe('fmtFixed — {:.kf}', () => {
  it('ties on exactly representable values go to even; non-ties use the exact value', () => {
    expect(fmtFixed(0.125, 2)).toBe('0.12');
    expect(fmtFixed(0.375, 2)).toBe('0.38');
    expect(fmtFixed(2.675, 2)).toBe('2.67');
    expect(fmtFixed(1.005, 2)).toBe('1.00');
    expect(fmtFixed(2.345, 2)).toBe('2.35'); // 2.34500000000000019984...
    expect(fmtFixed(2.5, 0)).toBe('2');
    expect(fmtFixed(3.5, 0)).toBe('4');
    expect(fmtFixed(0.5, 0)).toBe('0');
    expect(fmtFixed(1.5, 0)).toBe('2');
  });
  it('negative zero and tiny negatives print "-0.00", large values print all digits', () => {
    expect(fmtFixed(-0.001, 2)).toBe('-0.00');
    expect(fmtFixed(-0.0, 2)).toBe('-0.00');
    expect(fmtFixed(1e22, 2)).toBe('10000000000000000000000.00');
    expect(fmtFixed(Number.NaN, 2)).toBe('nan');
    expect(fmtFixed(Infinity, 2)).toBe('inf');
    expect(fmtFixed(-Infinity, 2)).toBe('-inf');
  });
  it('JS toFixed would be wrong on the tie cases', () => {
    expect((0.125).toFixed(2)).toBe('0.13');
    expect(fmtFixed(0.125, 2)).toBe('0.12');
  });
});

describe('fmtComma / fmtSigned / fmtPct', () => {
  it('thousands separators', () => {
    expect(fmtComma(1234567.891, 1)).toBe('1,234,567.9');
    expect(fmtComma(12345.678, 0)).toBe('12,346');
    expect(fmtComma(-1234.5, 2)).toBe('-1,234.50');
    expect(fmtComma(999.999, 2)).toBe('1,000.00');
    expect(fmtComma(65000.1, 0)).toBe('65,000');
  });
  it('signed', () => {
    expect(fmtSigned(2.5, 2)).toBe('+2.50');
    expect(fmtSigned(-2.5, 2)).toBe('-2.50');
    expect(fmtSigned(0.0, 1)).toBe('+0.0');
  });
  it('percent multiplies by 100 then formats', () => {
    expect(fmtPct(0.1234, 1)).toBe('12.3%');
    expect(fmtPct(0.125, 1)).toBe('12.5%');
  });
});

describe('fmtG — {:.pg} and r10', () => {
  it('switches to exponent form at decpt <= -4 or decpt > p, strips zeros', () => {
    expect(fmtG(0.00001234, 10)).toBe('1.234e-05');
    expect(fmtG(1234.5, 10)).toBe('1234.5');
    expect(fmtG(1e10, 10)).toBe('1e+10');
    expect(fmtG(0.0001234, 10)).toBe('0.0001234');
    expect(fmtG(123456.7, 4)).toBe('1.235e+05');
    expect(fmtG(2.5, 1)).toBe('2');
    expect(fmtG(3.5, 1)).toBe('4');
    expect(fmtG(1e-5, 6)).toBe('1e-05');
    expect(fmtG(100.0, 6)).toBe('100');
    expect(fmtG(0, 6)).toBe('0');
    expect(fmtG(-0.0, 6)).toBe('-0');
  });
  it('r10 = float(f"{x:.10g}") is idempotent on fixture values', () => {
    expect(r10(3.616481737)).toBe(3.616481737);
    expect(r10(6.5758817312345e-05)).toBe(6.575881731e-05);
    expect(r10(45.396634281234)).toBe(45.39663428);
    expect(r10(Number.NaN)).toBe(null);
  });
});

describe('pyRepr', () => {
  it('matches repr(float)', () => {
    expect(pyRepr(1e16)).toBe('1e+16');
    expect(pyRepr(0.0001)).toBe('0.0001');
    expect(pyRepr(0.00001)).toBe('1e-05');
    expect(pyRepr(123456789012345680)).toBe('1.2345678901234568e+17'); // == 123456789012345678.0 as a double
    expect(pyRepr(1.0)).toBe('1.0');
    expect(pyRepr(-0.0)).toBe('-0.0');
    expect(pyRepr(1.5e-7)).toBe('1.5e-07');
    expect(pyRepr(1234567890123456.0)).toBe('1234567890123456.0');
    expect(pyRepr(0.1 + 0.2)).toBe('0.30000000000000004');
  });
});

describe('bot price formatters', () => {
  // indicator._fmt_p / smc.signal_builder._fp / signal_format._fmt_price
  it('fp: adaptive precision, stripped zeros', () => {
    expect(fp(0)).toBe('0');
    expect(fp(-1)).toBe('0');
    expect(fp(65000.1)).toBe('65,000');
    expect(fp(12345.678)).toBe('12,346');
    expect(fp(2698.79)).toBe('2,698.8');
    expect(fp(100.04)).toBe('100.0');
    expect(fp(3.616481737)).toBe('3.6165');
    expect(fp(3.5)).toBe('3.5');
    expect(fp(2.0)).toBe('2');
    expect(fp(0.1523)).toBe('0.1523');
    expect(fp(0.00001234)).toBe('0.00001234');
    expect(fp(6.610423786e-05)).toBe('0.0000661'); // '0.00006610' then rstrip('0')
    expect(fp(0.045)).toBe('0.045');
    expect(() => fp(Number.NaN)).toThrow();
  });
  // volume_scanner._fp
  it('fpVolume', () => {
    expect(fpVolume(12345.678)).toBe('12,346');
    expect(fpVolume(2698.79)).toBe('2,698.79');
    expect(fpVolume(3.616481737)).toBe('3.6165');
    expect(fpVolume(0.00001234)).toBe('0.00001234');
    expect(fpVolume(0.123456789)).toBe('0.12345679');
    expect(fpVolume(0)).toBe('0');
  });
  // chart_renderer._smart_format / _price_decimals
  it('smartFormat / priceDecimals', () => {
    expect(priceDecimals(65000.1)).toBe(1);
    expect(priceDecimals(2698.79)).toBe(2);
    expect(priceDecimals(154.25)).toBe(2);
    expect(priceDecimals(1.5432)).toBe(4);
    expect(priceDecimals(0.1523)).toBe(4);
    expect(priceDecimals(0.00001234)).toBe(8);
    expect(smartFormat(65000.1)).toBe('65000.1');
    expect(smartFormat(0.00001234)).toBe('0.00001234');
    expect(smartFormat(2.345, 2)).toBe('2.35');
  });
  // price_precision.fmt_price_display docstring examples
  it('fmtPriceDisplay', () => {
    expect(fmtPriceDisplay(1.0145830379999998)).toBe('1.014583');
    expect(fmtPriceDisplay(0.98748)).toBe('0.98748');
    expect(fmtPriceDisplay(0.994129)).toBe('0.994129');
    expect(fmtPriceDisplay(4.13206e-06)).toBe('0.00000413206');
    expect(fmtPriceDisplay(0)).toBe('0');
    expect(fmtPriceDisplay(null)).toBe('0');
  });
});
