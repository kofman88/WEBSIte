/**
 * pyround.js — CPython round() semantics (round-half-even on the exact binary value).
 *
 * Reference values from python 3.11.17 (the bot's CPython 3.11; unchanged from 3.12.3):
 *   python3 -c "print([round(x, 2) for x in (2.675, 0.125, 0.375, 1.005, -0.125, -2.675)])"
 *     → [2.67, 0.12, 0.38, 1.0, -0.12, -2.67]
 *   python3 -c "print([round(x) for x in (2.5, 3.5, -2.5, -3.5, 0.5, 1.5)])"
 *     → [2, 4, -2, -4, 0, 2]
 *   python3 -c "print(round(1234567.891, -2), round(1e22, 2), round(123456789.9876543, 3), round(99.995, 2), round(0.045, 2))"
 *     → 1234600.0 1e+22 123456789.988 100.0 0.04
 *   python3 -c "print(round(2.9449999999999998, 2), round(0.8735, 3), round(45.35, 1), round(45.25, 1))"
 *     → 2.94 0.874 45.4 45.2
 */
import { describe, it, expect } from 'vitest';
import R from '../../strategies/common/pyround.js';

const { pyRound, pyRoundInt, exactDecimal, pyMod, pyFloorDiv, pyInt, pyFloor } = R;

describe('pyRound(x, k)', () => {
  it('rounds the exact binary value (2.675 is below the tie)', () => {
    expect(pyRound(2.675, 2)).toBe(2.67);
    expect(pyRound(1.005, 2)).toBe(1.0);
    expect(pyRound(-2.675, 2)).toBe(-2.67);
  });
  it('exact ties go to even', () => {
    expect(pyRound(0.125, 2)).toBe(0.12);
    expect(pyRound(0.375, 2)).toBe(0.38);
    expect(pyRound(-0.125, 2)).toBe(-0.12);
    expect(pyRound(2.5, 0)).toBe(2);
    expect(pyRound(3.5, 0)).toBe(4);
    expect(pyRound(0.5, 0)).toBe(0);
    expect(pyRound(1.5, 0)).toBe(2);
  });
  it('negative ndigits, large values, decimal-looking values', () => {
    expect(pyRound(1234567.891, -2)).toBe(1234600.0);
    expect(pyRound(1e22, 2)).toBe(1e22);
    expect(pyRound(123456789.9876543, 3)).toBe(123456789.988);
    expect(pyRound(99.995, 2)).toBe(100.0);   // 99.99500000000000454747... (above the tie)
    expect(pyRound(0.045, 2)).toBe(0.04);     // 0.04499999999999999833...
  });
  it('keeps the sign of zero and passes NaN/Inf through', () => {
    expect(Object.is(pyRound(-0.001, 2), -0)).toBe(true);
    expect(pyRound(Number.NaN, 2)).toBeNaN();
    expect(pyRound(Infinity, 1)).toBe(Infinity);
    expect(pyRound(-Infinity, 1)).toBe(-Infinity);
  });
  it('matches the bot fields: rr 2 dp, risk_pct 3 dp, rsi 1 dp', () => {
    expect(pyRound(2.9449999999999998, 2)).toBe(2.94);
    expect(pyRound(0.8735, 3)).toBe(0.874);  // 0.87350000000000005417... (above the tie)
    expect(pyRound(45.35, 1)).toBe(45.4);    // 45.35000000000000142...
    expect(pyRound(45.25, 1)).toBe(45.2);    // exact tie → even
  });
});

describe('pyRoundInt(x) — round(x) → int', () => {
  it('half-even on exact halves, nearest otherwise', () => {
    expect(pyRoundInt(2.5)).toBe(2);
    expect(pyRoundInt(3.5)).toBe(4);
    expect(pyRoundInt(-2.5)).toBe(-2);
    expect(pyRoundInt(-3.5)).toBe(-4);
    expect(pyRoundInt(2.4999999999999996)).toBe(2);
    expect(pyRoundInt(2.5000000000000004)).toBe(3);
    expect(pyRoundInt(330.0000000000001)).toBe(330);
    expect(Object.is(pyRoundInt(-0.4), 0)).toBe(true);
  });
  it('rejects non-finite values like Python', () => {
    expect(() => pyRoundInt(Number.NaN)).toThrow();
    expect(() => pyRoundInt(Infinity)).toThrow();
  });
});

describe('exactDecimal', () => {
  it('gives the exact expansion of 0.1 (= 0.1000000000000000055511151231257827021181583404541015625)', () => {
    const d = exactDecimal(0.1);
    expect(d.neg).toBe(false);
    expect(d.digits.toString()).toBe('1000000000000000055511151231257827021181583404541015625');
    expect(d.scale).toBe(55);
  });
  it('handles integers, negatives and subnormals', () => {
    expect(exactDecimal(12).digits).toBe(12n);
    expect(exactDecimal(-3.5).neg).toBe(true);
    const sub = exactDecimal(5e-324);
    expect(sub.scale).toBe(1074);
    expect(sub.digits.toString().length).toBe(751);
  });
});

describe('python integer/modulo helpers', () => {
  it('pyMod takes the sign of the divisor, pyFloorDiv floors', () => {
    expect(pyMod(7.5, 2)).toBe(1.5);
    expect(pyMod(-7.5, 2)).toBe(0.5);
    expect(pyMod(7.5, -2)).toBe(-0.5);
    expect(pyFloorDiv(7.5, 2)).toBe(3);
    expect(pyFloorDiv(-7.5, 2)).toBe(-4);
    expect(pyInt(-2.7)).toBe(-2);
    expect(pyFloor(-2.1)).toBe(-3);
  });
});
