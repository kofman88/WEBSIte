/**
 * bingxRest.js — BingxRest against a mocked HTTP layer: request shape, multiplier,
 * 429 / non-200 / bad-envelope handling, dead symbols (109418/109425, 1 h), retries,
 * getAllUsdtPairs (status, non-crypto, blacklist, cap, volBySym, 120 s cache, ≤ 20 keys),
 * get24hChange and checkSymbol.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
const req = createRequire(import.meta.url);
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const R = req('../../services/marketData/bingxRest.js');
const S = req('../../services/marketData/symbolMap.js');
const RG = req('../../services/marketData/rateGate.js');
import { makeHttp, sleepSpy, logSpy } from './helpers.js';

const { BingxRest, BINGX_KLINES, BINGX_TICKER, BINGX_CONTRACTS, parseContracts, DEAD_TTL_S, PAIRS_CACHE_TTL_S } = R;
const H = 3_600_000;
const here = path.dirname(fileURLToPath(import.meta.url));
const sample = JSON.parse(fs.readFileSync(path.join(here, '../fixtures/marketData/klines_v3_sample.json'), 'utf8'));
const NOW = 1717000600000;
const passGate = { run: (fn) => fn() };

function rows(n, start = 0) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ open: String(100 + i), high: String(101 + i), low: String(99 + i), close: String(100.5 + i), volume: '10', time: start + i * H });
  return out;
}

function mk(handler, extra = {}) {
  const http = makeHttp(handler);
  const sleep = sleepSpy();
  const log = logSpy();
  let t = NOW;
  const rest = new BingxRest({ http, gate: passGate, sleep, log, now: () => t, ...extra });
  return { rest, http, sleep, log, setNow: (v) => { t = v; } };
}

beforeEach(() => { S._setLive([]); RG._resetRateLimitStats(); });

describe('getCandles', () => {
  it('requests the BingX symbol/interval/limit/timestamp and divides prices by the multiplier', async () => {
    const { rest, http } = mk(() => ({ code: 0, data: rows(3) }));
    const f = await rest.getCandles('PEPE-USDT-SWAP', '4H', 200);
    const p = http.calls[0].params;
    expect(http.calls[0].url).toBe(BINGX_KLINES);
    expect({ symbol: p.symbol, interval: p.interval, limit: p.limit }).toEqual({ symbol: '1000PEPE-USDT', interval: '4h', limit: '200' });
    expect(p.timestamp).toBe(String(NOW));
    expect(f.c[0]).toBeCloseTo(100.5 / 1000, 12);
    expect(f.length).toBe(3);
    expect(rest.apiCalls).toBe(1);
  });

  it('caps the limit at 1440, accepts BTCUSDT input and uses 1h for an unknown tf (quirk)', async () => {
    const { rest, http } = mk(() => ({ code: 0, data: rows(2) }));
    await rest.getCandles('BTCUSDT', '7h', 5000);
    expect(http.calls[0].params.symbol).toBe('BTC-USDT');
    expect(http.calls[0].params.interval).toBe('1h');
    expect(http.calls[0].params.limit).toBe('1440');
  });

  it('parses the v3 sample (dict and list rows) and drops the forming bar', async () => {
    const { rest } = mk((url, p) => (p.interval === '1h' ? sample.dict_rows : sample.list_rows));
    const f = await rest.getCandles('PEPE-USDT-SWAP', '1h');
    expect(f.length).toBe(4);
    const g = await rest.getCandles('PEPE-USDT-SWAP', '4h');
    expect(g.length).toBe(1);                                   // list rows read as 4 h bars: only the first is closed
  });

  it('429: sleeps Retry-After (default 3 s) inside the gate, records the hit and returns null', async () => {
    let n = 0;
    const { rest, sleep } = mk(() => ({ status: 429, json: null, headers: n++ === 0 ? {} : { 'Retry-After': '7' } }));
    expect(await rest.getCandles('BTC-USDT-SWAP', '1h', 300, 1)).toBe(null);
    expect(sleep.calls).toEqual([3000]);
    expect(await rest.getCandles('BTC-USDT-SWAP', '1h', 300, 1)).toBe(null);
    expect(sleep.calls).toEqual([3000, 7000]);
    expect(RG.getRateLimitStats().rateLimitHitsTotal).toBe(2);
  });

  it('non-200 / non-object JSON / error code → null, [BINGX-DATA] warned once per 60 s', async () => {
    const answers = [{ status: 500, json: null, text: 'oops' }, [1, 2], { code: 100400, msg: 'bad' }];
    let i = 0;
    const { rest, log, sleep } = mk(() => answers[i++ % answers.length]);
    expect(await rest.getCandles('BTC-USDT-SWAP', '1h', 300, 3)).toBe(null);
    expect(sleep.calls).toEqual([1000, 2000]);            // sleep(1.0 * attempt) between attempts
    expect(log.lines.warning).toHaveLength(1);
    expect(log.lines.warning[0]).toMatch(/^\[BINGX-DATA\] HTTP 500/);
    expect(rest.lastError).toContain('code=100400');
    expect(rest.isDead('BTC-USDT-SWAP')).toBe(false);
    // an unparsable 200 body (aiohttp resp.json() raising) and a literal JSON null
    const { rest: r2 } = mk(() => ({ status: 200, json: null, text: '<html>maintenance</html>' }));
    expect(await r2.getCandles('BTC-USDT-SWAP', '1h', 300, 1)).toBe(null);
    expect(r2.lastError).toContain('invalid JSON');
    const { rest: r3 } = mk(() => ({ status: 200, json: null, text: 'null' }));
    expect(await r3.getCandles('BTC-USDT-SWAP', '1h', 300, 1)).toBe(null);
    expect(r3.lastError).toContain('non-dict JSON');
  });

  it('109425 / 109418 mark the symbol dead for 3600 s: no retries, no requests', async () => {
    const { rest, http, sleep, setNow } = mk(() => sample.dead_contract);
    expect(await rest.getCandles('LUNC-USDT-SWAP', '1h')).toBe(null);
    expect(http.calls).toHaveLength(1);
    expect(sleep.calls).toEqual([]);
    expect(rest.isDead('LUNC-USDT-SWAP')).toBe(true);
    expect(await rest.getCandles('LUNC-USDT-SWAP', '1h')).toBe(null);
    expect(http.calls).toHaveLength(1);
    setNow(NOW + (DEAD_TTL_S + 1) * 1000);
    expect(rest.isDead('LUNC-USDT-SWAP')).toBe(false);
    await rest.getCandles('LUNC-USDT-SWAP', '1h');
    expect(http.calls).toHaveLength(2);
    const { rest: r2 } = mk(() => sample.offline_contract);
    await r2.getCandles('TON-USDT-SWAP', '1h');
    expect(r2.isDead('TON-USDT-SWAP')).toBe(true);
    // a dead code without a symbol (contracts call) does not mark anything
    const { rest: r3 } = mk(() => sample.dead_contract);
    expect(await r3.getJson(BINGX_CONTRACTS, {})).toBe(null);
  });

  it('transport errors: timeout and generic errors are retried, then null', async () => {
    let n = 0;
    const { rest, sleep } = mk(() => {
      n++;
      if (n === 1) { const e = new Error('t/o'); e.name = 'TimeoutError'; throw e; }
      throw new Error('ECONNRESET');
    });
    expect(await rest.getCandles('BTC-USDT-SWAP', '1h')).toBe(null);
    expect(n).toBe(2);
    expect(sleep.calls).toEqual([1000]);
    expect(rest.lastError).toContain('ECONNRESET');
  });

  it('goes through the shared rate gate by default', async () => {
    const http = makeHttp(() => ({ code: 0, data: rows(2) }));
    const rest = new BingxRest({ http, sleep: sleepSpy(), log: logSpy(), now: () => NOW });
    expect(rest._gate).toBe(RG.sharedGate);
    expect((await rest.getCandles('BTC-USDT-SWAP', '1h')).length).toBe(2);
  });
});

describe('checkSymbol', () => {
  it('true when klines 1h limit 2 has data, false otherwise / on error', async () => {
    const { rest, http } = mk((url, p) => (p.symbol === 'BTC-USDT' ? { code: 0, data: rows(2) } : { code: 0, data: [] }));
    expect(await rest.checkSymbol('BTC-USDT-SWAP')).toBe(true);
    expect(http.calls[0].params).toEqual({ symbol: 'BTC-USDT', interval: '1h', limit: '2' });
    expect(http.calls[0].opts.timeoutMs).toBe(8000);
    expect(await rest.checkSymbol('NOPE-USDT-SWAP')).toBe(false);
    const { rest: r2 } = mk(() => { throw new Error('down'); });
    expect(await r2.checkSymbol('BTC-USDT-SWAP')).toBe(false);
  });
});

describe('getAllUsdtPairs', () => {
  const contracts = { code: 0, data: [
    { symbol: 'BTC-USDT', status: 1 }, { symbol: '1000PEPE-USDT', status: 1 }, { symbol: 'DEAD-USDT', status: 0 },
    { symbol: 'ETH-USDC', status: 1 }, { symbol: 'NCCOGOLD2USD-USDT', status: 1 }, { symbol: 'USDC-USDT', status: 'true' },
    { symbol: 'LOW-USDT', status: 1 },
  ] };
  const tickers = { code: 0, data: [
    { symbol: 'BTC-USDT', quoteVolume: '900000000' }, { symbol: '1000PEPE-USDT', quoteVolume: '5000000' },
    { symbol: 'DEAD-USDT', quoteVolume: '99000000' }, { symbol: 'NCCOGOLD2USD-USDT', quoteVolume: '9e9' },
    { symbol: 'USDC-USDT', quoteVolume: '7000000' }, { symbol: 'LOW-USDT', quoteVolume: 'abc' },
  ] };
  const handler = (url) => (url === BINGX_CONTRACTS ? contracts : tickers);

  it('uses quoteVolume, status and the non-crypto filter; remembers live names; sets volBySym', async () => {
    const { rest } = mk(handler);
    expect(await rest.getAllUsdtPairs(1_000_000)).toEqual(['BTC-USDT-SWAP', 'USDC-USDT-SWAP', 'PEPE-USDT-SWAP']);
    expect(rest.volBySym).toEqual({ 'BTC-USDT-SWAP': 900_000_000, 'USDC-USDT-SWAP': 7_000_000, 'PEPE-USDT-SWAP': 5_000_000 });
    expect(Array.from(S.getLive()).sort()).toEqual(['1000PEPE-USDT', 'BTC-USDT', 'ETH-USDC', 'LOW-USDT', 'USDC-USDT']);
  });

  it('blacklist, volume floor (unparsable → 0) and maxCoins; volBySym only holds passing symbols', async () => {
    const { rest } = mk(handler);
    expect(await rest.getAllUsdtPairs(0, ['USDC-USDT-SWAP'])).toEqual(['BTC-USDT-SWAP', 'PEPE-USDT-SWAP', 'LOW-USDT-SWAP']);
    expect(rest.volBySym['LOW-USDT-SWAP']).toBe(0);
    expect(await rest.getAllUsdtPairs(6_000_000, [], 1)).toEqual(['BTC-USDT-SWAP']);
    expect(rest.volBySym).toEqual({ 'BTC-USDT-SWAP': 900_000_000, 'USDC-USDT-SWAP': 7_000_000 });
  });

  it('caches the result for 120 s per (minVolume, maxCoins, blacklist) and keeps ≤ 20 keys', async () => {
    const { rest, http, setNow } = mk(handler);
    const a = await rest.getAllUsdtPairs(1_000_000);
    expect(http.calls).toHaveLength(2);
    const b = await rest.getAllUsdtPairs(1_000_000);
    expect(b).toEqual(a);
    expect(b).not.toBe(a);                            // list(copy)
    expect(http.calls).toHaveLength(2);
    await rest.getAllUsdtPairs(1_000_000, ['X']);     // different key → fetch
    expect(http.calls).toHaveLength(4);
    setNow(NOW + (PAIRS_CACHE_TTL_S + 1) * 1000);
    await rest.getAllUsdtPairs(1_000_000);
    expect(http.calls).toHaveLength(6);
    for (let i = 0; i < 25; i++) await rest.getAllUsdtPairs(i);
    expect(rest._pairsCache.size).toBe(20);
  });

  it('contracts null → []; tickers null → sorted live set; exception → []', async () => {
    const { rest: r1 } = mk((url) => (url === BINGX_CONTRACTS ? { code: 1 } : tickers));
    expect(await r1.getAllUsdtPairs()).toEqual([]);
    const { rest: r2 } = mk((url) => (url === BINGX_CONTRACTS ? contracts : { status: 503, json: null }));
    expect(await r2.getAllUsdtPairs(0, ['USDC-USDT-SWAP'])).toEqual(['BTC-USDT-SWAP', 'LOW-USDT-SWAP', 'PEPE-USDT-SWAP']);
    const { rest: r3, log } = mk(() => { throw new Error('net'); });
    expect(await r3.getAllUsdtPairs()).toEqual([]);
    expect(log.lines.error[0]).toContain('BingX: ошибка загрузки монет');
  });

  it('parseContracts helper', () => {
    // liveRaw keeps every live crypto contract (ETH-USDC included — it is appended before
    // the canonical conversion, exactly like the bot); canon only holds USDT contracts.
    expect(parseContracts(contracts.data)).toEqual({
      liveRaw: ['BTC-USDT', '1000PEPE-USDT', 'ETH-USDC', 'USDC-USDT', 'LOW-USDT'],
      canon: new Set(['BTC-USDT-SWAP', 'PEPE-USDT-SWAP', 'USDC-USDT-SWAP', 'LOW-USDT-SWAP']),
    });
  });
});

describe('get24hChange', () => {
  it('returns OKX-unit prices, the percent string stripped, quoteVolume', async () => {
    const { rest, http } = mk(() => ({ code: 0, data: { lastPrice: '2.0', openPrice: '1.0', priceChangePercent: '100%', quoteVolume: '123' } }));
    const r = await rest.get24hChange('PEPE-USDT-SWAP');
    expect(http.calls[0].url).toBe(BINGX_TICKER);
    expect(http.calls[0].params).toEqual({ symbol: '1000PEPE-USDT' });
    expect(r.last).toBeCloseTo(0.002, 12);
    expect(r.price).toBe(r.last);
    expect(r.change_pct).toBe(100);
    expect(r.change_pct_24h).toBe(100);
    expect(r.volume_usdt).toBe(123);
    expect(r.vol_24h_usdt).toBe(123);
  });

  it('list payload, computed change when the percent is missing, nulls', async () => {
    const { rest } = mk(() => ({ code: 0, data: [{ lastPrice: '3', openPrice: '2', quoteVolume: '' }] }));
    const r = await rest.get24hChange('BTCUSDT');
    expect(r.change_pct).toBeCloseTo(50, 9);
    expect(r.volume_usdt).toBe(0);
    const { rest: r2 } = mk(() => ({ code: 0, data: [] }));
    expect(await r2.get24hChange('BTC-USDT-SWAP')).toBe(null);
    const { rest: r3 } = mk(() => ({ code: 0, data: { lastPrice: '1', openPrice: '0' } }));
    expect((await r3.get24hChange('BTC-USDT-SWAP')).change_pct).toBe(0);
    const { rest: r4 } = mk(() => ({ status: 500, json: null }));
    expect(await r4.get24hChange('BTC-USDT-SWAP')).toBe(null);
    const { rest: r5 } = mk(() => { throw new Error('x'); });
    expect(await r5.get24hChange('BTC-USDT-SWAP')).toBe(null);
  });
});
