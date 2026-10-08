/**
 * cacheWarmer.js — env parsing, cold detection (not reserved / stale reservation with an
 * empty cache), the reservation pattern around the fetch, rate pacing, the loop.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
const req = createRequire(import.meta.url);
const CW = req('../../services/marketData/cacheWarmer.js');
const CC = req('../../services/marketData/candleCache.js');
import { closedFrame, sleepSpy, silentLog, logSpy } from './helpers.js';

const { CacheWarmer } = CW;
const H1 = 3_600_000;

let nowS = 1_000_000;
function fakeFeed(subs = []) {
  const feed = {
    subscriptions: subs,
    _loadedChannels: new Set(),
    _channelFillTs: new Map(),
    reserveChannel(k) { feed._loadedChannels.add(k); feed._channelFillTs.set(k, nowS); },
    channelStale(k) { return feed._loadedChannels.has(k) && nowS - (feed._channelFillTs.get(k) || 0) >= 60; },
  };
  return feed;
}

beforeEach(() => { nowS = 1_000_000; CC.initCache(100, { now: () => nowS, log: silentLog }); });
afterEach(() => CC._resetForTests());

describe('construction', () => {
  it('fromEnv parses rate/interval with the bot floors (0.5 r/s, 5 s)', () => {
    const w = CacheWarmer.fromEnv(fakeFeed(), {}, { env: { CACHE_WARMER_RATE: '0.1', CACHE_WARMER_INTERVAL: '2' }, log: silentLog });
    expect(w.stats.rate_per_sec).toBe(0.5);
    expect(w._cycleInterval).toBe(5);
    const d = CacheWarmer.fromEnv(fakeFeed(), {}, { env: {}, log: silentLog });
    expect(d.stats.rate_per_sec).toBe(5);
    expect(d._cycleInterval).toBe(30);
    const bad = CacheWarmer.fromEnv(fakeFeed(), {}, { env: { CACHE_WARMER_RATE: 'x' }, log: silentLog });
    expect(bad.stats.rate_per_sec).toBe(5);
  });

  it('start is a no-op with CACHE_WARMER_ENABLED=0', async () => {
    const log = logSpy();
    const w = new CacheWarmer(fakeFeed(), {}, { env: { CACHE_WARMER_ENABLED: '0' }, log });
    await w.start();
    expect(w.running).toBe(false);
    expect(log.lines.info).toEqual(['[WARMER-DISABLED] CACHE_WARMER_ENABLED=0']);
  });
});

describe('warmOneCycle', () => {
  it('detects cold channels, reserves before fetching, stores with TTL_MAP, paces at 1/rate', async () => {
    const feed = fakeFeed([['BTC-USDT-SWAP', '1H'], ['ETH-USDT-SWAP', '1H'], ['SOL-USDT-SWAP', '15m'], ['XRP-USDT-SWAP', '4H']]);
    feed.reserveChannel('ETH-USDT-SWAP_1H');                       // fresh reservation → warm
    feed.reserveChannel('SOL-USDT-SWAP_15m');
    feed._channelFillTs.set('SOL-USDT-SWAP_15m', nowS - 61);       // stale + empty cache → cold
    feed.reserveChannel('XRP-USDT-SWAP_4H');
    feed._channelFillTs.set('XRP-USDT-SWAP_4H', nowS - 61);
    CC.setCandles('XRP-USDT-SWAP', '4H', closedFrame(0, 5, 4 * H1), { '4H': 600 });  // stale but cached → warm
    const order = [];
    const fetcher = { async getCandles(s, tf, limit) { order.push(['fetch', s, tf, limit, feed._loadedChannels.has(`${s}_${tf}`)]); return closedFrame(0, 10, H1); } };
    const sleep = sleepSpy();
    const log = logSpy();
    const w = new CacheWarmer(feed, fetcher, { ratePerSec: 4, sleep, log, now: () => nowS, env: {} });
    await w.warmOneCycle();
    expect(order).toEqual([['fetch', 'BTC-USDT-SWAP', '1H', 300, true], ['fetch', 'SOL-USDT-SWAP', '15m', 300, true]]);
    expect(sleep.calls).toEqual([250, 250]);
    expect(CC.getCandles('BTC-USDT-SWAP', '1H').length).toBe(10);
    expect(CC.getCache()._data.get('BTC-USDT-SWAP_1H').expiresAt).toBe(nowS + 14400);
    expect(CC.getCache()._data.get('SOL-USDT-SWAP_15m').expiresAt).toBe(nowS + 3600);
    expect(w.stats.total_warmed).toBe(2);
    expect(log.lines.info).toEqual([
      '[WARMER-CYCLE] cold=2 / total=4 — fill at 4.0/sec',
      '[WARMER-DONE] warmed=2 errors=0 total_warmed=2 cold_remaining=0',
    ]);
  });

  it('no data releases the reservation; a throwing fetch releases and counts an error', async () => {
    const feed = fakeFeed([['A-USDT-SWAP', '1H'], ['B-USDT-SWAP', '1H'], ['C-USDT-SWAP', '1H']]);
    const fetcher = {
      async getCandles(s) {
        if (s.startsWith('A')) return null;
        if (s.startsWith('B')) throw new Error('boom');
        return closedFrame(0, 1, H1);
      },
    };
    const log = logSpy();
    const w = new CacheWarmer(feed, fetcher, { ratePerSec: 5, sleep: sleepSpy(), log, now: () => nowS, env: {} });
    await w.warmOneCycle();
    expect(feed._loadedChannels.has('A-USDT-SWAP_1H')).toBe(false);
    expect(feed._loadedChannels.has('B-USDT-SWAP_1H')).toBe(false);
    expect(feed._loadedChannels.has('C-USDT-SWAP_1H')).toBe(true);
    expect(w.stats.total_errors).toBe(1);
    expect(w.stats.total_warmed).toBe(1);
    expect(log.lines.info[1]).toBe('[WARMER-DONE] warmed=1 errors=1 total_warmed=1 cold_remaining=1');
  });

  it('warmChannel returns false for a fresh reservation, without a fetch', async () => {
    const feed = fakeFeed([['A-USDT-SWAP', '1H']]);
    feed.reserveChannel('A-USDT-SWAP_1H');
    let fetched = 0;
    const w = new CacheWarmer(feed, { async getCandles() { fetched++; return closedFrame(0, 1, H1); } }, { sleep: sleepSpy(), log: silentLog, env: {} });
    expect(await w.warmChannel('A-USDT-SWAP', '1H')).toBe(false);
    expect(fetched).toBe(0);
    await w.warmOneCycle();                                         // all warm → nothing
    expect(fetched).toBe(0);
  });

  it('no subscriptions / no feed → nothing happens', async () => {
    const w = new CacheWarmer(fakeFeed([]), {}, { sleep: sleepSpy(), log: silentLog, env: {} });
    await w.warmOneCycle();
    const w2 = new CacheWarmer(null, null, { sleep: sleepSpy(), log: silentLog, env: {} });
    await w2.warmOneCycle();
    expect(w.stats.cycles).toBe(0);
  });

  it('feeds without channelStale treat every reservation as warm', async () => {
    const feed = { subscriptions: [['A-USDT-SWAP', '1H']], _loadedChannels: new Set(['A-USDT-SWAP_1H']) };
    let fetched = 0;
    const w = new CacheWarmer(feed, { async getCandles() { fetched++; return closedFrame(0, 1, H1); } }, { sleep: sleepSpy(), log: silentLog, env: {} });
    await w.warmOneCycle();
    expect(fetched).toBe(0);
    feed._loadedChannels.clear();
    await w.warmOneCycle();                                         // plain add() reservation
    expect(fetched).toBe(1);
    expect(feed._loadedChannels.has('A-USDT-SWAP_1H')).toBe(true);
  });
});

describe('loop', () => {
  it('waits 10 s, runs cycles every interval in 1 s slices, stops promptly', async () => {
    const feed = fakeFeed([['A-USDT-SWAP', '1H']]);
    const sleeps = [];
    let cycles = 0;
    const w = new CacheWarmer(feed, { async getCandles() { return closedFrame(0, 1, H1); } }, {
      ratePerSec: 5, cycleIntervalS: 5, log: logSpy(), now: () => nowS, env: {},
      sleep: async (ms) => { sleeps.push(ms); if (sleeps.length > 12) w._running = false; },
    });
    const origCycle = w.warmOneCycle.bind(w);
    w.warmOneCycle = async () => { cycles++; return origCycle(); };
    await w.start();
    expect(w.running).toBe(true);
    await w._task;                                                   // the sleep stub stops the loop after 12 sleeps
    expect(w.running).toBe(false);
    await w.stop();
    expect(sleeps[0]).toBe(10_000);
    expect(cycles).toBeGreaterThanOrEqual(2);
    expect(sleeps.filter((s) => s === 1000).length).toBeGreaterThanOrEqual(5);
    expect(w.stats.cycles).toBe(cycles);
    expect(w.stats.last_cycle_ts).toBe(nowS);
  });
});
