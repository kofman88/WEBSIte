/**
 * engineBridge.js — the app routes' reads of the engine worker's memory (the bot reads the same
 * state in-process): the worker-side answers over its own module state (candle cache, last
 * cached close, the LEVELS scanner's trend, the trend monitor), the query RPC through the
 * supervisor (answer, error, timeout, worker exit, no worker), a real worker half over a
 * MessageChannel, and the facade's "nothing known" fallbacks.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { MessageChannel } from 'worker_threads';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);
const EW = req('../../../workers/engineWorker.js');
const B = req('../../../services/engine/engineBridge.js');
const CC = req('../../../services/marketData/candleCache.js');
const { Frame } = req('../../../strategies/common/frame.js');

class FakeWorker extends EventEmitter {
  constructor() { super(); this.posted = []; }
  postMessage(m) { this.posted.push(m); }
  terminate() { Promise.resolve().then(() => this.emit('exit', 1)); return Promise.resolve(1); }
  send(m) { this.emit('message', m); }
}

const quiet = { debug() {}, info() {}, warn() {}, warning() {}, error() {} };
function frame(closes, t0 = 1_767_000_000_000, step = 900_000) {
  return Frame.fromBars(closes.map((c, i) => [t0 + i * step, c, c + 1, c - 1, c, 10]));
}

afterEach(() => {
  vi.useRealTimers();
  B.setRemote(null);
  B.setOverrides(null);
  CC._resetForTests();
});

describe('worker side: answer()', () => {
  it('cached candles (columns), current prices 15m → 1H → 4H with close > 0, scanner trend, trend monitor', () => {
    CC.initCache(100, { log: quiet });
    CC.setCandles('BTC-USDT-SWAP', '15m', frame([1, 2, 3]), { '15m': 3600 });
    CC.setCandles('ETH-USDT-SWAP', '1H', frame([5, 6]), { '1H': 3600 });
    CC.setCandles('SOL-USDT-SWAP', '15m', frame([0]), { '15m': 3600 });      // close 0 → next TF
    CC.setCandles('SOL-USDT-SWAP', '4H', frame([7]), { '4H': 3600 });
    const cols = B.answer('cachedCandles', ['BTC-USDT-SWAP', '15m']);
    expect(Array.from(cols.c)).toEqual([1, 2, 3]);
    expect(B.answer('cachedCandles', ['BTC-USDT-SWAP', '1H'])).toBe(null);
    expect(B.answer('currentPrices', [['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP', 'XRP-USDT-SWAP']]))
      .toEqual({ 'BTC-USDT-SWAP': 3, 'ETH-USDT-SWAP': 6, 'SOL-USDT-SWAP': 7, 'XRP-USDT-SWAP': null });
    const trend = { BTC: { trend_text: 'H1: 🟢' } };
    expect(B.answer('globalTrend', [], { levels: { getTrend: () => trend } })).toBe(trend);
    expect(B.answer('globalTrend', [], { levels: null })).toEqual({});
    expect(B.answer('globalTrend', [], null)).toEqual({});
    expect(B.answer('marketTrend', [])).toEqual(req('../../../services/engine/trendMonitor.js').getAll());
    expect(() => B.answer('nope', [])).toThrow(/unknown engine query/);
  });
});

describe('query RPC through the supervisor', () => {
  it('answer, error, timeout, worker exit, no worker', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const workers = [];
    const sup = EW.createSupervisor({
      delivery: { handleWorkerMessage: () => false, alertAdmins: async () => 0 }, log: quiet,
      spawn: () => { const w = new FakeWorker(); workers.push(w); return w; }, heartbeatTimeoutMs: 1e12,
    });
    await expect(sup.query('globalTrend')).rejects.toThrow(/not running/);
    sup.start();
    const w = workers[0];
    const p1 = sup.query('currentPrices', [['BTC-USDT-SWAP']], 2000);
    const q1 = w.posted.at(-1);
    expect(q1).toMatchObject({ type: 'query', method: 'currentPrices', args: [['BTC-USDT-SWAP']] });
    w.send({ type: 'query-result', id: q1.id, ok: true, result: { 'BTC-USDT-SWAP': 101.5 } });
    await expect(p1).resolves.toEqual({ 'BTC-USDT-SWAP': 101.5 });
    const p2 = sup.query('globalTrend');
    w.send({ type: 'query-result', id: w.posted.at(-1).id, ok: false, error: 'boom' });
    await expect(p2).rejects.toThrow('boom');
    const p3 = sup.query('marketTrend', [], 2000);
    const r3 = expect(p3).rejects.toThrow(/timeout/);
    await vi.advanceTimersByTimeAsync(2001);
    await r3;
    const p4 = sup.query('marketTrend', [], 2000);
    const r4 = expect(p4).rejects.toThrow(/gone/);
    w.emit('exit', 1);
    await r4;
    await sup.stop();
  });

  it('a real worker half answers over a MessageChannel', async () => {
    CC.initCache(100, { log: quiet });
    CC.setCandles('BTC-USDT-SWAP', '1H', frame([10, 11, 12]), { '1H': 3600 });
    const { port1, port2 } = new MessageChannel();
    const h = EW.runWorker(port1, { logs: false });
    const client = B.createQueryClient((m) => port2.postMessage(m));
    port2.on('message', (m) => client.handleMessage(m));
    const cols = await client.query('cachedCandles', ['BTC-USDT-SWAP', '1h'], 2000);
    expect(Array.from(B.columnsToFrame(cols).c)).toEqual([10, 11, 12]);
    expect(await client.query('currentPrices', [['BTC-USDT-SWAP', 'NOPE']], 2000)).toEqual({ 'BTC-USDT-SWAP': 12, NOPE: null });
    expect(await client.query('globalTrend', [], 2000)).toEqual({});      // no scheduler yet → no scanner
    await expect(client.query('nope', [], 2000)).rejects.toThrow(/unknown engine query/);
    await h.stop();
    port1.close();
    port2.close();
  });
});

describe('facade', () => {
  it('without a worker: this thread\'s (empty) state, the bot with nothing cached / no scanner', async () => {
    expect(await B.currentPrices(['BTC-USDT-SWAP'])).toEqual({ 'BTC-USDT-SWAP': null });
    expect(await B.cachedCandles('BTC-USDT-SWAP', '1H')).toBe(null);
    expect(await B.globalTrend()).toEqual({});
    expect(await B.marketTrend()).toEqual(req('../../../services/engine/trendMonitor.js').getAll());
  });
  it('through the remote; a failing / slow remote is "nothing known"', async () => {
    const calls = [];
    B.setRemote(async (m, a, t) => { calls.push([m, a, t]); if (m === 'globalTrend') throw new Error('timeout'); return m === 'cachedCandles' ? B.frameToColumns(frame([4, 5])) : { X: 1 }; });
    expect(await B.currentPrices(['X'])).toEqual({ X: 1 });
    expect((await B.cachedCandles('X', '15m')).length).toBe(2);
    expect(await B.globalTrend()).toEqual({});
    expect(calls.map((c) => c[0])).toEqual(['currentPrices', 'cachedCandles', 'globalTrend']);
    expect(calls[0][2]).toBe(B.DEFAULT_TIMEOUT_MS);
  });
  it('overrides win (tests)', async () => {
    B.setRemote(async () => { throw new Error('not used'); });
    B.setOverrides({ globalTrend: () => ({ BTC: { trend_text: 'x' } }) });
    expect(await B.globalTrend()).toEqual({ BTC: { trend_text: 'x' } });
  });
});
