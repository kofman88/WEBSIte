/**
 * globalTrend.js — trend monitor aliases/periods (values from the bot's trend_monitor),
 * trendAt, globalTrendMark, and the cached BTC/ETH header text.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const req = createRequire(import.meta.url);
const GT = req('../../services/marketData/globalTrend.js');
const FR = req('../../strategies/common/frame.js');
import { silentLog } from './helpers.js';

const { normTf, emaPeriods, trendAt, globalTrendMark, createGlobalTrend, resolveInterval, TREND_MARK, UNKNOWN_MARK, DEFAULT_INTERVAL_S } = GT;
const { Frame } = FR;
const H1 = 3_600_000;

function series(n, fn) {
  const bars = [];
  for (let i = 0; i < n; i++) { const c = fn(i); bars.push([i * H1, c, c, c, c, 1]); }
  return Frame.fromBars(bars);
}

describe('aliases and periods (trend_monitor)', () => {
  it.each([
    ['1H', '1H', [50, 200]], ['4H', '4H', [50, 200]], ['1D', '1D', [50, 200]], ['1W', '1W', [20, 50]], ['1M', '1M', [10, 20]],
    ['15m', '15m', [50, 200]], ['1h', '1H', [50, 200]], ['30m', '1H', [50, 200]], ['2h', '4H', [50, 200]], ['zz', '15m', [50, 200]],
    ['', '15m', [50, 200]], [null, '15m', [50, 200]], ['4h', '4H', [50, 200]], ['1d', '1D', [50, 200]],
  ])('normTf(%s) → %s, periods %s', (tf, norm, periods) => {
    expect(normTf(tf)).toBe(norm);
    expect(emaPeriods(normTf(tf))).toEqual(periods);
  });

  it('TREND_UPDATE_INTERVAL env, default 900', () => {
    expect(DEFAULT_INTERVAL_S).toBe(900);
    expect(resolveInterval({})).toBe(900);
    expect(resolveInterval({ TREND_UPDATE_INTERVAL: '60' })).toBe(60);
    expect(resolveInterval({ TREND_UPDATE_INTERVAL: 'x' })).toBe(900);
  });
});

describe('trendAt', () => {
  it('LONG / SHORT / RANGE on bar i, null out of range', () => {
    const c = [10, 10, 10], f = [9, 11, 9], s = [8, 12, 8];
    expect(trendAt(c, f, s, 0)).toBe('LONG');      // c > s and f > s
    expect(trendAt(c, f, s, 1)).toBe('SHORT');     // c < s and f < s
    expect(trendAt([10, 10], [7, 7], [8, 8], -1)).toBe('RANGE');   // c > s but f < s
    expect(trendAt(c, f, s, -1)).toBe('LONG');
    expect(trendAt(c, f, s, 3)).toBe(null);
    expect(trendAt(c, f, s, -4)).toBe(null);
  });
});

describe('globalTrendMark', () => {
  it('frame=null → the monitor state for BTC only', () => {
    expect(globalTrendMark('BTC', '1H', null, { getMonitorTrend: () => 'LONG' })).toBe('🟢');
    expect(globalTrendMark('BTC', '1H', null, { getMonitorTrend: () => 'SHORT' })).toBe('🔴');
    expect(globalTrendMark('BTC', '1H', null, { getMonitorTrend: () => 'RANGE' })).toBe('⚪');
    expect(globalTrendMark('BTC', '1H', null, { getMonitorTrend: () => null })).toBe(null);
    expect(globalTrendMark('BTC', '1H', null, {})).toBe(null);
    expect(globalTrendMark('ETH', '1H', null, { getMonitorTrend: () => 'LONG' })).toBe(null);
    expect(TREND_MARK).toEqual({ LONG: '🟢', SHORT: '🔴', RANGE: '⚪' });
    expect(UNKNOWN_MARK).toBe('❓');
  });

  it('computes on the last closed bar with per-TF EMA periods, null when too short', () => {
    expect(globalTrendMark('ETH', '1H', series(204, (i) => 100 + i))).toBe(null);          // < slow + 5
    expect(globalTrendMark('ETH', '1H', series(205, (i) => 100 + i))).toBe('🟢');
    expect(globalTrendMark('ETH', '4H', series(260, (i) => 1000 - i))).toBe('🔴');
    expect(globalTrendMark('ETH', '1W', series(54, (i) => 100 + i))).toBe(null);           // 1W: 20/50 → needs 55
    expect(globalTrendMark('ETH', '1W', series(55, (i) => 100 + i))).toBe('🟢');
    expect(globalTrendMark('BTC', '1M', series(25, (i) => 100 - i))).toBe('🔴');          // 1M: 10/20
    // flat series: close == ema → RANGE
    expect(globalTrendMark('ETH', '1D', series(300, () => 5))).toBe('⚪');
    // sharp reversal at the end: close below both EMAs but EMA50 still above EMA200 → RANGE
    expect(globalTrendMark('ETH', '1H', series(300, (i) => (i < 295 ? 100 + i : 10)))).toBe('⚪');
    expect(globalTrendMark('ETH', '1H', { length: 300, c: null }, { log: silentLog })).toBe(null); // exception → null
  });
});

describe('createGlobalTrend', () => {
  function fakeRest(fn) {
    const calls = [];
    return { calls, async getCandles(sym, tf, limit) { calls.push([sym, tf, limit]); return fn(sym, tf); } };
  }

  it('builds "H1: 🟢 | H4: 🔴 | D1: ⚪ | W1: ❓" per symbol from 8 parallel requests', async () => {
    const rest = fakeRest((sym, tf) => {
      if (tf === '1H') return series(300, (i) => 100 + i);
      if (tf === '4H') return series(300, (i) => 1000 - i);
      if (tf === '1D') return series(300, () => 5);
      return null;                                     // 1W → ❓
    });
    const gt = createGlobalTrend({ rest, now: () => 1000, env: {}, log: silentLog });
    const r = await gt.get();
    expect(r).toEqual({ BTC: { trend_text: 'H1: 🟢 | H4: 🔴 | D1: ⚪ | W1: ❓' }, ETH: { trend_text: 'H1: 🟢 | H4: 🔴 | D1: ⚪ | W1: ❓' } });
    expect(rest.calls).toHaveLength(8);
    expect(rest.calls).toContainEqual(['BTC-USDT-SWAP', '1W', 300]);
    expect(rest.calls).toContainEqual(['ETH-USDT-SWAP', '1D', 300]);
    expect(gt.interval).toBe(900);
  });

  it('BTC uses the confirmed monitor state and skips the REST call; errors → ❓', async () => {
    const rest = fakeRest((sym, tf) => { if (sym.startsWith('ETH') && tf === '1H') throw new Error('net'); return series(300, (i) => i); });
    const gt = createGlobalTrend({ rest, now: () => 1000, env: {}, log: silentLog, getMonitorTrend: (tf) => (tf === '1D' ? 'SHORT' : 'LONG') });
    const r = await gt.get();
    expect(r.BTC.trend_text).toBe('H1: 🟢 | H4: 🟢 | D1: 🔴 | W1: 🟢');
    expect(r.ETH.trend_text).toBe('H1: ❓ | H4: 🟢 | D1: 🟢 | W1: 🟢');
    expect(rest.calls.filter(([s]) => s.startsWith('BTC'))).toHaveLength(0);
    expect(rest.calls.filter(([s]) => s.startsWith('ETH'))).toHaveLength(4);
  });

  it('caches the result for the interval and refreshes afterwards', async () => {
    let t = 1000;
    const rest = fakeRest(() => series(300, (i) => i));
    const gt = createGlobalTrend({ rest, now: () => t, env: { TREND_UPDATE_INTERVAL: '100' }, log: silentLog });
    const a = await gt.get();
    t = 1099;
    expect(await gt.get()).toBe(a);
    expect(rest.calls).toHaveLength(8);
    t = 1100;
    const b = await gt.get();
    expect(b).not.toBe(a);
    expect(rest.calls).toHaveLength(16);
    gt.invalidate();
    await gt.get();
    expect(rest.calls).toHaveLength(24);
  });
});
