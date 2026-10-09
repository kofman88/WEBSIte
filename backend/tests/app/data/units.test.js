/**
 * The helpers under the data routes, pinned to what the bot's runtime computes
 * (py/drive_app_data.py `unit_vectors`, CPython 3.11 + aiohttp 3.14 + yarl 1.25):
 *   • yarlUrl — PATH_SAFE_UNQUOTER, web_urldispatcher._unquote_path_safe (the match_info value),
 *     UNQUOTER_PLUS and query_to_pairs (= parse_qsl(keep_blank_values=True));
 *   • pyBody — str() / bool() / int() of json.loads values (int vs float literals, big ints,
 *     NaN / Infinity, nested repr, duplicate keys) and botBody's 4300-digit int rule.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { loadFixture } from './helpers.js';

const nodeRequire = createRequire(import.meta.url);
const Y = nodeRequire('../../../services/engine/yarlUrl.js');
const PB = nodeRequire('../../../services/engine/pyBody.js');
const { readBotBody } = nodeRequire('../../../services/engine/botBody.js');
const { PyValueError, PyTypeError } = nodeRequire('../../../services/engine/pycoerce.js');

const U = loadFixture().units;

describe('yarl / aiohttp reading of request targets', () => {
  it(`${U.paths.length} raw path segments: path_safe, match_info value, unquote_plus`, () => {
    for (const p of U.paths) {
      expect([p.raw, Y.pathSafe(p.raw)]).toEqual([p.raw, p.safe]);
      expect([p.raw, Y.unquotePathSafe(Y.pathSafe(p.raw))]).toEqual([p.raw, p.param]);
      expect([p.raw, Y.unquote(p.raw, { plus: true, replaceInvalid: true })]).toEqual([p.raw, p.plus]);
    }
  });
  it(`${U.queries.length} query strings: query_to_pairs`, () => {
    for (const q of U.queries) expect([q.raw, Y.queryToPairs(q.raw)]).toEqual([q.raw, q.pairs]);
  });
  it('MultiDictProxy.get: first value, default when absent', () => {
    const pairs = Y.queryToPairs('a=1&b=&a=2');
    expect(Y.queryGet(pairs, 'a', 'd')).toBe('1');
    expect(Y.queryGet(pairs, 'b', 'd')).toBe('');
    expect(Y.queryGet(pairs, 'c', 'd')).toBe('d');
  });
  it('dynamic route match: {id} never spans "/" nor braces', () => {
    const re = /^\/signals\/([^{}/]+)\/chart$/;
    expect(Y.matchDynamic(Y.pathSafe('/signals/a%2Fb/chart'), re)).toEqual(['a/b']);
    expect(Y.matchDynamic(Y.pathSafe('/signals/a%7Bb/chart'), re)).toBe(null);
    expect(Y.matchDynamic(Y.pathSafe('/signals//chart'), re)).toBe(null);
    expect(Y.matchDynamic(Y.pathSafe('/signals/%2E%2E/chart'), re)).toEqual(['..']);
  });
  it('raw query / path of an Express url', () => {
    expect(Y.rawQuery('/api/app/signals?a=1&b=%20#frag')).toBe('a=1&b=%20');
    expect(Y.rawQuery('/api/app/signals')).toBe('');
    expect(Y.rawPath('/signals/x%2F/chart?a=1')).toBe('/signals/x%2F/chart');
  });
});

describe('Python types of body values (json.loads → str / bool / int)', () => {
  const errName = (e) => (e instanceof PyValueError ? 'ValueError' : e instanceof PyTypeError ? 'TypeError'
    : e instanceof PB.PyOverflowError ? 'OverflowError' : e.name);
  it(`${U.bodies.length} bodies`, () => {
    for (const b of U.bodies) {
      const body = readBotBody(Buffer.from(b.text, 'utf8'), 'application/json');
      const n = PB.field(body, 'v');
      expect([b.text, n !== undefined]).toEqual([b.text, b.present]);
      if (!b.present) continue;
      expect([b.text, PB.pyStr(n)]).toEqual([b.text, b.str]);
      expect([b.text, PB.pyTruthy(n)]).toEqual([b.text, b.truthy]);
      let got;
      try { got = { int: PB.pyIntOf(n) }; } catch (e) { got = { int_exc: errName(e) }; }
      if (b.int !== undefined) expect([b.text, got.int]).toEqual([b.text, Number(b.int)]);
      else expect([b.text, got.int_exc]).toEqual([b.text, b.int_exc]);
    }
  });
  it('json.loads refuses an int literal over 4300 digits → the bot reads the body as {}', () => {
    expect(readBotBody(Buffer.from(`{"days": ${'1'.repeat(4300)}}`), 'application/json').days).toBeGreaterThan(1e300);
    expect(readBotBody(Buffer.from(`{"days": ${'1'.repeat(4301)}}`), 'application/json')).toEqual({});
    expect(readBotBody(Buffer.from(`{"a": "${'1'.repeat(5000)}", "b": ${'1'.repeat(5000)}.5}`), 'application/json').a).toHaveLength(5000);
    expect(readBotBody(Buffer.from(`{"a": [1, {"b": -${'9'.repeat(4301)}}]}`), 'application/json')).toEqual({});
  });
  it('a plain object without the pinned text falls back to its JS values', () => {
    expect(PB.pyStr(PB.field({ v: [1, 'x'] }, 'v'))).toBe("[1, 'x']");
    expect(PB.pyStr(PB.field({ v: 2.5 }, 'v'))).toBe('2.5');
    expect(PB.field({}, 'v')).toBe(undefined);
    expect(PB.field(null, 'v')).toBe(undefined);
  });
  it('the pinned text is invisible to the object (keys, JSON, spread)', () => {
    const body = readBotBody(Buffer.from('{"a": 1.0}'), 'application/json');
    expect(Object.keys(body)).toEqual(['a']);
    expect(JSON.stringify(body)).toBe('{"a":1}');
    expect({ ...body }).toEqual({ a: 1 });
    expect(PB.pyStr(PB.field(body, 'a'))).toBe('1.0');
  });
});
