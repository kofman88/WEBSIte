/**
 * candleStore.js — persistent history on candles_cache(exchange='bingx') with an
 * in-memory better-sqlite3: store/get/coverage, the ensureCandles freshness rule
 * (oldest ≤ now − days, newest ≥ now − 2 h, ≥ 50 rows), Semaphore(3) + 0.3 s, stale
 * fallback, adaptive TTL, prefetch, cleanup, and the BingX HistoryLoader paging.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
const req = createRequire(import.meta.url);
import Database from 'better-sqlite3';
const CS = req('../../services/marketData/candleStore.js');
const S = req('../../services/marketData/symbolMap.js');
import { makeHttp, closedFrame, sleepSpy, silentLog, logSpy } from './helpers.js';

const { setDb, storeCandles, getCandles, getCoverage, ensureCandles, adaptiveFreshnessMs, prefetchTopCoins, candlePrefetchLoop, cacheStats, cleanup, HistoryLoader, FRESHNESS_MS, MAX_AGE_DAYS, _resetForTests } = CS;
const H1 = 3_600_000;
const DAY = 86_400_000;
const NOW = 1717000600000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS candles_cache (
    exchange TEXT NOT NULL, symbol TEXT NOT NULL, timeframe TEXT NOT NULL, open_time INTEGER NOT NULL,
    open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume REAL NOT NULL,
    close_time INTEGER NOT NULL, PRIMARY KEY (exchange, symbol, timeframe, open_time));
  CREATE INDEX IF NOT EXISTS idx_candles_lookup ON candles_cache(exchange, symbol, timeframe, open_time DESC);`;

let db;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(SCHEMA);
  setDb(db);
  S._setLive([]);
});
afterEach(() => { _resetForTests(); db.close(); });

const opts = (extra = {}) => ({ now: () => NOW, sleep: sleepSpy(), log: silentLog, env: {}, ...extra });

describe('store / get / coverage', () => {
  it('stores rows under exchange=bingx with close_time = open + tf, idempotently', () => {
    const f = closedFrame(NOW - 10 * H1, 5, H1, 2.5);
    expect(storeCandles('BTC-USDT-SWAP', '1h', f)).toBe(5);
    expect(storeCandles('BTC-USDT-SWAP', '1h', f)).toBe(5);         // INSERT OR IGNORE
    const rows = db.prepare('SELECT * FROM candles_cache ORDER BY open_time').all();
    expect(rows).toHaveLength(5);
    expect(rows[0].exchange).toBe('bingx');
    expect(rows[0].close_time).toBe(rows[0].open_time + H1);
    const g = getCandles('BTC-USDT-SWAP', '1h', 0, NOW);
    expect(g.length).toBe(5);
    expect(Array.from(g.t)).toEqual(Array.from(f.t));
    expect(g.c[0]).toBe(2.5);
    expect(getCandles('BTC-USDT-SWAP', '1h', NOW - 8 * H1, NOW - 7 * H1).length).toBe(2);
    expect(getCandles('ETH-USDT-SWAP', '1h', 0, NOW)).toBe(null);
    expect(storeCandles('X', '1h', null)).toBe(0);
    expect(storeCandles('X', '1h', closedFrame(0, 0, H1))).toBe(0);
  });

  it('getCoverage is [0, 0] when empty, else [min, max] of the stored opens', () => {
    expect(getCoverage('BTC-USDT-SWAP', '1h')).toEqual([0, 0]);
    storeCandles('BTC-USDT-SWAP', '1h', closedFrame(NOW - 3 * H1, 3, H1));
    expect(getCoverage('BTC-USDT-SWAP', '1h')).toEqual([NOW - 3 * H1, NOW - H1]);
    expect(getCoverage('BTC-USDT-SWAP', '4h')).toEqual([0, 0]);
  });

  it('cacheStats counts series and rows', () => {
    storeCandles('BTC-USDT-SWAP', '1h', closedFrame(0, 3, H1));
    storeCandles('BTC-USDT-SWAP', '4h', closedFrame(0, 2, 4 * H1));
    const s = cacheStats();
    expect(s.symbols).toBe(2);
    expect(s.candles).toBe(5);
    expect(s.size_mb).toBe(0);                                        // :memory:
  });
});

describe('ensureCandles freshness rule', () => {
  const sym = 'BTC-USDT-SWAP', tf = '1h';
  function loader(frame, calls = []) {
    return { calls, async load(s, t, d) { calls.push([s, t, d]); if (frame instanceof Error) throw frame; return frame; } };
  }

  it('store hit: oldest ≤ now − days, newest ≥ now − 2 h, ≥ 50 rows → no loader call', async () => {
    storeCandles(sym, tf, closedFrame(NOW - 80 * H1, 80, H1));       // newest = now − 1 h, oldest = now − 80 h
    const ld = loader(closedFrame(0, 1, H1));
    const f = await ensureCandles(sym, tf, 3, ld, opts());
    expect(ld.calls).toEqual([]);
    expect(f.length).toBe(72);                                        // rows within [now − 3 d, now]
    expect(FRESHNESS_MS).toBe(2 * H1);
    // 48 rows in the window (< 50) → reload even though coverage and freshness pass
    const ld2 = loader(closedFrame(NOW - 100 * H1, 100, H1));
    await ensureCandles(sym, tf, 2, ld2, opts());
    expect(ld2.calls).toEqual([[sym, tf, 2]]);
  }, 10_000);

  it('newest older than 2 h → reload', async () => {
    storeCandles(sym, tf, closedFrame(NOW - 60 * H1 - 2 * H1 - 1, 60, H1));  // newest = now − 2 h − 1 ms − … → stale
    const fresh = closedFrame(NOW - 70 * H1, 70, H1, 9);
    const ld = loader(fresh);
    const f = await ensureCandles(sym, tf, 2, ld, opts());
    expect(ld.calls).toEqual([[sym, tf, 2]]);
    expect(f).toBe(fresh);
    expect(getCoverage(sym, tf)[0]).toBe(NOW - 70 * H1);              // stored
  });

  it('coverage not reaching back `days` → reload; < 50 rows → reload', async () => {
    storeCandles(sym, tf, closedFrame(NOW - 30 * H1, 30, H1));
    const ld = loader(closedFrame(NOW - 100 * H1, 100, H1));
    await ensureCandles(sym, tf, 1, ld, opts());                      // 30 rows < 50
    expect(ld.calls).toHaveLength(1);
    const ld2 = loader(closedFrame(NOW - 100 * H1, 100, H1));
    await ensureCandles(sym, tf, 10, ld2, opts());                    // oldest > now − 10 d
    expect(ld2.calls).toHaveLength(1);
  });

  it('loader error → stale store fallback when ≥ 50 rows, else null', async () => {
    const log = logSpy();
    storeCandles(sym, tf, closedFrame(NOW - 120 * H1, 100, H1));      // stale (newest = now − 21 h)
    const f = await ensureCandles(sym, tf, 3, loader(new Error('net')), opts({ log }));
    expect(f.length).toBe(52);                                        // rows in [now − 3 d, now − 21 h]
    expect(log.lines.info[0]).toBe('candle_store FALLBACK BTC-USDT-SWAP/1h: 52 bars from stale cache');
    expect(log.lines.warning[0]).toBe('candle_store FETCH BTC-USDT-SWAP/1h: net');
    expect(await ensureCandles(sym, tf, 2, loader(new Error('net')), opts())).toBe(null);   // only 28 rows in 2 d
    expect(await ensureCandles('ETH-USDT-SWAP', tf, 2, loader(new Error('net')), opts())).toBe(null);
  });

  it('loader returning nothing → null; sleeps 0.3 s after the load', async () => {
    const sleep = sleepSpy();
    expect(await ensureCandles(sym, tf, 2, loader(null), opts({ sleep }))).toBe(null);
    expect(await ensureCandles(sym, tf, 2, loader(closedFrame(0, 0, H1)), opts({ sleep }))).toBe(null);
    expect(sleep.calls).toEqual([300, 300]);
  });

  it('limits concurrent loads to 3', async () => {
    let inFlight = 0, peak = 0;
    const resolvers = [];
    const ld = { async load() { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => resolvers.push(r)); inFlight--; return closedFrame(NOW - 60 * H1, 60, H1); } };
    const ps = ['A', 'B', 'C', 'D', 'E'].map((s) => ensureCandles(s, tf, 1, ld, opts()));
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(peak).toBe(3);
    expect(resolvers).toHaveLength(3);
    resolvers.splice(0).forEach((r) => r());
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(resolvers).toHaveLength(2);
    resolvers.splice(0).forEach((r) => r());
    const out = await Promise.all(ps);
    expect(out.every((f) => f.length === 60)).toBe(true);
  });

  it('adaptive TTL (ADAPTIVE_CACHE_TTL_ENABLED=1) can force a refresh of a 2 h-fresh store', async () => {
    const n = 60;
    const bars = [];
    for (let i = 0; i < n; i++) { const hi = i >= n - 5 ? 5 : 2; bars.push([NOW - (n - i) * H1 - 90 * 60_000, 1, hi, 1, 1, 1]); }
    const { Frame } = req('../../strategies/common/frame.js');
    storeCandles(sym, tf, Frame.fromBars(bars));                      // newest = now − 1.5 h (fresh by 2 h, stale by 30 min)
    const ld = loader(closedFrame(NOW - 70 * H1, 70, H1));
    expect(ld.calls).toHaveLength(0);
    await ensureCandles(sym, tf, 2, ld, opts({ env: { ADAPTIVE_CACHE_TTL_ENABLED: '1' } }));
    expect(ld.calls).toHaveLength(1);
    const ld2 = loader(closedFrame(NOW - 70 * H1, 70, H1));
    await ensureCandles(sym, tf, 2, ld2, opts());                     // legacy: 2 h → hit
    expect(ld2.calls).toHaveLength(0);
  });
});

describe('adaptiveFreshnessMs (values from the bot)', () => {
  const mk = (n, recentRange, baseRange = 1) => {
    const bars = [];
    for (let i = 0; i < n; i++) { const r = i >= n - 5 ? recentRange : baseRange; bars.push([i * H1, 1, 1 + r, 1, 1, 1]); }
    return { length: n, h: Float64Array.from(bars.map((b) => b[2])), l: Float64Array.from(bars.map((b) => b[3])) };
  };
  it('legacy 2 h when disabled; per-TF base × volatility when enabled', () => {
    expect(adaptiveFreshnessMs(null, '1h', {})).toBe(7_200_000);
    expect(adaptiveFreshnessMs(mk(60, 4), '1h', {})).toBe(7_200_000);
    const env = { ADAPTIVE_CACHE_TTL_ENABLED: '1' };
    expect(adaptiveFreshnessMs(null, '1h', env)).toBe(7_200_000);
    expect(adaptiveFreshnessMs(null, '1m', env)).toBe(7_200_000);
    expect(adaptiveFreshnessMs(mk(60, 4), '1h', env)).toBe(1_800_000);
    expect(adaptiveFreshnessMs(mk(60, 4), '15m', env)).toBe(450_000);
    expect(adaptiveFreshnessMs(mk(60, 4), '1m', env)).toBe(30_000);
    expect(adaptiveFreshnessMs(mk(60, 0.2), '1h', env)).toBe(7_200_000);
    expect(adaptiveFreshnessMs(mk(60, 0.2), '1d', env)).toBe(129_600_000);
    expect(adaptiveFreshnessMs(mk(60, 1), '1h', env)).toBe(7_200_000);
    expect(adaptiveFreshnessMs(mk(60, 1), '1d', env)).toBe(86_400_000);
    expect(adaptiveFreshnessMs(mk(60, 0, 0), '1h', env)).toBe(7_200_000);   // atr_avg = 0
    expect(adaptiveFreshnessMs(mk(10, 4), '1h', env)).toBe(7_200_000);      // < 50 bars
  });
});

describe('prefetch / loop / cleanup', () => {
  it('prefetchTopCoins counts cached / loaded / failed with the 4 h freshness', async () => {
    storeCandles('BTC-USDT-SWAP', '1h', closedFrame(NOW - 40 * DAY, 40 * 24, H1));   // covers 30 d, fresh
    const loads = [];
    const loader = {
      async getTopCoins(minVol) { loads.push(['top', minVol]); return ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'BAD-USDT-SWAP', 'X']; },
      async load(s) { loads.push(['load', s]); if (s.startsWith('BAD')) throw new Error('x'); return s.startsWith('ETH') ? closedFrame(NOW - 31 * DAY, 10, DAY) : null; },
    };
    const sleep = sleepSpy();
    const stats = await prefetchTopCoins(loader, 3, ['1h'], 30, opts({ sleep }));
    expect(loads[0]).toEqual(['top', 5_000_000]);
    expect(stats).toEqual({ loaded: 1, cached: 1, failed: 1 });
    expect(getCoverage('ETH-USDT-SWAP', '1h')[0]).toBe(NOW - 31 * DAY);
    expect(sleep.calls).toEqual([300]);                               // BAD throws before the delay
    const bad = await prefetchTopCoins({ async getTopCoins() { throw new Error('no'); } }, 3, null, 30, opts());
    expect(bad).toEqual({ loaded: 0, cached: 0, failed: 0 });
  });

  it('candlePrefetchLoop: 600 s delay, top-20 × (1h, 4h) × 21 d every interval, stoppable', async () => {
    const sleeps = [];
    const calls = [];
    const loader = { async getTopCoins() { calls.push(1); return []; }, async load() { return null; } };
    let loop;
    const sleep = async (ms) => { sleeps.push(ms); if (sleeps.length >= 3) loop.stop(); };
    loop = candlePrefetchLoop(loader, 3600, { sleep, log: silentLog, now: () => NOW });
    await loop.done;
    expect(sleeps).toEqual([600_000, 3_600_000, 3_600_000]);
    expect(calls).toHaveLength(2);
  });

  it('cleanup deletes rows older than 365 days (VACUUM opt-in)', () => {
    storeCandles('OLD-USDT-SWAP', '1d', closedFrame(NOW - 400 * DAY, 10, DAY));
    storeCandles('NEW-USDT-SWAP', '1d', closedFrame(NOW - 10 * DAY, 5, DAY));
    const log = logSpy();
    expect(cleanup({ now: () => NOW, log })).toBe(10);
    expect(db.prepare('SELECT COUNT(*) AS n FROM candles_cache').get().n).toBe(5);
    expect(log.lines.info[0]).toBe('🕯 Candle store cleanup: удалено 10 свечей, осталось 5 (0.0 MB)');
    expect(cleanup({ now: () => NOW, log, vacuum: true })).toBe(0);
    expect(MAX_AGE_DAYS).toBe(365);
  });
});

describe('HistoryLoader (BingX)', () => {
  function klineHandler(priceBingx = 5.0, vol = 2.0) {
    return (url, params) => {
      if (!url.includes('klines')) return { code: 0, data: [] };
      const step = { '1h': H1, '4h': 4 * H1, '15m': 900_000 }[params.interval];
      const start = Number(params.startTime), end = Number(params.endTime), lim = Number(params.limit);
      const first = Math.ceil(start / step) * step;
      const times = [];
      for (let t = first; t <= end; t += step) times.push(t);
      const rows = times.slice(-lim).map((t) => ({ open: String(priceBingx), high: String(priceBingx * 1.01), low: String(priceBingx * 0.99), close: String(priceBingx), volume: String(vol), time: t }));
      return { code: 0, data: rows.reverse() };
    };
  }

  it('pages backwards in windows of PAGE_LIMIT bars and converts to OKX units', async () => {
    const http = makeHttp(klineHandler(5.0, 2.0));
    const ld = new HistoryLoader({ http, now: () => NOW, sleep: sleepSpy(), log: silentLog, pageLimit: 24, pagePauseMs: 0 });
    const f = await ld.load('PEPE-USDT-SWAP', '1h', 3);
    const kl = http.calls.filter((c) => c.url.includes('klines'));
    expect(kl.length).toBeGreaterThanOrEqual(3);
    expect(kl.every((c) => c.params.symbol === '1000PEPE-USDT' && c.params.interval === '1h' && c.params.limit === '24')).toBe(true);
    expect(kl.every((c) => c.opts.headers['User-Agent'] === 'CHM-Backtest/1.0')).toBe(true);
    for (let i = 1; i < f.length; i++) expect(f.t[i] - f.t[i - 1]).toBe(H1);
    expect(f.t[f.length - 1] + H1).toBeLessThanOrEqual(NOW);        // forming bar dropped
    expect(f.t[0]).toBeGreaterThanOrEqual(NOW - 3 * DAY - H1);
    expect(f.length).toBeGreaterThanOrEqual(70);
    expect(f.length).toBeLessThanOrEqual(73);
    expect(f.c[f.length - 1]).toBeCloseTo(0.005, 12);
    expect(f.v[f.length - 1]).toBeCloseTo(10, 9);
    expect(ld.source).toBe('bingx');
  });

  it('default paging is 1440 bars / 0.2 s; empty or error bodies → null', async () => {
    const ld = new HistoryLoader({ http: makeHttp(() => ({ code: 0, data: [] })), now: () => NOW, sleep: sleepSpy(), log: silentLog });
    expect(ld.PAGE_LIMIT).toBe(1440);
    expect(ld.PAGE_PAUSE_MS).toBe(200);
    expect(await ld.load('BTC-USDT-SWAP', '4h', 5)).toBe(null);
    const ld2 = new HistoryLoader({ http: makeHttp(() => ({ code: 109400, msg: 'bad' })), now: () => NOW, sleep: sleepSpy(), log: silentLog });
    expect(await ld2.load('BTC-USDT-SWAP', '4h', 5)).toBe(null);
  });

  it('_getJson: 429 waits Retry-After and retries; timeouts back off 1 s / 2 s; other errors → null', async () => {
    let n = 0;
    const sleep = sleepSpy();
    const http = makeHttp(() => {
      n++;
      if (n === 1) return { status: 429, json: null, headers: { 'Retry-After': '4' } };
      if (n === 2) { const e = new Error('t/o'); e.name = 'TimeoutError'; throw e; }
      return { code: 0, data: [1] };
    });
    const ld = new HistoryLoader({ http, now: () => NOW, sleep, log: silentLog });
    expect(await ld._getJson('https://x/klines', {}, 'w')).toEqual({ code: 0, data: [1] });
    expect(sleep.calls).toEqual([4000, 2000]);
    const ld2 = new HistoryLoader({ http: makeHttp(() => { throw new Error('ECONNRESET'); }), now: () => NOW, sleep: sleepSpy(), log: silentLog });
    expect(await ld2._getJson('https://x', {}, 'w')).toBe(null);
    const ld3 = new HistoryLoader({ http: makeHttp(() => { const e = new Error('t/o'); e.name = 'TimeoutError'; throw e; }), now: () => NOW, sleep: sleepSpy(), log: silentLog });
    expect(await ld3._getJson('https://x', {}, 'w')).toBe(null);
    expect(ld3._sleep.calls).toEqual([1000, 2000]);
    const ld4 = new HistoryLoader({ http: makeHttp(() => ({ status: 500, json: null })), now: () => NOW, sleep: sleepSpy(), log: silentLog });
    expect(await ld4._getJson('https://x', {}, 'w')).toBe(null);
  });

  it('getTopCoins: quoteVolume, live contracts, non-crypto excluded', async () => {
    const http = makeHttp((url) => {
      if (url.includes('contracts')) return { code: 0, data: [
        { symbol: 'BTC-USDT', status: 1 }, { symbol: '1000PEPE-USDT', status: 1 }, { symbol: 'TONCOIN-USDT', status: 1 },
        { symbol: 'DEAD-USDT', status: 0 }, { symbol: 'LOW-USDT', status: 1 }, { symbol: 'NCCOXAG2USD-USDT', status: 1 },
      ] };
      return { code: 0, data: [
        { symbol: 'BTC-USDT', quoteVolume: '900000000', volume: '9000' }, { symbol: '1000PEPE-USDT', quoteVolume: '50000000' },
        { symbol: 'TONCOIN-USDT', quoteVolume: '70000000' }, { symbol: 'DEAD-USDT', quoteVolume: '99999999999' },
        { symbol: 'LOW-USDT', quoteVolume: '100' }, { symbol: 'BTC-USDC', quoteVolume: '99999999999' },
        { symbol: 'NCCOXAG2USD-USDT', quoteVolume: '99999999999' },
      ] };
    });
    const ld = new HistoryLoader({ http, now: () => NOW, sleep: sleepSpy(), log: silentLog });
    expect(await ld.getTopCoins(5_000_000)).toEqual(['BTC-USDT-SWAP', 'TON-USDT-SWAP', 'PEPE-USDT-SWAP']);
    const noContracts = new HistoryLoader({ http: makeHttp((url) => (url.includes('contracts') ? { code: 1 } : { code: 0, data: [{ symbol: 'ETH-USDT', quoteVolume: '9e9' }] })), now: () => NOW, sleep: sleepSpy(), log: silentLog });
    expect(await noContracts.getTopCoins()).toEqual(['ETH-USDT-SWAP']);
    const noTickers = new HistoryLoader({ http: makeHttp(() => ({ code: 1 })), now: () => NOW, sleep: sleepSpy(), log: silentLog });
    expect(await noTickers.getTopCoins()).toEqual([]);
  });

  it('loadCached goes through ensureCandles (store first, HTTP once)', async () => {
    // A store hit needs the oldest stored bar ≤ now − days: with the loader cutting at
    // `now − days` that holds only once `now` moved on by up to one bar (or, as here,
    // when `now` is aligned to the bar grid) — the same rule the bot's candle_store has.
    const ALIGNED = Math.floor(NOW / H1) * H1;
    const http = makeHttp(klineHandler(5.0, 2.0));
    const ld = new HistoryLoader({ http, now: () => ALIGNED, sleep: sleepSpy(), log: silentLog, pagePauseMs: 0 });
    const a = await ld.loadCached('BTC-USDT-SWAP', '1h', 3);
    const n = http.calls.length;
    expect(a.length).toBe(72);
    expect(a.t[0]).toBe(ALIGNED - 3 * DAY);
    const b = await ld.loadCached('BTC-USDT-SWAP', '1h', 3);
    expect(http.calls).toHaveLength(n);
    expect(b.length).toBe(72);
    const direct = new HistoryLoader({ http, now: () => ALIGNED, sleep: sleepSpy(), log: silentLog, pagePauseMs: 0, useCache: false });
    await direct.loadCached('BTC-USDT-SWAP', '1h', 3);
    expect(http.calls.length).toBeGreaterThan(n);
    const failing = new HistoryLoader({ http, now: () => ALIGNED, sleep: sleepSpy(), log: silentLog, pagePauseMs: 0, store: { ensureCandles: async () => { throw new Error('db'); } } });
    expect((await failing.loadCached('BTC-USDT-SWAP', '1h', 3)).length).toBe(72);   // falls back to a direct load
  });
});
