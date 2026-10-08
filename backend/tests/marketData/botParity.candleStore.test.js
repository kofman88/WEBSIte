/**
 * Bot parity — `candleStore` vs `candle_store.py` + `backtest.BingXHistoryLoader`
 * (parity/candle_store.json, generator parity/gen/gen_candle_store.py), replayed in order on
 * one in-memory better-sqlite3 like the bot's one temp SQLite file:
 *   ensure_candles: coverage + 2 h freshness (boundary) + ≥ 50 rows in window, loader
 *   call / result / stored rows, stale-cache fallback on a raising loader, empty / None
 *   loader results, adaptive TTL (env "1" only), days = 0;
 *   _adaptive_freshness_ms direct cases; prefetch_top_coins stats; cleanup (365 d);
 *   HistoryLoader paging windows (startTime/endTime/limit per page) and the resulting bars;
 *   get_top_coins with / without contracts / tickers.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import Database from 'better-sqlite3';
import { loadParity, sameFrame, sameNumbers, okJson, httpError, silentLog } from './parityHelpers.js';

const req = createRequire(import.meta.url);
const CS = req('../../services/marketData/candleStore.js');
const SM = req('../../services/marketData/symbolMap.js');
const { Frame } = req('../../strategies/common/frame.js');
const fx = loadParity('candle_store.json');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS candles_cache (
    exchange TEXT NOT NULL, symbol TEXT NOT NULL, timeframe TEXT NOT NULL, open_time INTEGER NOT NULL,
    open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume REAL NOT NULL,
    close_time INTEGER NOT NULL, PRIMARY KEY (exchange, symbol, timeframe, open_time));
  CREATE INDEX IF NOT EXISTS idx_candles_lookup ON candles_cache(exchange, symbol, timeframe, open_time DESC);`;

let db;
const countRows = (symbol, tf) => db.prepare("SELECT COUNT(*) AS n FROM candles_cache WHERE exchange = 'bingx' AND symbol = ? AND timeframe = ?").get(symbol, tf).n;
const envOf = (flag) => (flag === null || flag === undefined ? {} : { ADAPTIVE_CACHE_TTL_ENABLED: flag });
const noSleep = async () => {};

beforeAll(() => {
  db = new Database(':memory:');
  db.exec(SCHEMA);
  CS.setDb(db);
  SM._setLive([]);
});
afterAll(() => { CS._resetForTests(); db.close(); });

describe('candleStore == candle_store.py (sequential replay on one DB)', () => {
  it('ensureCandles scenarios: loader calls, result, coverage and stored rows', async () => {
    expect(fx.scenarios.length).toBeGreaterThan(10);
    for (const s of fx.scenarios) {
      if (s.seed) CS.storeCandles(s.symbol, s.tf, Frame.fromBars(s.seed), { log: silentLog });
      const calls = [];
      const loader = {
        async load(sym, tf, days) {
          calls.push([sym, tf, days]);
          if (s.loader_raises) throw new Error('boom');
          return s.loader_result === null ? null : Frame.fromBars(s.loader_result);
        },
      };
      const res = await CS.ensureCandles(s.symbol, s.tf, s.days, loader, { now: () => s.now_ms, sleep: noSleep, log: silentLog, env: envOf(s.env_adaptive) });
      expect(calls, `${s.name} loader calls`).toEqual(s.loader_calls);
      if (s.result === null) expect(res, `${s.name} result`).toBe(null);
      else sameFrame(res, s.result, `${s.name} result`);
      expect(CS.getCoverage(s.symbol, s.tf), `${s.name} coverage`).toEqual(s.coverage);
      expect(countRows(s.symbol, s.tf), `${s.name} rows`).toBe(s.rows);
    }
  });

  it('adaptiveFreshnessMs direct cases', () => {
    for (const a of fx.adaptive) {
      const frame = a.bars === null ? null : Frame.fromBars(a.bars);
      expect(CS.adaptiveFreshnessMs(frame, a.tf, envOf(a.env), { log: silentLog }), a.name).toBe(a.expected);
    }
  });

  it('prefetchTopCoins: cached / loaded / failed and the loader calls', async () => {
    const p = fx.prefetch;
    for (const [k, b] of Object.entries(p.seeds)) {
      const [symbol, tf] = k.split('|');
      CS.storeCandles(symbol, tf, Frame.fromBars(b), { log: silentLog });
    }
    const calls = [], top = [];
    const loader = {
      async getTopCoins(minVol) { top.push(minVol); return ['PA-USDT-SWAP', 'PB-USDT-SWAP', 'PC-USDT-SWAP', 'PD-USDT-SWAP']; },
      async load(symbol, tf, days) {
        calls.push([symbol, tf, days]);
        const b = p.loader[symbol];
        return b === null || b === undefined ? null : Frame.fromBars(b);
      },
    };
    const stats = await CS.prefetchTopCoins(loader, p.top_n, p.tfs, p.days, { now: () => p.now_ms, sleep: noSleep, log: silentLog });
    expect(stats).toEqual(p.stats);
    expect(calls).toEqual(p.calls);
    expect(top).toEqual(p.top_args);
    expect({ PA_1h: countRows('PA-USDT-SWAP', '1h'), PA_4h: countRows('PA-USDT-SWAP', '4h'), PB_1h: countRows('PB-USDT-SWAP', '1h') }).toEqual(p.rows);
  });

  it('cleanup: rows older than 365 days are deleted (cutoff inclusive stays), counts match', () => {
    const c = fx.cleanup;
    for (const [k, b] of Object.entries(c.seeds)) {
      const [symbol, tf] = k.split('|');
      CS.storeCandles(symbol, tf, Frame.fromBars(b), { log: silentLog });
    }
    const before = CS.cacheStats();
    const deleted = CS.cleanup({ now: () => c.now_ms, log: silentLog });
    const after = CS.cacheStats();
    expect(deleted).toBe(c.deleted);
    expect({ symbols: before.symbols, candles: before.candles }).toEqual(c.before);
    expect({ symbols: after.symbols, candles: after.candles }).toEqual(c.after);
    expect(CS.getCoverage('OLD-USDT-SWAP', '1h')).toEqual(c.cov_old);
    expect(countRows('MIX-USDT-SWAP', '1h')).toBe(c.rows_mix);
    expect(countRows('EDGE-USDT-SWAP', '1h')).toBe(c.rows_edge);
    // Known deviation (no candle_meta table on the site): the bot keeps the oldest_ts of the
    // deleted rows in candle_meta; the site's coverage is MIN/MAX of the remaining rows. Both
    // give the same ensure_candles decisions for days ≤ 365 (= MAX_AGE_DAYS).
    const remaining = db.prepare("SELECT MIN(open_time) AS o, MAX(open_time) AS n FROM candles_cache WHERE symbol = 'MIX-USDT-SWAP'").get();
    expect(CS.getCoverage('MIX-USDT-SWAP', '1h')).toEqual([remaining.o, remaining.n]);
    expect(c.cov_mix_meta_quirk[1]).toBe(remaining.n);
    expect(c.cov_mix_meta_quirk[0]).toBeLessThan(c.cutoff_ms);
  });

  it('HistoryLoader paging: same request windows and bars as backtest.BingXHistoryLoader.load', async () => {
    for (const p of fx.paging) {
      const grid = [];
      for (let t = p.grid_first; t <= p.grid_last; t += p.tf_ms) grid.push(t);
      expect(grid.length, `${p.name} grid`).toBe(p.grid_n);
      const row = (t) => {
        const i = (t - p.grid_first) / p.tf_ms;
        const pr = 100 + (i % 97) * 0.25;
        return { open: String(pr), high: String(pr + 0.5), low: String(pr - 0.5), close: String(pr + 0.125), volume: String(1000 + i), time: t };
      };
      const calls = [];
      const http = async (url, { params = {} } = {}) => {
        calls.push([url.split('/').pop(), { ...params }]);
        if (!('startTime' in params)) return okJson({ code: 0, data: [] });
        const s = Number(params.startTime), e = Number(params.endTime), lim = Number(params.limit);
        const sel = grid.filter((t) => s <= t && t <= e).slice(-lim);
        return okJson({ code: 0, data: sel.reverse().map(row) });
      };
      const loader = new CS.HistoryLoader({ http, now: () => p.now_ms, sleep: noSleep, log: silentLog });
      const res = await loader.load(p.symbol, p.tf, p.days);
      expect(calls, `${p.name} calls`).toEqual(p.calls);
      if (p.result === null) {
        expect(res, p.name).toBe(null);
        continue;
      }
      expect(res, p.name).not.toBe(null);
      sameNumbers(res.t, p.result.t, `${p.name}.t`);
      const n = res.length;
      p.result.head.forEach((b, i) => { const r = res.row(i); sameNumbers([r.o, r.h, r.l, r.c, r.v], b, `${p.name} head[${i}]`); });
      p.result.tail.forEach((b, j) => { const i = n - p.result.tail.length + j; const r = res.row(i); sameNumbers([r.o, r.h, r.l, r.c, r.v], b, `${p.name} tail[${j}]`); });
    }
  });

  it('getTopCoins with / without contracts / tickers (live filter, non-crypto, unparsable volume, stable ties)', async () => {
    const tc = fx.top_coins;
    for (const variant of ['both', 'no_contracts', 'no_tickers']) {
      const http = async (url) => {
        if (url.includes('contracts')) return variant === 'no_contracts' ? httpError(500) : okJson(tc.contracts);
        return variant === 'no_tickers' ? httpError(500) : okJson(tc.tickers);
      };
      const loader = new CS.HistoryLoader({ http, now: () => fx.prefetch.now_ms, sleep: noSleep, log: silentLog });
      expect(await loader.getTopCoins(5_000_000), variant).toEqual(tc[variant]);
    }
    expect(Array.from(SM.getLive()).sort()).toEqual(tc.live_after);
  });
});
