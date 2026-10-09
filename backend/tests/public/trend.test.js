/**
 * GET /api/public/trend source (services/publicTrack/trend.js): the trend monitor's persisted
 * state (engine_kv trend_state_v1, load_state + get_all of a read-only monitor), the ribbon
 * strength recomputed with the monitor's ribbon_strength over the BTC closed bars, the bot's
 * `_market()` 24 h change, the REST cadence and the failure / empty cases. No network: the REST
 * client is a fake.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tm = require('../../services/engine/trendMonitor.js');
const { createTrendSource, EMPTY_REASON } = require('../../services/publicTrack/trend.js');
const { Frame } = require('../../strategies/common/frame.js');

const T0 = 1_760_000_000;

/** a deterministic close series: drift + two sines */
function frame(n, drift, phase = 0) {
  const c = [];
  for (let i = 0; i < n; i++) c.push(100 + drift * i + 3 * Math.sin(i / 7 + phase) + Math.sin(i / 2.3));
  return Frame.fromColumns({ t: c.map((_, i) => i * 60000), o: c, h: c.map((x) => x + 1), l: c.map((x) => x - 1), c, v: c.map(() => 1) });
}

function fakeRest({ frames = {}, changes = { 'BTC-USDT-SWAP': { change_pct: 1.2345 }, 'ETH-USDT-SWAP': { change_pct: -0.385 } } } = {}) {
  const calls = { candles: [], change: [] };
  return {
    calls,
    async getCandles(symbol, tf, limit) {
      calls.candles.push([symbol, tf, limit]);
      const f = frames[tf];
      if (f instanceof Error) throw f;
      return f === undefined ? frame(300, 0.05) : f;
    },
    async get24hChange(symbol) {
      calls.change.push(symbol);
      const d = changes[symbol];
      if (d instanceof Error) throw d;
      return d === undefined ? null : d;
    },
  };
}

/** engine_kv as the worker's monitor leaves it */
function kvFromMonitor(seed) {
  const store = new Map();
  const kv = { get: (k) => (store.has(k) ? store.get(k) : null), set: (k, v) => store.set(k, v), del: (k) => store.delete(k), has: (k) => store.has(k) };
  const worker = tm.createTrendMonitor({ kv, env: {}, log: { debug() {}, info() {}, warning() {} } });
  worker._seed(seed);
  worker.saveState();
  return { kvGet: kv.get, raw: store.get(tm.KV_KEY) };
}

const SEED = {
  '15m': { trend: 'LONG', since: T0 - 3 * 3600, price: 121000.5 },
  '1H': { trend: 'LONG', since: T0 - 11 * 3600, price: 120000 },
  '4H': { trend: 'RANGE', since: T0 - 50 * 3600, price: 118000 },
  '1D': { trend: 'LONG', since: T0 - 9 * 86400, price: 110000 },
  '1W': { trend: 'SHORT', since: T0 - 20 * 86400, price: 105000 },
  '1M': { trend: 'LONG', since: 0, price: 90000 },
};

describe('trend payload', () => {
  it('trend and since are the monitor state; strength = ribbon_strength(closed bars, trend); README shape', async () => {
    const { kvGet } = kvFromMonitor(SEED);
    const frames = { '15m': frame(300, 0.08), '1H': frame(300, 0.02, 1), '4H': frame(300, -0.01, 2), '1D': frame(300, 0.3, 3), '1W': frame(300, -0.2, 4), '1M': frame(80, 0.5) };
    const rest = fakeRest({ frames });
    const src = createTrendSource({ kvGet, rest, now: () => T0 });
    const p = await src.compute();
    expect(Object.keys(p)).toEqual(['symbol', 'updated_at', 'tfs', 'change_24h', 'source']);
    expect(p).toMatchObject({ symbol: 'BTC', updated_at: T0 * 1000, source: 'trend_monitor' });
    expect(Object.keys(p.tfs)).toEqual(['15m', '1H', '4H', '1D', '1W', '1M']);
    for (const tf of tm.TFS) {
      expect(Object.keys(p.tfs[tf])).toEqual(['trend', 'strength', 'since']);
      expect(p.tfs[tf].trend).toBe(SEED[tf].trend);
      expect(p.tfs[tf].strength).toBe(tm.ribbonStrength(frames[tf], SEED[tf].trend));
      expect(Number.isInteger(p.tfs[tf].strength)).toBe(true);
    }
    expect(p.tfs['15m'].since).toBe((T0 - 3 * 3600) * 1000);
    expect(p.tfs['1M'].since).toBeNull();                       // since 0 → unknown
    expect(p.change_24h).toEqual({ BTC: 1.23, ETH: -0.39 });    // round(x, 2) like _market()
    expect(rest.calls.candles.map((c) => [c[1], c[2]])).toEqual(expect.arrayContaining([['15m', 300], ['1M', 120]]));
    const json = JSON.stringify(p);
    expect(json).not.toContain('price');
    expect(json).not.toContain('121000');
  });

  it('round() is Python\'s (half-even on the binary value)', async () => {
    const { kvGet } = kvFromMonitor(SEED);
    const rest = fakeRest({ changes: { 'BTC-USDT-SWAP': { change_pct: 2.675 }, 'ETH-USDT-SWAP': { change_pct: '0.125' } } });
    const p = await createTrendSource({ kvGet, rest, now: () => T0 }).compute();
    expect(p.change_24h).toEqual({ BTC: 2.67, ETH: 0.12 });
  });

  it('a TF the monitor has no state for is left out; fewer than 60 bars → strength null', async () => {
    const seed = { ...SEED };
    delete seed['1W'];
    const { kvGet } = kvFromMonitor(seed);
    const p = await createTrendSource({ kvGet, rest: fakeRest({ frames: { '1D': frame(40, 0.1) } }), now: () => T0 }).compute();
    expect(Object.keys(p.tfs)).toEqual(['15m', '1H', '4H', '1D', '1M']);
    expect(p.tfs['1D'].strength).toBeNull();
  });

  it('REST failures: strength / change null, never a made-up number', async () => {
    const { kvGet } = kvFromMonitor(SEED);
    const boom = new Error('network');
    const rest = fakeRest({ frames: Object.fromEntries(tm.TFS.map((tf) => [tf, boom])), changes: { 'BTC-USDT-SWAP': boom } });
    const p = await createTrendSource({ kvGet, rest, now: () => T0 }).compute();
    for (const tf of tm.TFS) expect(p.tfs[tf]).toMatchObject({ trend: SEED[tf].trend, strength: null });
    expect(p.change_24h).toEqual({ BTC: null, ETH: null });
  });

  it('a REST call that hangs times out (6 s in production)', async () => {
    const { kvGet } = kvFromMonitor(SEED);
    const rest = { getCandles: () => new Promise(() => {}), get24hChange: () => new Promise(() => {}) };
    const p = await createTrendSource({ kvGet, rest, now: () => T0, timeoutMs: 5 }).compute();
    expect(p.tfs['15m'].strength).toBeNull();
    expect(p.change_24h).toEqual({ BTC: null, ETH: null });
  });

  it('no state for 15m / 1H / 4H → the empty payload the landing renders', async () => {
    expect(await createTrendSource({ kvGet: () => null, rest: fakeRest(), now: () => T0 }).compute()).toEqual({ empty: true, reason: EMPTY_REASON });
    const { kvGet } = kvFromMonitor({ '15m': 'LONG', '1H': 'LONG', '1D': 'SHORT' });
    expect((await createTrendSource({ kvGet, rest: fakeRest(), now: () => T0 }).compute()).empty).toBe(true);
    expect((await createTrendSource({ kvGet: () => 'not json', rest: fakeRest(), now: () => T0 }).compute()).empty).toBe(true);
  });

  it('load_state rules: entries without a trend and unknown TFs are ignored', async () => {
    const raw = JSON.stringify({ '15m': { trend: 'SHORT', since: T0 }, '1H': { trend: 'LONG', since: T0 }, '4H': { trend: 'RANGE' }, '5m': { trend: 'LONG' }, '1D': { trend: '' } });
    const p = await createTrendSource({ kvGet: () => raw, rest: fakeRest(), now: () => T0 }).compute();
    expect(Object.keys(p.tfs)).toEqual(['15m', '1H', '4H']);
    expect(p.tfs['4H'].since).toBeNull();
  });
});

describe('REST cadence', () => {
  it('15m / 1H / 4H bars refetched every minute, 1D / 1W / 1M every 30 min (TREND_REST_REFRESH_S)', async () => {
    const { kvGet } = kvFromMonitor(SEED);
    const rest = fakeRest();
    const clock = { t: T0 };
    const src = createTrendSource({ kvGet, rest, now: () => clock.t });
    const count = () => Object.fromEntries(tm.TFS.map((tf) => [tf, rest.calls.candles.filter((c) => c[1] === tf).length]));
    await src.compute();
    clock.t += 60;
    await src.compute();
    expect(count()).toEqual({ '15m': 2, '1H': 2, '4H': 2, '1D': 1, '1W': 1, '1M': 1 });
    clock.t = T0 + 1800;
    await src.compute();
    expect(count()).toEqual({ '15m': 3, '1H': 3, '4H': 3, '1D': 2, '1W': 2, '1M': 2 });
  });

  it('a failed refetch keeps the last bars instead of dropping the strength', async () => {
    const { kvGet } = kvFromMonitor(SEED);
    const frames = {};
    const rest = fakeRest({ frames });
    const clock = { t: T0 };
    const src = createTrendSource({ kvGet, rest, now: () => clock.t });
    const a = await src.compute();
    frames['15m'] = new Error('down');
    clock.t += 120;
    const b = await src.compute();
    expect(b.tfs['15m'].strength).toBe(a.tfs['15m'].strength);
    expect(b.tfs['15m'].strength).not.toBeNull();
  });
});

describe('the running engine worker (engine bridge) as the source', () => {
  const bridge = require('../../services/engine/engineBridge.js');
  /** the worker monitor's get_all() for SEED with strengths on some TFs */
  function workerAll(strengths) {
    const w = tm.createTrendMonitor({ kv: { get: () => null, set() {}, del() {}, has: () => false }, env: {}, log: { debug() {}, info() {}, warning() {} } });
    w._seed(SEED, strengths);
    return w.getAll();
  }

  it('trend / since / strength come from the worker get_all(); REST bars only for a TF without a strength yet', async () => {
    const all = workerAll({ '15m': 83.7, '1H': 41, '4H': 0, '1D': 100, '1W': 12.5 });     // 1M: not measured yet
    const rest = fakeRest();
    const kvGet = () => { throw new Error('kv must not be read while the worker answers'); };
    const src = createTrendSource({ kvGet, rest, now: () => T0, live: async () => all });
    const p = await src.compute();
    expect(Object.keys(p.tfs)).toEqual(tm.TFS);
    expect(p.tfs['15m']).toEqual({ trend: 'LONG', strength: 83, since: (T0 - 3 * 3600) * 1000 });
    expect(p.tfs['4H']).toEqual({ trend: 'RANGE', strength: 0, since: (T0 - 50 * 3600) * 1000 });
    expect(p.tfs['1W'].strength).toBe(12);
    expect(rest.calls.candles.map((c) => c[1])).toEqual(['1M']);
    expect(p.tfs['1M'].strength).toBe(tm.ribbonStrength(frame(300, 0.05), 'LONG'));
    expect(p.tfs['1M'].since).toBeNull();
    expect(all['1M'].strength).toBeUndefined();                                // the worker's answer is not mutated
    expect(p.change_24h).toEqual({ BTC: 1.23, ETH: -0.39 });
  });

  it('no 15m / 1H / 4H on the worker yet, an error or a non-object → the persisted state (kv) as before', async () => {
    const { kvGet } = kvFromMonitor(SEED);
    for (const live of [async () => ({ '15m': { trend: 'LONG', since: 1 } }), async () => { throw new Error('gone'); }, async () => null, async () => 'x', null]) {
      const rest = fakeRest();
      const p = await createTrendSource({ kvGet, rest, now: () => T0, live }).compute();
      expect(p.tfs['1H']).toMatchObject({ trend: 'LONG', since: (T0 - 11 * 3600) * 1000 });
      expect(rest.calls.candles).toHaveLength(6);
    }
  });

  it('default live(): the bridge only while startEngine installed the worker query, else the kv path', async () => {
    const { kvGet } = kvFromMonitor(SEED);
    const calls = [];
    try {
      bridge.setRemote(async (method) => { calls.push(method); return workerAll({ '15m': 50, '1H': 50, '4H': 50, '1D': 50, '1W': 50, '1M': 50 }); });
      expect(bridge.hasRemote()).toBe(true);
      const rest = fakeRest();
      const p = await createTrendSource({ kvGet: () => null, rest, now: () => T0 }).compute();
      expect(calls).toEqual(['marketTrend']);
      expect(p.tfs['15m']).toEqual({ trend: 'LONG', strength: 50, since: (T0 - 3 * 3600) * 1000 });
      expect(rest.calls.candles).toHaveLength(0);
    } finally {
      bridge.setRemote(null);
    }
    expect(bridge.hasRemote()).toBe(false);
    const rest = fakeRest();
    const p = await createTrendSource({ kvGet, rest, now: () => T0 }).compute();
    expect(rest.calls.candles).toHaveLength(6);
    expect(p.tfs['15m'].trend).toBe('LONG');
    expect(calls).toEqual(['marketTrend']);
  });
});
