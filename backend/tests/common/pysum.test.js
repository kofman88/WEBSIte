/**
 * pysum.test.js — series.pySum against CPython 3.12 builtin sum() over floats
 * (fixtures/pysum_expected.json from fixtures/gen_pysum.py with the pinned venv): 399 lists
 * shaped like LEVELS pivot groups, mixed magnitudes, inf/nan/−0.0 edge cases; 91 of them differ
 * from a plain sequential sum (the 1-ulp zone-price divergence the golden r10 tolerance hid).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import S from '../../strategies/common/series.js';

const FIX = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'pysum_expected.json');
const EXP = JSON.parse(fs.readFileSync(FIX, 'utf8'));
const parse = (s) => (s === 'nan' ? NaN : s === 'inf' ? Infinity : s === '-inf' ? -Infinity : s === '-0.0' ? -0 : Number(s));

describe('pySum vs CPython 3.12 sum()', () => {
  it('every case is bit-identical (Object.is: NaN / signed zero exact); the sequential sum is not', () => {
    let differ = 0;
    for (const c of EXP.cases) {
      const vals = c.values.map(parse);
      const want = parse(c.sum);
      const got = S.pySum(vals);
      if (!Object.is(got, want)) throw new Error(`sum(${JSON.stringify(c.values)}) = ${got}, want ${c.sum}`);
      if (!Object.is(S.seqSum(vals), want)) differ++;
    }
    expect(EXP.cases.length).toBe(399);
    // the generator counted 91 by repr: its extra one is sum([]) → int 0 vs the float 0.0 of a sequential loop
    expect(differ).toBe(90);
  });
  it('edge semantics: empty → 0, [-0.0] → 0 (0 + x0), compensation only when finite', () => {
    expect(S.pySum([])).toBe(0);
    expect(Object.is(S.pySum([-0]), 0)).toBe(true);
    expect(S.pySum([1e16, 1.0, -1e16])).toBe(1.0);
    expect(S.seqSum([1e16, 1.0, -1e16])).toBe(0);
    expect(S.pySum([1e308, 1e308])).toBe(Infinity);
    expect(Number.isNaN(S.pySum([Infinity, -Infinity]))).toBe(true);
  });
});
