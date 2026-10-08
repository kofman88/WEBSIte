/**
 * services/exchanges/index.js (uniform getTrader adapter) and balanceCache.js.
 *
 * balanceCache replays fixtures/balance_cache.json — balance_cache.get_cached_balance /
 * gc_cache driven by py/gen_balance_cache.py with stubbed trader get_balance coroutines and a
 * fake clock: results, the exchange calls made (args / demo / passphrase) and cache sizes.
 *
 * The adapter is checked against the bot's call sites: auto_trade place_trade kwargs
 * (`demo` for bybit, `passphrase` for okx, nothing extra for bingx/binance), the FIX-B4
 * split → midpoint fallback, and _panic_close_position's per-exchange close signature.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const req = createRequire(import.meta.url);
const EX = req('../../services/exchanges/index.js');
const BC = req('../../services/exchanges/balanceCache.js');
const { loadFixture, makeLog } = req('./helpers.js');

function recorder() {
  const calls = [];
  const inst = new Proxy({}, {
    get(_t, name) {
      if (name === 'then') return undefined;
      return async (...args) => { calls.push([name, args]); return { ok: true, name }; };
    },
  });
  return { calls, inst };
}

function registryWith(map) {
  return EX.createRegistry({ instances: map });
}

describe('balance_cache replay', () => {
  const ROWS = loadFixture('balance_cache.json');
  it('get_cached_balance / gc_cache sequence equals the bot', async () => {
    let t = 1767225600.0;
    let reply = null;
    const calls = [];
    const fake = (exchange) => ({
      getBalance: (creds) => {
        const c = { exchange, args: [creds.apiKey, creds.apiSecret], kwargs: {} };
        if (exchange === 'bybit') c.kwargs.demo = creds.demo;
        if (exchange === 'okx') c.kwargs.passphrase = creds.passphrase;
        calls.push(c);
        if (reply && typeof reply === 'object' && reply.raise) return Promise.reject(new Error(reply.raise));
        if (reply && typeof reply === 'object' && reply.timeout) return new Promise(() => {});
        return Promise.resolve(reply);
      },
    });
    // asyncio.wait_for(…, 5.0): a never-settling call times out
    const withTimeout = (p, s) => Promise.race([p, new Promise((_r, rej) => setTimeout(() => rej(new BC.BalanceTimeout()), s === 5.0 ? 1 : 0))]);
    const cache = BC.createBalanceCache({ getTrader: fake, now: () => t, withTimeout, log: makeLog() });
    for (const row of ROWS) {
      const st = row.step;
      if (st.op === 'advance') { t += st.s; continue; }
      if (st.op === 'gc') {
        expect(cache.gcCache(), 'gc').toBe(row.result);
        expect(cache._cache.size).toBe(row.size);
        continue;
      }
      reply = st.reply;
      calls.length = 0;
      const res = await cache.getCachedBalance(st.user, st.exchange);
      expect(res, JSON.stringify(st)).toBe(row.result);
      expect(calls, 'calls').toEqual(row.calls);
      expect(cache._cache.size).toBe(row.size);
    }
  });
});

describe('getTrader adapter dispatch', () => {
  const creds = { apiKey: 'K', apiSecret: 'S', passphrase: 'P', demo: true };
  const P = { symbol: 'BTC-USDT-SWAP', direction: 'LONG', entry: 100, sl: 95, tp1: 110, riskPct: 1.0, leverage: 10, tp2: 115, tp3: 0, tradeId: 77, userId: 5 };

  it('placeTrade forwards demo (bybit) / passphrase (okx) like auto_trade', async () => {
    const regs = {};
    for (const ex of EX.EXCHANGES) regs[ex] = recorder();
    const reg = EX.createRegistry({ instances: { 'bybit:live': regs.bybit.inst, 'bingx:live': regs.bingx.inst, 'binance:demo': regs.binance.inst, 'okx:demo': regs.okx.inst } });
    for (const ex of EX.EXCHANGES) await EX.getTrader(ex, { registry: reg }).placeTrade(creds, P);
    const base = { tp2: 115, tp3: 0, riskMode: 'risk', orderType: 'Limit', tradeId: 77, userId: 5, allowLowNotionalBoost: false };
    const args = ['K', 'S', 'BTC-USDT-SWAP', 'LONG', 100, 95, 110, 1.0, 10];
    expect(regs.bybit.calls).toEqual([['placeTrade', [...args, { ...base, demo: true }]]]);
    expect(regs.bingx.calls).toEqual([['placeTrade', [...args, base]]]);
    expect(regs.binance.calls).toEqual([['placeTrade', [...args, base]]]);
    expect(regs.okx.calls).toEqual([['placeTrade', [...args, { ...base, passphrase: 'P' }]]]);
  });

  it('placeTradeSplit: bybit native, others midpoint place_trade (FIX-B4)', async () => {
    const by = recorder();
    const bx = recorder();
    const log = makeLog();
    const reg = registryWith({ bybit: by.inst, bingx: bx.inst });
    const sp = { ...P, entryLo: 98, entryHi: 102 };
    await EX.getTrader('bybit', { registry: reg }).placeTradeSplit({ ...creds, demo: false }, sp);
    await EX.getTrader('bingx', { registry: reg, log }).placeTradeSplit({ ...creds, demo: false }, sp);
    expect(by.calls[0]).toEqual(['placeTradeSplit', ['K', 'S', 'BTC-USDT-SWAP', 'LONG', 98, 102, 95, 110, 1.0, 10, { tp2: 115, tp3: 0, demo: false, userId: 5 }]]);
    expect(bx.calls[0][0]).toBe('placeTrade');
    expect(bx.calls[0][1][4]).toBe(100);
    expect(log.has('split-entry не поддерживается BINGX')).toBe(true);
  });

  it('closePosition follows _panic_close_position per exchange', async () => {
    const r = {};
    for (const ex of EX.EXCHANGES) r[ex] = recorder();
    const reg = registryWith({ bybit: r.bybit.inst, bingx: r.bingx.inst, binance: r.binance.inst, okx: r.okx.inst });
    const c = { ...creds, demo: false };
    for (const ex of EX.EXCHANGES) await EX.getTrader(ex, { registry: reg }).closePosition(c, { symbol: 'BTC-USDT-SWAP', side: 'LONG', size: 12000.0, posIdx: 1 });
    // python: str(12000.0) == '12000.0'
    expect(r.bybit.calls[0]).toEqual(['closePosition', ['K', 'S', 'BTC-USDT-SWAP', 'LONG', '12000.0', 1, false]]);
    expect(r.bingx.calls[0]).toEqual(['closePosition', ['K', 'S', 'BTC-USDT-SWAP', 'LONG', 12000, 1]]);
    expect(r.binance.calls[0]).toEqual(['closePosition', ['K', 'S', 'BTC-USDT-SWAP', 'LONG', 12000, 1]]);
    expect(r.okx.calls[0]).toEqual(['closePosition', ['K', 'S', 'BTC-USDT-SWAP', 'LONG', 'P']]);
  });

  it('reads / cancels / trailing carry demo or passphrase in the bot positions', async () => {
    const r = {};
    for (const ex of EX.EXCHANGES) r[ex] = recorder();
    const reg = registryWith({ bybit: r.bybit.inst, bingx: r.bingx.inst, binance: r.binance.inst, okx: r.okx.inst });
    const c = { apiKey: 'K', apiSecret: 'S', passphrase: 'P', testnet: false };
    for (const ex of EX.EXCHANGES) {
      const t = EX.getTrader(ex, { registry: reg });
      await t.getBalance(c);
      await t.getPositions(c);
      await t.getOpenOrders(c);
      await t.cancelAllOrders(c, 'ETHUSDT');
      await t.getClosedPnl(c, 'ETHUSDT');
      await t.testConnection(c);
      await t.setTrailingSl(c, { symbol: 'ETHUSDT', newSl: 3000.5, direction: 'SHORT' });
    }
    expect(r.bybit.calls).toEqual([
      ['getBalance', ['K', 'S', false]], ['getPositions', ['K', 'S', '', false]], ['getOpenOrders', ['K', 'S', false]],
      ['cancelAllOrders', ['K', 'S', 'ETHUSDT', false]], ['getClosedPnl', ['K', 'S', 'ETHUSDT', false]], ['testConnection', ['K', 'S', false]],
      ['setTrailingSl', ['K', 'S', 'ETHUSDT', 3000.5, 'SHORT', 0, false]],
    ]);
    expect(r.binance.calls).toEqual([
      ['getBalance', ['K', 'S']], ['getPositions', ['K', 'S', null]], ['getOpenOrders', ['K', 'S']],
      ['cancelAllOrders', ['K', 'S', 'ETHUSDT']], ['getClosedPnl', ['K', 'S', 'ETHUSDT']], ['testConnection', ['K', 'S']],
      ['setTrailingSl', ['K', 'S', 'ETHUSDT', 3000.5, 'SHORT', 0]],
    ]);
    expect(r.okx.calls).toEqual([
      ['getBalance', ['K', 'S', 'P']], ['getPositions', ['K', 'S', null, 'P']], ['getOpenOrders', ['K', 'S', 'P']],
      ['cancelAllOrders', ['K', 'S', 'ETHUSDT', 'P']], ['getClosedPnl', ['K', 'S', 'ETHUSDT', 'P']], ['testConnection', ['K', 'S', 'P']],
      ['setTrailingSl', ['K', 'S', 'ETHUSDT', 3000.5, 'SHORT', 0, 'P']],
    ]);
    expect(r.bingx.calls.map((x) => x[1].length)).toEqual([2, 3, 2, 3, 3, 2, 6]);
  });

  it('demo instances: okx gets the simulated-trading header, binance the futures testnet', () => {
    const reg = EX.createRegistry({ overrides: { transport: async () => { throw new Error('offline'); } } });
    const okDemo = EX.getTrader('okx', { registry: reg }).instance({ demo: true });
    const okLive = EX.getTrader('okx', { registry: reg }).instance({ demo: false });
    expect(okDemo).not.toBe(okLive);
    const bnDemo = EX.getTrader('binance', { registry: reg }).instance({ testnet: true });
    expect(bnDemo._state.baseUrl).toBe(EX.BINANCE_TESTNET_URL);
    expect(EX.getTrader('binance', { registry: reg }).instance({})._state.baseUrl).toBe('https://fapi.binance.com');
    // bybit / bingx: one instance (bybit carries demo per call, bingx has no demo)
    expect(EX.getTrader('bybit', { registry: reg }).instance({ demo: true })).toBe(EX.getTrader('bybit', { registry: reg }).instance({}));
  });

  it('unknown exchange resolves to bybit like _get_trader_module', () => {
    expect(EX.resolveExchange('kraken')).toBe('bybit');
    expect(EX.resolveExchange('OKX')).toBe('okx');
    expect(EX.isSupportedExchange('kraken')).toBe(false);
    expect(EX.getTrader('').exchange).toBe('bybit');
  });

  it('exposes the uniform surface', () => {
    const t = EX.getTrader('bingx');
    for (const m of ['placeTrade', 'placeTradeSplit', 'setTrailingSl', 'closePosition', 'cancelAllOrders', 'getOpenOrders', 'getPositions', 'getBalance', 'getClosedPnl', 'testConnection']) {
      expect(typeof t[m], m).toBe('function');
    }
    expect(t.priceMultiplier('PEPE-USDT-SWAP')).toBe(1000);
  });
});
