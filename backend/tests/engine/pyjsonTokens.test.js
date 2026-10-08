/**
 * pyjson.pyJsonParse / parseJsonExactInts vs CPython 3.11 json.loads (fixtures/json_tokens.json
 * from fixtures/gen_json_tokens.py): int64 literals in every position, digit runs inside strings
 * with escapes, the int -0 vs the float -0.0, NaN / Infinity, malformed texts. The scanner must
 * not depend on JSON.parse source-text access (Node >= 21 only): CI and hosting may run Node 20.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);
const { pyJsonParse, parseJsonExactInts, pyJsonLoads } = req('../../services/engine/pyjson.js');
const { parseJsonPy } = req('../../services/exchanges/transport.js');
const FIX = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'json_tokens.json'), 'utf8'));
const F = { nan: NaN, inf: Infinity, '-inf': -Infinity };

function decode(v, exact) {
  if (Array.isArray(v)) return v.map((x) => decode(x, exact));
  if (v && typeof v === 'object') {
    if ('$big' in v) return exact ? v.$big : Number(v.$big);
    if ('$f' in v) return v.$f in F ? F[v.$f] : Number(v.$f);
    const o = {};
    for (const [k, x] of v.$o) o[k] = decode(x, exact);
    return o;
  }
  return v;
}

const run = (fn, text) => { try { return { ok: fn(text) }; } catch (e) { return { err: e.name }; } };

describe('pyJsonParse vs json.loads (CPython 3.11)', () => {
  it('vectors come from the production Python', () => {
    expect(FIX.python.startsWith('3.11.')).toBe(true);
    expect(FIX.cases.length).toBe(445);
  });
  it('plain mode: same value (Object.is on numbers, -0 vs 0 exact) or an error exactly where Python raises', () => {
    for (const c of FIX.cases) {
      const got = run(pyJsonParse, c.text);
      if ('$err' in (c.result || {})) expect(got, c.text).toHaveProperty('err', 'SyntaxError');
      else expect(got, c.text).toEqual({ ok: decode(c.result, false) });
    }
  });
  it('exactInts mode (exchange payloads): ints beyond 2^53 are their exact decimal string', () => {
    for (const c of FIX.cases) {
      const got = run(parseJsonExactInts, c.text);
      if ('$err' in (c.result || {})) expect(got, c.text).toHaveProperty('err', 'SyntaxError');
      else expect(got, c.text).toEqual({ ok: decode(c.result, true) });
    }
  });
  it('transport.parseJsonPy keeps BingX order ids exact', () => {
    const v = parseJsonPy('{"code":0,"data":{"order":{"orderId":1735947220470939648,"price":"0.1"}}}');
    expect(v.data.order.orderId).toBe('1735947220470939648');
  });
  it('pyJsonLoads never throws', () => {
    expect(pyJsonLoads('{1735947220470939648: 1}')).toEqual({});
    expect(pyJsonLoads('{"x": -0}')).toEqual({ x: 0 });
  });
});
