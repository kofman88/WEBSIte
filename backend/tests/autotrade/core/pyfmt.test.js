/**
 * services/autotrade/pyfmt.js vs CPython 3.11: `fmt % args` (the auto-trade log lines) and
 * `tpl.format(**kwargs)` (the i18n messages). fixtures/pyfmt_vectors.json is written by
 * gen/gen_pyfmt_vectors.py with the production interpreter; a Python float arrives as {"f": x}.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const req = createRequire(import.meta.url);
const { pf, sformat, F } = req('../../../services/autotrade/pyfmt.js');

const FX = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'pyfmt_vectors.json'), 'utf8'));

function dec(v) {
  if (Array.isArray(v)) return v.map(dec);
  if (v && typeof v === 'object' && 'f' in v) {
    if (v.f === 'nan') return NaN;
    if (v.f === 'inf') return Infinity;
    if (v.f === '-inf') return -Infinity;
    return Number.isInteger(v.f) || Object.is(v.f, -0) ? F(v.f) : v.f;
  }
  if (v && typeof v === 'object' && 'd' in v) return Object.fromEntries(v.d.map(([k, x]) => [k, dec(x)]));
  return v;
}

function outcome(fn) {
  try {
    return { out: fn() };
  } catch (e) {
    return { err: [e.pyType || e.name, e.message] };
  }
}

describe('pyfmt — CPython 3.11 % and str.format', () => {
  it('fixture comes from CPython 3.11', () => {
    expect(FX.python.startsWith('3.11.')).toBe(true);
    expect(FX.cases.length).toBeGreaterThanOrEqual(100);
  });

  for (const c of FX.cases) {
    const label = c.kind === 'pf' ? `${JSON.stringify(c.fmt)} % ${JSON.stringify(c.args)}` : `${JSON.stringify(c.tpl)}.format(${JSON.stringify(c.kwargs)})`;
    it(label, () => {
      const got = c.kind === 'pf' ? outcome(() => pf(c.fmt, ...dec(c.args))) : outcome(() => sformat(c.tpl, dec(c.kwargs)));
      const exp = c.err ? { err: c.err } : { out: c.out };
      expect(got).toEqual(exp);
    });
  }
});
