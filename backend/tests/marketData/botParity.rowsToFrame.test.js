/**
 * Bot parity — `rowsToFrame` vs `fetcher_bingx._rows_to_df` on the generated payloads
 * (fixtures/marketData/parity/rows_to_df.json, generator parity/gen/gen_rows_to_df.py):
 * duplicates, forming bars, 1000× symbols, NaN/inf, out-of-order rows, python int()/float()
 * string grammar (underscores, unicode digits, signs, exponents), dict/list rows, tf tables.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { loadParity, sameFrame } from './parityHelpers.js';

const req = createRequire(import.meta.url);
const CF = req('../../services/marketData/candleFrame.js');
const fx = loadParity('rows_to_df.json');

describe('rowsToFrame == fetcher_bingx._rows_to_df (bot-generated payloads)', () => {
  expect(fx.cases.length).toBeGreaterThanOrEqual(30);
  for (const c of fx.cases) {
    it(c.name, () => {
      const f = CF.rowsToFrame(c.rows, c.tf, c.mult, c.now_ms);
      if (c.expected === null) {
        expect(f).toBe(null);
        return;
      }
      sameFrame(f, c.expected, c.name);
    });
  }
});

describe('python number grammar pinned by the bot run', () => {
  it('int(): single underscores between digits, unicode decimal digits, no floats', () => {
    expect(CF.pyInt('1_700_000_000_000')).toBe(1_700_000_000_000);
    expect(() => CF.pyInt('1__700000000000')).toThrow();
    expect(() => CF.pyInt('_10')).toThrow();
    expect(() => CF.pyInt('10_')).toThrow();
    expect(CF.pyInt('٣')).toBe(3);               // Arabic-Indic three
    expect(CF.pyInt('１２')).toBe(12);            // fullwidth
    expect(CF.pyInt('+5')).toBe(5);
    expect(() => CF.pyInt('11.0')).toThrow();
    expect(() => CF.pyInt('1e3')).toThrow();
    expect(CF.pyInt(false)).toBe(0);
    expect(CF.pyInt(1700000000000.9)).toBe(1700000000000);
  });

  it('float(): python grammar incl. 1_0.5_5e1_0, fullwidth digits, INFINITY / -NaN words', () => {
    expect(CF.pyFloat('1_0.5_5e1_0')).toBe(105500000000.0);
    expect(() => CF.pyFloat('1__0')).toThrow();
    expect(() => CF.pyFloat('0x10')).toThrow();
    expect(CF.pyFloat('１２')).toBe(12);
    expect(CF.pyFloat('\t 7E-2 \n')).toBe(0.07);
    expect(CF.pyFloat('INFINITY')).toBe(Infinity);
    expect(Number.isNaN(CF.pyFloat('-NaN'))).toBe(true);
    expect(() => CF.pyFloat('1e')).toThrow();
    expect(() => CF.pyFloat('e5')).toThrow();
    expect(() => CF.pyFloat('1.5.5')).toThrow();
    expect(() => CF.pyFloat('+-1')).toThrow();
    expect(() => CF.pyFloat('- 1')).toThrow();
    expect(CF.pyFloat('5.')).toBe(5);
    expect(CF.pyFloat('.5')).toBe(0.5);
    expect(CF.asciiDigits('x٣١２y')).toBe('x312y');
  });
});
