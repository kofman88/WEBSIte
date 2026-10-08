/**
 * pysum.test.js — series.pySum against the production interpreter's builtin sum() over floats
 * (CPython 3.11; fixtures/pysum_expected.json from fixtures/gen_pysum.py): 399 lists shaped like
 * LEVELS pivot groups, mixed magnitudes, inf/nan/−0.0 edge cases. On 3.11 every one equals a plain
 * sequential sum (CPython 3.12's compensated sum would differ on 90 of them).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import S from '../../strategies/common/series.js';

const FIX = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'pysum_expected.json');
const EXP = JSON.parse(fs.readFileSync(FIX, 'utf8'));
const parse = (s) => (s === 'nan' ? NaN : s === 'inf' ? Infinity : s === '-inf' ? -Infinity : s === '-0.0' ? -0 : Number(s));

describe('pySum vs CPython 3.11 sum() (production)', () => {
  it('vectors come from Python 3.11', () => {
    expect(EXP.python.startsWith('3.11.')).toBe(true);
  });
  it('every case is bit-identical (Object.is: NaN / signed zero exact) and equals the sequential sum', () => {
    for (const c of EXP.cases) {
      const vals = c.values.map(parse);
      const want = parse(c.sum);
      const got = S.pySum(vals);
      if (!Object.is(got, want)) throw new Error(`sum(${JSON.stringify(c.values)}) = ${got}, want ${c.sum}`);
      if (!Object.is(S.seqSum(vals), want)) throw new Error(`seqSum differs on ${JSON.stringify(c.values)}`);
    }
    expect(EXP.cases.length).toBe(399);
  });
  it('edge semantics: empty → 0, [-0.0] → 0 (0 + x0), no compensation', () => {
    expect(S.pySum([])).toBe(0);
    expect(Object.is(S.pySum([-0]), 0)).toBe(true);
    expect(S.pySum([1e16, 1.0, -1e16])).toBe(0);           // 3.12 would give 1.0
    expect(S.pySum([0.1, 0.2, 0.3])).toBe(0.6000000000000001);
    expect(S.pySum([1e308, 1e308])).toBe(Infinity);
    expect(Number.isNaN(S.pySum([Infinity, -Infinity]))).toBe(true);
  });
});
