/**
 * Python-semantics edge cases surfaced by the adversarial fuzz (py/gen_adversarial.py rd_ / fz_
 * rows): price_precision with non-finite steps / ticks, len() / iteration / indexing of odd JSON
 * values, int() of bool / str for Bybit's timeNano. Expected values come from the bot's Python.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const req = createRequire(import.meta.url);
const PP = req('../../services/exchanges/pricePrecision.js');
const P = req('../../services/exchanges/pyCompat.js');

const run = (f, ...a) => { try { return ['ok', f(...a)]; } catch (e) { return [e.pyType || e.name, e.message]; } };

describe('price_precision with non-finite steps / ticks', () => {
  // cd MAIN_BOT/CHM_BREAKER_V4 && python -c "import price_precision as pp
  //   inf=float('inf'); nan=float('nan')
  //   for f in (pp.round_qty, pp.round_price): print([f(*a) if ... ] for a in [(1.5,inf),(1.5,nan),(inf,0.01),(nan,0.01),(1.5,-inf)])"
  const inf = Infinity;
  const nan = NaN;
  it('round_qty', () => {
    expect(run(PP.roundQty, 1.5, inf)).toEqual(['ZeroDivisionError', 'float division by zero']);
    expect(run(PP.roundQty, 1.5, nan)).toEqual(['ValueError', 'cannot convert float NaN to integer']);
    expect(run(PP.roundQty, inf, 0.01)).toEqual(['OverflowError', 'cannot convert float infinity to integer']);
    expect(run(PP.roundQty, nan, 0.01)).toEqual(['ValueError', 'cannot convert float NaN to integer']);
    expect(run(PP.roundQty, 1.5, -inf)).toEqual(['ok', '1.500']);
    expect(run(PP.roundQty, 0.0, inf)).toEqual(['ok', '0']);
  });
  it('round_price / round_price_sl / round_price_tp', () => {
    for (const f of [PP.roundPrice, (p, t) => PP.roundPriceSl(p, t, 'LONG'), (p, t) => PP.roundPriceSl(p, t, 'SHORT'),
      (p, t) => PP.roundPriceTp(p, t, 'LONG'), (p, t) => PP.roundPriceTp(p, t, 'SHORT')]) {
      expect(run(f, 1.5, inf)).toEqual(['ZeroDivisionError', 'float division by zero']);
      expect(run(f, 1.5, nan)).toEqual(['ok', 'nan']);
      expect(run(f, inf, 0.01)).toEqual(['OverflowError', 'cannot convert float infinity to integer']);
      expect(run(f, nan, 0.01)).toEqual(['ok', 'nan']);
    }
    expect(run(PP.roundPrice, 1.5, -inf)).toEqual(['ok', '1.5000']);
  });
});

describe('pyCompat edge semantics', () => {
  it('len()', () => {
    // python -c "print(len('héllo'), len([1,2]), len({'a':1}))"; len(2.5) → TypeError
    expect([P.pyLen('héllo'), P.pyLen([1, 2]), P.pyLen({ a: 1 })]).toEqual([5, 2, 1]);
    expect(run(P.pyLen, 2.5)).toEqual(['TypeError', "object of type 'float' has no len()"]);
    expect(run(P.pyLen, null)).toEqual(['TypeError', "object of type 'NoneType' has no len()"]);
  });
  it('iteration', () => {
    // python -c "print(list('ab'), list({'x':1,'y':2}))"; iter(-1) / iter(None) / iter(True) → TypeError
    expect([P.pyIter('ab'), P.pyIter({ x: 1, y: 2 })]).toEqual([['a', 'b'], ['x', 'y']]);
    expect(run(P.pyIter, -1)).toEqual(['TypeError', "'int' object is not iterable"]);
    expect(run(P.pyIter, 2.5)).toEqual(['TypeError', "'float' object is not iterable"]);
    expect(run(P.pyIter, null)).toEqual(['TypeError', "'NoneType' object is not iterable"]);
    expect(run(P.pyIter, true)).toEqual(['TypeError', "'bool' object is not iterable"]);
  });
  it('indexing a str with a str key', () => {
    // python -c "'-0.5'['list']" → TypeError: string indices must be integers, not 'str'
    expect(run(P.pyIndex, '-0.5', 'list')).toEqual(['TypeError', "string indices must be integers, not 'str'"]);
    expect(run(P.pyIndex, 'abc', 1)).toEqual(['ok', 'b']);
  });
  it('int() as exact BigInt (Bybit timeNano)', () => {
    // python -c "print(int(False), int('1767225600250000000'), int(' +12_3 '), int(1.5e18))"
    expect([P.pyBigInt(false), P.pyBigInt('1767225600250000000'), P.pyBigInt(' +12_3 '), P.pyBigInt(1.5e18)])
      .toEqual([0n, 1767225600250000000n, 123n, 1500000000000000000n]);
    expect(run(P.pyBigInt, '1.5')).toEqual(['ValueError', "invalid literal for int() with base 10: '1.5'"]);
    expect(run(P.pyBigInt, null)).toEqual(['TypeError', "int() argument must be a string, a bytes-like object or a real number, not 'NoneType'"]);
  });
});
