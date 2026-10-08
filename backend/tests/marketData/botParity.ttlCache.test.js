/**
 * Bot parity — `TTLCache` / module-level candle & coins cache vs `cache.py` (parity/ttl_cache.json):
 * LRU order on get, eviction of the oldest on a new key at capacity, TTL expiry on read,
 * re-set keeps position, hit/miss/eviction counters and the 6 h coins cache; plus the rate
 * gate constants and the [OKX-429-BURST] line of `fetcher.py`.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { loadParity, silentLog } from './parityHelpers.js';

const req = createRequire(import.meta.url);
const CC = req('../../services/marketData/candleCache.js');
const RG = req('../../services/marketData/rateGate.js');
const fx = loadParity('ttl_cache.json');

describe('TTLCache == cache.TTLCache (scripted ops)', () => {
  it('replays every op with the same results, key order, expiries and stats', () => {
    const clock = { t: 1000.0 };
    const c = new CC.TTLCache(3, { now: () => clock.t });
    for (const step of fx.steps) {
      const op = step.op;
      let res = null;
      switch (op[0]) {
        case 'set': c.set(op[1], op[2], op[3]); break;
        case 'get': res = c.get(op[1]); break;
        case 'delete': c.delete(op[1]); break;
        case 'clear': c.clear(); break;
        case 'advance': clock.t += op[1]; break;
        case 'keys': res = c.keys(); break;
        case 'stats': res = c.stats(); break;
        case 'size': res = c.size(); break;
        default: throw new Error(`unknown op ${op[0]}`);
      }
      const label = JSON.stringify(op);
      expect(res, `result ${label}`).toEqual(step.result);
      expect(c.keys(), `keys after ${label}`).toEqual(step.keys);
      expect(Object.fromEntries(Array.from(c._data, ([k, v]) => [k, v.expiresAt])), `expires after ${label}`).toEqual(step.expires);
      expect(c.stats(), `stats after ${label}`).toEqual(step.stats);
      expect(clock.t).toBe(step.clock);
    }
  });

  it('module-level get/set_candles (ttl_map default 3600, eviction) and the coins cache (6 h)', () => {
    const m = fx.module;
    const clock = { t: 5000.0 };
    CC._resetForTests();
    CC.initCache(2, { now: () => clock.t, log: silentLog });
    CC.setCandles('BTC-USDT-SWAP', '1H', 'df1', { '1H': 100 });
    CC.setCandles('ETH-USDT-SWAP', '15m', 'df2', {});
    CC.setCandles('SOL-USDT-SWAP', '4H', 'df3', { '4H': 7, '15m': 1 });
    expect(CC.cacheKeys()).toEqual(m[0].keys);
    expect(Object.fromEntries(Array.from(CC.getCache()._data, ([k, v]) => [k, v.expiresAt]))).toEqual(m[0].expires);
    expect([CC.getCandles('BTC-USDT-SWAP', '1H'), CC.getCandles('ETH-USDT-SWAP', '15m'), CC.getCandles('SOL-USDT-SWAP', '4H')]).toEqual(m[1].get);
    expect(CC.cacheKeys()).toEqual(m[2].keys);
    expect(CC.getCoins()).toBe(m[3].coins_before);
    CC.setCoins(['A', 'B']);
    expect(CC.getCoins()).toEqual(m[4].coins);
    clock.t += 6 * 3600 - 1;
    expect(CC.getCoins()).toEqual(m[5].coins_5h59);
    clock.t += 1;
    expect(CC.getCoins()).toBe(m[6].coins_6h);
    clock.t += 1;
    expect(CC.getCoins()).toBe(m[7].coins_6h01);
    expect(CC.cacheStats()).toEqual(m[8].stats);
    CC._resetForTests();
  });
});

describe('rate gate == fetcher.OKXFetcher shared gate', () => {
  it('token bucket 15 r/s burst 10, Semaphore(8), 8 s acquire timeout, 25 ms poll; one shared gate', () => {
    expect(RG.sharedGate.bucket._rate).toBe(15.0);
    expect(RG.sharedGate.bucket._burst).toBe(10);
    expect(RG.sharedGate.sem.available).toBe(8);
    expect(RG.sharedGate).toBe(req('../../services/marketData/rateGate.js').sharedGate);
    const src = req('fs').readFileSync(req('path').join(process.cwd(), 'services/marketData/rateGate.js'), 'utf8');
    expect(src).toMatch(/acquire\(timeoutMs = 8000\)/);
    expect(src).toMatch(/this\._sleep\(25\)/);
    expect(RG.RATE_LIMIT_WARN_INTERVAL_S).toBe(60);
  });

  it('[OKX-429-BURST] line is the bot\'s format and is throttled to one per 60 s', () => {
    RG._resetRateLimitStats();
    const lines = [];
    const log = { ...silentLog, warning: (m) => lines.push(m) };
    let t = 1000;
    RG.recordRateLimitHit('BTC-USDT-SWAP', '1h', 3, { now: () => t, log });
    RG.recordRateLimitHit('ETH-USDT-SWAP', '4h', 5, { now: () => t + 10, log });
    t += 60;
    RG.recordRateLimitHit('SOL-USDT-SWAP', '15m', 7, { now: () => t, log });
    expect(lines).toEqual([
      '[OKX-429-BURST] 1 hit(s) in last 60s; latest sym=BTC-USDT-SWAP tf=1h retry-after=3s (total-since-start=1)',
      '[OKX-429-BURST] 2 hit(s) in last 60s; latest sym=SOL-USDT-SWAP tf=15m retry-after=7s (total-since-start=3)',
    ]);
    expect(RG.getRateLimitStats().rateLimitHitsTotal).toBe(3);
    RG._resetRateLimitStats();
  });
});
