/**
 * wsPool.js — shard math, round-robin split, universe selection (coins cache → REST
 * floor 500 000 → top-N 150), per-shard start with the throttled initial fill.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
const req = createRequire(import.meta.url);
const P = req('../../services/marketData/wsPool.js');
const CC = req('../../services/marketData/candleCache.js');
import { closedFrame, sleepSpy, silentLog, logSpy } from './helpers.js';

const { requiredShards, shardSymbolsBalanced, resolveMaxSymbols, selectUniverse, runSingleFeed, runWsPool, getActiveFeeds, _resetActiveFeeds, DEFAULT_TIMEFRAMES, DEFAULT_MAX_SYMBOLS, DEFAULT_MIN_VOL_USDT } = P;

const syms = (n) => Array.from({ length: n }, (_, i) => `C${i}-USDT-SWAP`);

class FakeFeed {
  constructor(opts) {
    this.opts = opts;
    this.loads = [];
    this.subs = [];
    this.started = false; this.stopped = false;
  }

  async start() { this.started = true; }
  async stop() { this.stopped = true; }
  async initialLoad(s, tf) { this.loads.push([s, tf]); }
  subscribeSymbols(symbols, tfs) { for (const s of symbols) for (const tf of tfs) this.subs.push([s, tf]); }
  get activeSubscriptions() { return this.subs.length; }
}

beforeEach(() => { CC.initCache(5000, { log: silentLog }); _resetActiveFeeds(); });
afterEach(() => { CC._resetForTests(); _resetActiveFeeds(); });

describe('shard math', () => {
  it('requiredShards (ws_feed_bingx.required_shards)', () => {
    expect(requiredShards(150, 4, 200)).toBe(3);
    expect(requiredShards(300, 4, 200)).toBe(6);
    expect(requiredShards(150, 5, 200)).toBe(4);
    expect(requiredShards(40, 5, 200)).toBe(1);
    expect(requiredShards(41, 5, 200)).toBe(2);
    expect(requiredShards(0, 5, 200)).toBe(1);
    expect(requiredShards(1, 0, 200)).toBe(1);
    expect(requiredShards(150, 4)).toBe(3);          // env default 200
  });

  it('shardSymbolsBalanced is a round-robin split', () => {
    expect(shardSymbolsBalanced(['A', 'B', 'C', 'D', 'E', 'F', 'G'], 3)).toEqual([['A', 'D', 'G'], ['B', 'E'], ['C', 'F']]);
    expect(shardSymbolsBalanced(['A', 'B'], 1)).toEqual([['A', 'B']]);
    const parts = shardSymbolsBalanced(syms(150), requiredShards(150, 5, 200));
    expect(parts).toHaveLength(4);
    expect(parts.flat().sort()).toEqual(syms(150).sort());
    expect(parts.every((p) => p.length * 5 <= 200)).toBe(true);
  });

  it('defaults: 15m/1H/4H/1D, 150 symbols, 500 000 USDT floor', () => {
    expect(DEFAULT_TIMEFRAMES).toEqual(['15m', '1H', '4H', '1D']);
    expect(DEFAULT_MAX_SYMBOLS).toBe(150);
    expect(DEFAULT_MIN_VOL_USDT).toBe(500_000);
    expect(resolveMaxSymbols({})).toBe(150);
    expect(resolveMaxSymbols({ WS_FEED_MAX_SYMBOLS: '200' })).toBe(200);
    expect(resolveMaxSymbols({ WS_FEED_MAX_SYMBOLS: 'nope' })).toBe(150);
  });
});

describe('selectUniverse', () => {
  it('uses the cached LEVELS coins list, else REST with the volume floor; truncates to top-N', async () => {
    const calls = [];
    const rest = { async getAllUsdtPairs(minVol) { calls.push(minVol); return syms(170); } };
    const u = await selectUniverse({ rest, env: {}, log: silentLog });
    expect(calls).toEqual([500_000]);
    expect(u).toHaveLength(150);
    expect(u[0]).toBe('C0-USDT-SWAP');
    const u2 = await selectUniverse({ rest, env: { WS_FEED_MIN_VOL_USDT: '250000', WS_FEED_MAX_SYMBOLS: '10' }, log: silentLog });
    expect(calls).toEqual([500_000, 250_000]);
    expect(u2).toHaveLength(10);
    CC.setCoins(['BTC-USDT-SWAP', 'ETH-USDT-SWAP']);
    const u3 = await selectUniverse({ rest, env: {}, log: silentLog });
    expect(u3).toEqual(['BTC-USDT-SWAP', 'ETH-USDT-SWAP']);
    expect(calls).toHaveLength(2);
  });

  it('returns [] and warns when there are no coins', async () => {
    const log = logSpy();
    const rest = { async getAllUsdtPairs() { return []; } };
    expect(await selectUniverse({ rest, env: {}, log })).toEqual([]);
    expect(log.lines.warning[0]).toBe('ws_feed: нет монет для подписки, отложен запуск');
  });
});

describe('runSingleFeed', () => {
  it('starts the feed, REST-fills cold channels in batches of 5 / 1 s, then subscribes', async () => {
    const sleep = sleepSpy();
    const symbols = syms(12);
    CC.setCandles('C0-USDT-SWAP', '1H', closedFrame(0, 60, 3_600_000), { '1H': 600 });  // warm
    CC.setCandles('C1-USDT-SWAP', '1H', closedFrame(0, 49, 3_600_000), { '1H': 600 });  // < 50 → cold
    const feed = await runSingleFeed({
      rest: {}, symbols, timeframes: ['15m', '1h'], env: {}, sleep, log: silentLog,
      makeFeed: (o) => new FakeFeed(o),
    });
    expect(feed.started).toBe(true);
    expect(feed.opts.maxSubscriptions).toBe(12 * 2 + 50);
    expect(feed.opts.shardId).toBe(0);
    expect(feed.loads).toHaveLength(23);                       // 24 channels − 1 warm
    expect(feed.loads).toContainEqual(['C1-USDT-SWAP', '1H']); // tf normalised for the cache key
    expect(feed.loads).not.toContainEqual(['C0-USDT-SWAP', '1H']);
    expect(sleep.calls).toEqual([1000, 1000, 1000]);           // 3 batches of 5
    expect(feed.subs).toHaveLength(24);
    expect(getActiveFeeds()).toEqual([feed]);
  });

  it('with CACHE_WARMER_ENABLED=0 the fill runs 10 / 0.5 s', async () => {
    const sleep = sleepSpy();
    const feed = await runSingleFeed({
      rest: {}, symbols: syms(25), timeframes: ['1D'], env: { CACHE_WARMER_ENABLED: '0' }, sleep, log: silentLog,
      makeFeed: (o) => new FakeFeed(o), shardId: 2,
    });
    expect(sleep.calls).toEqual([500, 500, 500]);
    expect(feed.loads).toHaveLength(25);
  });
});

describe('runWsPool', () => {
  it('auto-shards 150 × 4 into 3 feeds of ≤ 200 subscriptions, env may only raise the count', async () => {
    const symbols = syms(150);
    const pool = await runWsPool({ rest: {}, symbols, env: {}, sleep: sleepSpy(), log: silentLog, makeFeed: (o) => new FakeFeed(o) });
    expect(pool.feeds).toHaveLength(3);
    expect(pool.feeds.every((f) => f.activeSubscriptions <= 200)).toBe(true);
    expect(pool.feeds.map((f) => f.opts.shardId)).toEqual([0, 1, 2]);
    expect(pool.feeds.flatMap((f) => f.subs.map((s) => s[0])).filter((s, i, a) => a.indexOf(s) === i).sort()).toEqual(symbols.sort());
    expect(getActiveFeeds()).toHaveLength(3);
    await pool.stop();
    expect(pool.feeds.every((f) => f.stopped)).toBe(true);
    expect(getActiveFeeds()).toHaveLength(0);

    const pool6 = await runWsPool({ rest: {}, symbols, env: { WS_FEED_NUM_SHARDS: '6' }, sleep: sleepSpy(), log: silentLog, makeFeed: (o) => new FakeFeed(o) });
    expect(pool6.feeds).toHaveLength(6);
    const pool1 = await runWsPool({ rest: {}, symbols, env: { WS_FEED_NUM_SHARDS: '2' }, sleep: sleepSpy(), log: silentLog, makeFeed: (o) => new FakeFeed(o) });
    expect(pool1.feeds).toHaveLength(3);                       // 2 < required 3
    const small = await runWsPool({ rest: {}, symbols: syms(10), env: {}, sleep: sleepSpy(), log: silentLog, makeFeed: (o) => new FakeFeed(o) });
    expect(small.feeds).toHaveLength(1);
    expect(small.shards).toEqual([syms(10)]);
  });

  it('skips empty shards', async () => {
    const pool = await runWsPool({ rest: {}, symbols: syms(2), env: { WS_FEED_NUM_SHARDS: '5' }, sleep: sleepSpy(), log: silentLog, makeFeed: (o) => new FakeFeed(o) });
    expect(pool.feeds).toHaveLength(2);
    expect(pool.shards).toHaveLength(5);
  });
});
