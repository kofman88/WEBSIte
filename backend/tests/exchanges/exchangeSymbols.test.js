/**
 * exchangeSymbols.js — strict / fail-open semantics of isAvailable / isSymbolAvailable,
 * the 4 fetchers against a mocked HTTP layer (paging, DNS-flap retry, Binance circuit
 * breaker, OKX/BingX filters), refresh preserving the previous cache, the 5-minute
 * re-refresh on critical failure, skip counters, stats and the background loop.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
const req = createRequire(import.meta.url);
const ES = req('../../services/exchanges/exchangeSymbols.js');
const S = req('../../services/marketData/symbolMap.js');
const { makeHttp, sleepSpy, silentLog, logSpy } = req('../marketData/helpers.js');

const { TTL, STALE_THRESHOLD_SEC, isAvailable, isSymbolAvailable, refresh, fetchBybit, fetchBinance, fetchBingx, fetchOkx, recordSkip, popSkipCounter, getStats, startBackgroundRefresh, setMetricHook, _setSymbols, _getState, _resetForTests, BYBIT_URL, BINGX_URL, BINANCE_URLS, OKX_URL } = ES;

const NOW = 1_700_000_000;
const nowFn = () => NOW;

beforeEach(() => { _resetForTests(); S._setLive([]); });
afterEach(() => _resetForTests());

describe('isAvailable strict semantics', () => {
  it('empty cache → true (strict → false)', () => {
    expect(isAvailable('BTC-USDT-SWAP', 'bybit')).toBe(true);
    expect(isAvailable('BTC-USDT-SWAP', 'bybit', true)).toBe(false);
    expect(isAvailable('BTC-USDT-SWAP', 'bybit', { strict: true })).toBe(false);
    expect(isAvailable('BTC-USDT-SWAP', 'bybit', { strict: false })).toBe(true);
  });

  it('native lookup per exchange (case-insensitive exchange name)', () => {
    _setSymbols('bybit', ['BTCUSDT', '1000PEPEUSDT', 'SHIB1000USDT', '10000SATSUSDT'], { updatedAt: NOW });
    _setSymbols('binance', ['BTCUSDT', '1000SATSUSDT', '1000SHIBUSDT']);
    _setSymbols('bingx', ['BTC-USDT', '1000PEPE-USDT', 'TONCOIN-USDT']);
    _setSymbols('okx', ['BTC-USDT-SWAP']);
    const o = { now: nowFn };
    expect(isAvailable('BTC-USDT-SWAP', 'Bybit', false, o)).toBe(true);
    expect(isAvailable('PEPE-USDT-SWAP', 'BYBIT', true, o)).toBe(true);
    expect(isAvailable('SHIB-USDT-SWAP', 'bybit', true, o)).toBe(true);
    expect(isAvailable('SATS-USDT-SWAP', 'bybit', true, o)).toBe(true);
    expect(isAvailable('ETH-USDT-SWAP', 'bybit', false, o)).toBe(false);     // loaded cache, genuinely missing
    expect(isAvailable('SATS-USDT-SWAP', 'binance', true, o)).toBe(true);    // 1000SATSUSDT
    expect(isAvailable('SHIB-USDT-SWAP', 'binance', true, o)).toBe(true);
    expect(isAvailable('PEPE-USDT-SWAP', 'binance', false, o)).toBe(false);
    expect(isAvailable('PEPE-USDT-SWAP', 'bingx', true, o)).toBe(true);
    expect(isAvailable('TON-USDT-SWAP', 'bingx', true, o)).toBe(true);       // alias TONCOIN
    expect(isAvailable('BTC-USDT-SWAP', 'okx', true, o)).toBe(true);
    expect(isAvailable('BTCUSDT', 'okx', false, o)).toBe(false);             // identity for okx
  });

  it('unknown exchange → true (strict → false); stale cache (> 8 h) → strict false', () => {
    _setSymbols('bybit', ['BTCUSDT'], { updatedAt: NOW });
    _setSymbols('kraken', ['BTCUSDT']);
    expect(isAvailable('BTC-USDT-SWAP', 'kraken', false, { now: nowFn })).toBe(true);
    expect(isAvailable('BTC-USDT-SWAP', 'kraken', true, { now: nowFn })).toBe(false);
    const later = () => NOW + STALE_THRESHOLD_SEC + 1;
    expect(isAvailable('BTC-USDT-SWAP', 'bybit', false, { now: later })).toBe(true);     // non-strict proceeds
    expect(isAvailable('ETH-USDT-SWAP', 'bybit', false, { now: later })).toBe(false);
    expect(isAvailable('BTC-USDT-SWAP', 'bybit', true, { now: later })).toBe(false);     // strict distrusts
    expect(isAvailable('BTC-USDT-SWAP', 'bybit', true, { now: () => NOW + STALE_THRESHOLD_SEC })).toBe(true);
    _getState().updatedAt = 0;                                                             // age unknown ≠ stale
    expect(isAvailable('BTC-USDT-SWAP', 'bybit', true, { now: later })).toBe(true);
    expect(STALE_THRESHOLD_SEC).toBe(28800);
    expect(TTL).toBe(14400);
  });

  it('a non-string symbol raises from the normaliser (like None.upper())', () => {
    _setSymbols('bybit', ['BTCUSDT'], { updatedAt: NOW });
    expect(() => isAvailable(null, 'bybit', false, { now: nowFn })).toThrow(TypeError);
  });

  it('emits metrics through the hook, which never breaks the check', () => {
    const seen = [];
    setMetricHook((n, tags) => { seen.push([n, tags]); if (n === 'symbol_check_total') throw new Error('metrics down'); });
    _setSymbols('bybit', ['BTCUSDT'], { updatedAt: NOW });
    expect(isAvailable('ETH-USDT-SWAP', 'bybit', false, { now: nowFn })).toBe(false);
    expect(isAvailable('ETH-USDT-SWAP', 'nope', false, { now: nowFn })).toBe(true);
    expect(isAvailable('BTC-USDT-SWAP', 'bybit', false, { now: () => NOW + STALE_THRESHOLD_SEC + 1 })).toBe(true);
    expect(seen.map(([n]) => n)).toEqual([
      'symbol_check_total', 'scanner_invalid_symbol_filtered',
      'symbol_check_total', 'symbol_check_fail_open',
      'symbol_check_total', 'symbol_check_stale',
    ]);
    // an exchange without a cache entry is an empty cache first (the unknown-exchange
    // reason only fires for a seeded but unsupported exchange)
    expect(seen[3][1]).toEqual({ exchange: 'nope', reason: 'cache_empty', symbol: 'ETH-USDT-SWAP' });
    _setSymbols('kraken', ['X']);
    expect(isAvailable('ETH-USDT-SWAP', 'kraken', false, { now: nowFn })).toBe(true);
    expect(seen.at(-1)).toEqual(['symbol_check_fail_open', { exchange: 'kraken', reason: 'unknown_exchange', symbol: 'ETH-USDT-SWAP' }]);
    expect(seen[5][1]).toEqual({ exchange: 'bybit', age_hours: 8 });
  });
});

describe('isSymbolAvailable (rotated signature, any symbol format)', () => {
  it('accepts native names as-is, normalises canonical ones, fail-open on normalise errors', () => {
    _setSymbols('bybit', ['BTCUSDT', '1000PEPEUSDT'], { updatedAt: NOW });
    const o = { now: nowFn, log: silentLog };
    expect(isSymbolAvailable('bybit', 'BTCUSDT', false, o)).toBe(true);
    expect(isSymbolAvailable('Bybit', 'BTC-USDT-SWAP', true, o)).toBe(true);
    expect(isSymbolAvailable('bybit', 'PEPE-USDT-SWAP', true, o)).toBe(true);
    expect(isSymbolAvailable('bybit', 'ETH-USDT-SWAP', false, o)).toBe(false);
    expect(isSymbolAvailable('bybit', null, false, o)).toBe(true);          // normalize_failed → fail-open
    expect(isSymbolAvailable('bybit', null, true, o)).toBe(false);
    expect(isSymbolAvailable('binance', 'BTC-USDT-SWAP', false, o)).toBe(true);   // empty cache
    expect(isSymbolAvailable('binance', 'BTC-USDT-SWAP', true, o)).toBe(false);
    _setSymbols('kraken', ['X']);
    expect(isSymbolAvailable('kraken', 'BTC-USDT-SWAP', false, o)).toBe(true);
    expect(isSymbolAvailable('kraken', 'BTC-USDT-SWAP', true, o)).toBe(false);
    const later = { now: () => NOW + STALE_THRESHOLD_SEC + 1, log: silentLog };
    expect(isSymbolAvailable('bybit', 'BTCUSDT', true, later)).toBe(false);
    expect(isSymbolAvailable('bybit', 'BTCUSDT', false, later)).toBe(true);
  });
});

describe('skip counters and stats', () => {
  it('recordSkip / popSkipCounter are case-insensitive and reset on pop', () => {
    recordSkip('Bybit', 'ETH-USDT-SWAP');
    recordSkip('bybit', 'ETH-USDT-SWAP');
    recordSkip('bingx', 'X-USDT-SWAP');
    expect(popSkipCounter()).toEqual([3, { 'bybit/ETH-USDT-SWAP': 2, 'bingx/X-USDT-SWAP': 1 }]);
    expect(popSkipCounter()).toEqual([0, {}]);
  });

  it('getStats shape', () => {
    _setSymbols('bybit', ['A', 'B'], { updatedAt: NOW - 100 });
    recordSkip('bybit', 'A');
    expect(getStats({ now: nowFn, env: {} })).toEqual({
      bybit: 2, bingx: 0, binance: 0, okx: 0, updated_at: NOW - 100, age_sec: 100, skip_counter: 1,
      ttl_sec: 14400, stale_threshold_sec: 28800, binance_disabled: false, binance_paused_until: 0, binance_paused: false,
    });
    expect(getStats({ now: nowFn, env: { DISABLE_BINANCE: 'yes' } }).binance_disabled).toBe(true);
    _getState().updatedAt = 0;
    expect(getStats({ now: nowFn, env: {} }).age_sec).toBe(null);
  });
});

describe('fetchers', () => {
  it('bybit: paged by nextPageCursor, status Trading, 0.1 s between pages', async () => {
    const http = makeHttp((url, p) => {
      if (!p.cursor) return { result: { list: [{ symbol: 'BTCUSDT', status: 'Trading' }, { symbol: 'XUSDT', status: 'PreLaunch' }, { symbol: 'BTCUSDC', status: 'Trading' }], nextPageCursor: 'c2' } };
      return { result: { list: [{ symbol: 'ETHUSDT', status: 'Trading' }], nextPageCursor: '' } };
    });
    const sleep = sleepSpy();
    const r = await fetchBybit({ http, sleep, log: silentLog });
    expect(r).toEqual(new Set(['BTCUSDT', 'ETHUSDT']));
    expect(http.calls[0].params).toEqual({ category: 'linear', limit: '1000' });
    expect(http.calls[1].params.cursor).toBe('c2');
    expect(http.calls[0].url).toBe(BYBIT_URL);
    expect(sleep.calls).toEqual([100]);
  });

  it('bybit: DNS flap retried 3× with jittered backoff, other errors return the partial set', async () => {
    let n = 0;
    const http = makeHttp(() => { n++; if (n < 3) throw new Error('getaddrinfo ENOTFOUND api.bybit.com'); return { result: { list: [{ symbol: 'BTCUSDT', status: 'Trading' }] } }; });
    const sleep = sleepSpy();
    const r = await fetchBybit({ http, sleep, log: silentLog, random: () => 0.5 });
    expect(r).toEqual(new Set(['BTCUSDT']));
    expect(sleep.calls).toEqual([2000, 4000]);                       // (attempt+1)*2 × (0.7 + 0.5×0.6 = 1.0)
    const http2 = makeHttp(() => { throw new Error('boom'); });
    expect(await fetchBybit({ http: http2, sleep: sleepSpy(), log: silentLog })).toEqual(new Set());
    const http3 = makeHttp(() => ({ status: 403, json: null }));
    expect(await fetchBybit({ http: http3, sleep: sleepSpy(), log: silentLog })).toEqual(new Set());
    const http4 = makeHttp(() => { throw new Error('getaddrinfo ENOTFOUND'); });
    expect(await fetchBybit({ http: http4, sleep: sleepSpy(), log: silentLog, random: () => 0 })).toEqual(new Set());
    expect(http4.calls).toHaveLength(3);
  });

  it('bingx: -USDT contracts, live names remembered for the symbol map', async () => {
    const http = makeHttp(() => ({ code: 0, data: [{ symbol: 'BTC-USDT', status: 1 }, { symbol: 'TONCOIN-USDT', status: 0 }, { symbol: 'BTC-USDC', status: 1 }, { symbol: 'TON-USDT' }] }));
    expect(await fetchBingx({ http, log: silentLog })).toEqual(new Set(['BTC-USDT', 'TONCOIN-USDT', 'TON-USDT']));
    expect(http.calls[0].url).toBe(BINGX_URL);
    expect(Array.from(S.getLive()).sort()).toEqual(['BTC-USDT', 'TON-USDT']);
    expect(S.toBingx('TON-USDT-SWAP')).toBe('TON-USDT');
    expect(await fetchBingx({ http: makeHttp(() => ({ status: 500, json: null })), log: silentLog })).toEqual(new Set());
    expect(await fetchBingx({ http: makeHttp(() => { throw new Error('x'); }), log: silentLog })).toEqual(new Set());
  });

  it('binance: first working host wins; 3 consecutive failures → 1 h pause; DISABLE_BINANCE', async () => {
    const http = makeHttp((url) => (url.startsWith(BINANCE_URLS[0]) ? { status: 403, json: null } : { symbols: [{ symbol: 'BTCUSDT', status: 'TRADING' }, { symbol: 'XUSDT', status: 'BREAK' }] }));
    expect(await fetchBinance({ http, now: nowFn, log: silentLog, env: {} })).toEqual(new Set(['BTCUSDT']));
    expect(http.calls).toHaveLength(2);
    expect(http.calls[1].url).toBe(BINANCE_URLS[1]);
    const dead = makeHttp(() => { throw new Error('geo'); });
    for (let i = 0; i < 2; i++) expect(await fetchBinance({ http: dead, now: nowFn, log: silentLog, env: {} })).toEqual(new Set());
    expect(_getState().binanceConsecutiveFails).toBe(2);
    expect(dead.calls).toHaveLength(10);
    await fetchBinance({ http: dead, now: nowFn, log: silentLog, env: {} });
    expect(_getState().binanceSkipUntil).toBe(NOW + 3600);
    expect(_getState().binanceConsecutiveFails).toBe(0);
    await fetchBinance({ http: dead, now: nowFn, log: silentLog, env: {} });     // paused: no calls
    expect(dead.calls).toHaveLength(15);
    expect(await fetchBinance({ http: dead, now: () => NOW + 3601, log: silentLog, env: {} })).toEqual(new Set());
    expect(dead.calls).toHaveLength(20);
    const off = makeHttp(() => ({ symbols: [] }));
    expect(await fetchBinance({ http: off, now: nowFn, log: silentLog, env: { DISABLE_BINANCE: '1' } })).toEqual(new Set());
    expect(off.calls).toHaveLength(0);
  });

  it('okx: -USDT-SWAP instruments with instType=SWAP', async () => {
    const http = makeHttp(() => ({ data: [{ instId: 'BTC-USDT-SWAP' }, { instId: 'BTC-USD-SWAP' }, { instId: 'ETH-USDT-SWAP' }] }));
    expect(await fetchOkx({ http, log: silentLog })).toEqual(new Set(['BTC-USDT-SWAP', 'ETH-USDT-SWAP']));
    expect(http.calls[0].url).toBe(OKX_URL);
    expect(http.calls[0].params).toEqual({ instType: 'SWAP' });
    expect(await fetchOkx({ http: makeHttp(() => ({ status: 500, json: null })), log: silentLog })).toEqual(new Set());
  });
});

describe('refresh', () => {
  const okAll = (url) => {
    if (url === BYBIT_URL) return { result: { list: [{ symbol: 'BTCUSDT', status: 'Trading' }] } };
    if (url === BINGX_URL) return { code: 0, data: [{ symbol: 'BTC-USDT', status: 1 }] };
    if (url === OKX_URL) return { data: [{ instId: 'BTC-USDT-SWAP' }] };
    return { symbols: [{ symbol: 'BTCUSDT', status: 'TRADING' }] };
  };

  it('fills all four caches and stamps updatedAt', async () => {
    const log = logSpy();
    await refresh({ http: makeHttp(okAll), now: nowFn, sleep: sleepSpy(), log, env: {} });
    expect(getStats({ now: nowFn, env: {} })).toMatchObject({ bybit: 1, bingx: 1, binance: 1, okx: 1, updated_at: NOW, age_sec: 0 });
    expect(log.lines.info).toContain('Exchange symbols refreshed: Bybit=1, BingX=1, Binance=1, OKX=1');
  });

  it('empty / failing results keep the previous cache; bybit gets one 10 s retry', async () => {
    await refresh({ http: makeHttp(okAll), now: nowFn, sleep: sleepSpy(), log: silentLog, env: {} });
    let bybitCalls = 0;
    const http = makeHttp((url) => {
      if (url === BYBIT_URL) { bybitCalls++; return bybitCalls === 1 ? { result: { list: [] } } : { result: { list: [{ symbol: 'ETHUSDT', status: 'Trading' }] } }; }
      if (url === BINGX_URL) throw new Error('down');
      if (url === OKX_URL) return { data: [] };
      return { symbols: [{ symbol: 'ETHUSDT', status: 'TRADING' }] };
    });
    const sleep = sleepSpy();
    const log = logSpy();
    await refresh({ http, now: () => NOW + 100, sleep, log, env: {} });
    expect(sleep.calls).toEqual([10_000]);
    expect(_getState().symbols.bybit).toEqual(new Set(['ETHUSDT']));         // retry result
    expect(_getState().symbols.bingx).toEqual(new Set(['BTC-USDT']));        // preserved
    expect(_getState().symbols.okx).toEqual(new Set(['BTC-USDT-SWAP']));     // preserved
    expect(_getState().symbols.binance).toEqual(new Set(['ETHUSDT']));
    expect(_getState().updatedAt).toBe(NOW + 100);
    // fetchBingx swallows transport errors and returns an empty set → the "returned 0" branch
    expect(log.lines.warning.some((l) => l.startsWith('BINGX refresh returned 0 — keeping previous cache (1 symbols, age 100s)'))).toBe(true);
    expect(log.lines.warning.some((l) => l.startsWith('OKX refresh returned 0 — keeping previous cache'))).toBe(true);
    expect(log.lines.info.some((l) => l.includes('Bybit delisted examples: BTCUSDT'))).toBe(true);
  });

  it('all empty → updatedAt not advanced; critical exchange still empty → next refresh in 5 min', async () => {
    const log = logSpy();
    const http = makeHttp((url) => (url === BINGX_URL ? { code: 0, data: [{ symbol: 'BTC-USDT', status: 1 }] } : { status: 500, json: null }));
    await refresh({ http, now: nowFn, sleep: sleepSpy(), log, env: {} });
    expect(_getState().updatedAt).toBe(NOW - (TTL - 300));
    expect(log.lines.warning.some((l) => l.startsWith('⚠️ BYBIT: 0 символов — фильтрация ОТКЛЮЧЕНА (fail-open)'))).toBe(true);
    expect(log.lines.warning.some((l) => l.startsWith('⚠️ BINANCE: 0 символов'))).toBe(true);
    expect(log.lines.info).toContain('🔄 Critical exchange has 0 symbols — next refresh in 5 min');
    _resetForTests();
    const log2 = logSpy();
    await refresh({ http: makeHttp(() => ({ status: 500, json: null })), now: nowFn, sleep: sleepSpy(), log: log2, env: {} });
    expect(log2.lines.warning.some((l) => l.startsWith('exchange_symbols.refresh: ALL 4 exchanges returned empty'))).toBe(true);
  });

  it('binance disabled/paused is not treated as critical', async () => {
    const log = logSpy();
    const http = makeHttp((url) => (url === BINANCE_URLS.find((u) => u === url) ? { symbols: [] } : okAll(url)));
    await refresh({ http, now: nowFn, sleep: sleepSpy(), log, env: { DISABLE_BINANCE: '1' } });
    expect(_getState().updatedAt).toBe(NOW);
    expect(log.lines.info).not.toContain('🔄 Critical exchange has 0 symbols — next refresh in 5 min');
  });

  it('startBackgroundRefresh refreshes immediately and sleeps until updatedAt + TTL (min 60 s)', async () => {
    const sleeps = [];
    let loop;
    let t = NOW;
    let healthy = true;
    const sleep = async (ms) => { sleeps.push(ms); healthy = false; t = NOW + TTL + 1000; if (sleeps.length >= 3) loop.stop(); };
    const http = makeHttp((url) => (healthy ? okAll(url) : { status: 500, json: null }));
    loop = await startBackgroundRefresh({ http, now: () => t, sleep, log: silentLog, env: {} });
    expect(_getState().updatedAt).toBe(NOW);
    await loop.done;
    // 1st wait = updatedAt + TTL − now = TTL; the 2nd refresh fails everywhere (10 s bybit
    // retry, previous caches preserved, updatedAt stays NOW while now is past the TTL) →
    // the 60 s floor
    expect(sleeps).toEqual([TTL * 1000, 10_000, 60 * 1000]);
    expect(_getState().updatedAt).toBe(NOW);
    expect(_getState().symbols.bybit).toEqual(new Set(['BTCUSDT']));
  });
});
