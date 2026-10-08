/**
 * candleCache.js — TTLCache (ordered LRU: get moves to the end, set evicts the oldest
 * when full and the key is new, counters), the module-level cache with D6-normalised keys,
 * and the coins list cache (6 h).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
const req = createRequire(import.meta.url);
const CC = req('../../services/marketData/candleCache.js');
import { closedFrame, silentLog } from './helpers.js';

const { TTLCache, initCache, candleKey, getCandles, setCandles, deleteCandles, getCoins, setCoins, cacheStats, cacheKeys, COINS_TTL_S, DEFAULT_MAX_KEYS, _resetForTests } = CC;

describe('TTLCache', () => {
  it('expires entries and counts hits/misses', () => {
    let t = 100;
    const c = new TTLCache(10, { now: () => t });
    c.set('a', 1, 60);
    expect(c.get('a')).toBe(1);
    t = 160;
    expect(c.get('a')).toBe(1);        // expires_at = 160, "time.time() > expires_at" is false at 160
    t = 161;
    expect(c.get('a')).toBe(null);     // deleted on read
    expect(c.size()).toBe(0);
    expect(c.get('zzz')).toBe(null);
    expect(c.stats()).toEqual({ size: 0, max_size: 10, hits: 2, misses: 2, evictions: 0, ratio: 50.0 });
  });

  it('evicts in LRU order: hits move to the end, replacement keeps the position', () => {
    const c = new TTLCache(3);
    c.set('a', 1, 60); c.set('b', 2, 60); c.set('c', 3, 60);
    expect(c.get('a')).toBe(1);        // order: b, c, a
    c.set('d', 4, 60);                 // evicts b
    expect(c.keys()).toEqual(['c', 'a', 'd']);
    expect(c.get('b')).toBe(null);
    expect(c.stats().evictions).toBe(1);
    c.set('c', 33, 60);                // re-set keeps c oldest
    c.set('e', 5, 60);                 // evicts c
    expect(c.keys()).toEqual(['a', 'd', 'e']);
    expect(c.stats().evictions).toBe(2);
  });

  it('bot test: evictions increment only when capacity is exceeded by a new key', () => {
    const c = new TTLCache(2);
    c.set('a', 1, 60); c.set('b', 2, 60);
    expect(c.stats().evictions).toBe(0);
    c.set('c', 3, 60);
    expect(c.stats().evictions).toBe(1);
    expect(c.get('a')).toBe(null);
    c.set('d', 4, 60);
    expect(c.stats().evictions).toBe(2);
    const r = new TTLCache(2);
    r.set('a', 1, 60); r.set('b', 2, 60); r.set('a', 5, 60);
    expect(r.stats().evictions).toBe(0);
    for (const k of ['size', 'max_size', 'hits', 'misses', 'evictions', 'ratio']) expect(k in r.stats()).toBe(true);
  });

  it('delete / clear / has', () => {
    const c = new TTLCache(5);
    c.set('a', 1, 60);
    expect(c.has('a')).toBe(true);
    c.delete('a');
    expect(c.has('a')).toBe(false);
    c.set('b', 1, 60); c.clear();
    expect(c.size()).toBe(0);
  });
});

describe('module cache (cache.py API)', () => {
  let t = 1000;
  beforeEach(() => { t = 1000; initCache(4, { now: () => t, log: silentLog }); });
  afterEach(() => _resetForTests());

  it('DEFAULT_MAX_KEYS is the bot cap', () => {
    expect(DEFAULT_MAX_KEYS).toBe(4000);
  });

  it('D6: keys are normalised (1h → 1H), so LEVELS and the WS feed share one entry', () => {
    expect(candleKey('BTC-USDT-SWAP', '1h')).toBe('BTC-USDT-SWAP_1H');
    expect(candleKey('BTC-USDT-SWAP', '1H')).toBe('BTC-USDT-SWAP_1H');
    expect(candleKey('BTC-USDT-SWAP', '4h')).toBe('BTC-USDT-SWAP_4H');
    expect(candleKey('BTC-USDT-SWAP', '1d')).toBe('BTC-USDT-SWAP_1D');
    expect(candleKey('BTC-USDT-SWAP', '15m')).toBe('BTC-USDT-SWAP_15m');
    expect(candleKey('BTC-USDT-SWAP', '1W')).toBe('BTC-USDT-SWAP_1W');
    const f = closedFrame(0, 3, 3_600_000);
    setCandles('BTC-USDT-SWAP', '1H', f, { '1H': 14400 });
    expect(getCandles('BTC-USDT-SWAP', '1h')).toBe(f);
    expect(cacheKeys()).toEqual(['BTC-USDT-SWAP_1H']);
  });

  it('ttl = ttlMap[tf] (raw tf, then the normalised spelling), default 3600', () => {
    const f = closedFrame(0, 3, 3_600_000);
    setCandles('A', '1h', f, { '1h': 3570 });
    setCandles('B', '1H', f, { '1h': 3570 });       // no '1H' key → normalised '1H' → none → 3600
    setCandles('C', '15m', f, {});
    t = 1000 + 3570;
    expect(getCandles('A', '1h')).toBe(f);
    t = 1000 + 3571;
    expect(getCandles('A', '1h')).toBe(null);
    expect(getCandles('B', '1H')).toBe(f);
    t = 1000 + 3601;
    expect(getCandles('B', '1H')).toBe(null);
    expect(getCandles('C', '15m')).toBe(null);
  });

  it('respects the cap and reports stats; deleteCandles removes the key', () => {
    const f = closedFrame(0, 1, 60_000);
    for (const s of ['A', 'B', 'C', 'D', 'E']) setCandles(s, '15m', f, { '15m': 60 });
    expect(cacheStats().size).toBe(4);
    expect(cacheStats().evictions).toBe(1);
    expect(getCandles('A', '15m')).toBe(null);
    deleteCandles('B', '15m');
    expect(cacheKeys()).toEqual(['C_15m', 'D_15m', 'E_15m']);
  });

  it('warns and returns null when not initialised', () => {
    _resetForTests();
    expect(getCandles('X', '1h')).toBe(null);
    setCandles('X', '1h', closedFrame(0, 1, 1), {});
    expect(cacheStats()).toEqual({});
  });

  it('coins list: 6 h TTL', () => {
    expect(getCoins()).toBe(null);
    setCoins(['BTC-USDT-SWAP']);
    expect(getCoins()).toEqual(['BTC-USDT-SWAP']);
    t = 1000 + COINS_TTL_S - 1;
    expect(getCoins()).toEqual(['BTC-USDT-SWAP']);
    t = 1000 + COINS_TTL_S;
    expect(getCoins()).toBe(null);
    expect(COINS_TTL_S).toBe(6 * 3600);
  });
});
