/**
 * quietHours.js — vectors printed by the bot's quiet_hours.py:
 *   normalize: (22,7)→(22,7) (5,5)→(5,14) (5,30)→(5,14) (24,3)→(-1,-1) ('x',1)→(-1,-1)
 *              (None,None)→(-1,-1) (5,-1)→(5,14) (3.7,8)→(3,8) ('7','9')→(7,9) (True,False)→(1,0)
 *   is_quiet(22,7): h=23 T, 3 T, 8 F, 22 T, 7 F; (5,9): 5 T, 9 F, 8 T; (5,5)→off; (25,3)→off
 */
import { describe, it, expect } from 'vitest';
import qh from '../../services/engine/quietHours.js';

describe('normalize(start, end)', () => {
  const cases = [
    [[22, 7], [22, 7]], [[23, 8], [23, 8]], [[0, 9], [0, 9]], [[1, 10], [1, 10]], [[-1, -1], [-1, -1]],
    [[5, 5], [5, 14]], [[5, 30], [5, 14]], [[24, 3], [-1, -1]], [['x', 1], [-1, -1]], [[null, null], [-1, -1]],
    [[5, -1], [5, 14]], [[3.7, 8], [3, 8]], [['7', '9'], [7, 9]], [[true, false], [1, 0]], [[undefined, 3], [-1, -1]],
    [[23, 23], [23, 8]], [['1.5', 3], [-1, -1]],
  ];
  for (const [[s, e], exp] of cases) {
    it(`normalize(${JSON.stringify(s)}, ${JSON.stringify(e)}) → ${JSON.stringify(exp)}`, () => {
      expect(qh.normalize(s, e)).toEqual(exp);
    });
  }
  it('PRESETS are the bot presets', () => {
    expect(qh.PRESETS).toEqual([[-1, -1], [22, 7], [23, 8], [0, 9], [1, 10]]);
  });
});

describe('window / is_quiet / label', () => {
  const u = (s, e) => ({ quiet_start: s, quiet_end: e });
  it('window rejects invalid / equal pairs', () => {
    expect(qh.window(u(22, 7))).toEqual([22, 7]);
    expect(qh.window(u(5, 5))).toEqual([-1, -1]);
    expect(qh.window(u(25, 3))).toEqual([-1, -1]);
    expect(qh.window(u(-1, -1))).toEqual([-1, -1]);
    expect(qh.window(u('22', '7'))).toEqual([22, 7]);
    expect(qh.window(u(null, 7))).toEqual([-1, -1]);
    expect(qh.window({})).toEqual([-1, -1]);
  });
  it('is_quiet across midnight and within a day', () => {
    const h = (x) => x * 3600;
    expect(qh.isQuiet(u(22, 7), h(23))).toBe(true);
    expect(qh.isQuiet(u(22, 7), h(3))).toBe(true);
    expect(qh.isQuiet(u(22, 7), h(8))).toBe(false);
    expect(qh.isQuiet(u(22, 7), h(22))).toBe(true);
    expect(qh.isQuiet(u(22, 7), h(7))).toBe(false);
    expect(qh.isQuiet(u(5, 9), h(5))).toBe(true);
    expect(qh.isQuiet(u(5, 9), h(9))).toBe(false);
    expect(qh.isQuiet(u(5, 9), h(8))).toBe(true);
    expect(qh.isQuiet(u(-1, -1), h(5))).toBe(false);
    expect(qh.isQuiet(u(5, 5), h(5))).toBe(false);
    expect(typeof qh.isQuiet(u(0, 23))).toBe('boolean');   // default clock
  });
  it('label is "HH:00–HH:00 UTC" / выкл / off', () => {
    expect(qh.label(u(22, 7))).toBe('22:00–07:00 UTC');
    expect(qh.label(u(5, 9), 'en')).toBe('05:00–09:00 UTC');
    expect(qh.label(u(-1, -1))).toBe('выкл');
    expect(qh.label(u(-1, -1), 'en')).toBe('off');
  });
});
