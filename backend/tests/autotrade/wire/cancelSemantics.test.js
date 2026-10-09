/**
 * asyncio cancellation through the REAL site traders (the semantics the wire differential found
 * divergent before this branch, pinned at the unit level):
 *
 *   • `except Exception` never catches asyncio.CancelledError — every trader `catch` re-raises it
 *     first (pyCompat.rethrowCancelled), so a wait_for timeout leaves no log line, error dict,
 *     fallback request or retry behind (BingX / Binance / OKX: aiohttp coroutines);
 *   • Bybit's pybit work is `await loop.run_in_executor(...)`: the coroutine stops at that await,
 *     the thread runs on to its end (rt.runInThread);
 *   • bybit_call(fn, timeout) = wait_for(to_thread(fn), timeout): asyncio.TimeoutError ('') with the
 *     bot's «bybit_call <fn> hard timeout=<t>s» line, the thread's late answer dropped, the timer
 *     cleared when the thread answers first.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);
const A = req('../../../services/autotrade/asyncio.js');
const { productionOverrides } = req('../../../services/autotrade/traders.js');
const { memoryKv } = req('../../../services/exchanges/runtime.js');
const { rethrowCancelled } = req('../../../services/exchanges/pyCompat.js');
const { createVClock } = req('../core/vclock.js');

const FACTORY = {
  bybit: () => req('../../../services/exchanges/bybitTrader.js').createBybitTrader,
  bingx: () => req('../../../services/exchanges/bingxTrader.js').createBingxTrader,
  binance: () => req('../../../services/exchanges/binanceTrader.js').createBinanceTrader,
  okx: () => req('../../../services/exchanges/okxTrader.js').createOkxTrader,
};

function world(ex, answer) {
  const clk = createVClock(1767781800.25);
  const sent = [];
  const lines = [];
  const mk = (lvl) => (m) => lines.push([clk.mono(), lvl, String(m)]);
  const log = { debug: mk('DEBUG'), info: mk('INFO'), warning: mk('WARNING'), warn: mk('WARNING'), error: mk('ERROR'), critical: mk('CRITICAL') };
  const transport = async (r) => {
    sent.push([clk.mono(), r.method, String(r.url).replace(/^https:\/\/[^/]+/, '').split('?')[0]]);
    return answer(r, clk);
  };
  const o = productionOverrides({
    transport, sleep: (s) => clk.sleep(s),
    extra: { now: clk.now, monotonic: clk.mono, timers: clk.timers, log, kv: memoryKv(), random: () => 0.5, env: {} },
  });
  return { clk, sent, lines, trader: FACTORY[ex]()(o) };
}

const json = (obj) => ({ status: 200, headers: { 'content-type': 'application/json' }, text: JSON.stringify(obj) });

describe('CancelledError passes every trader catch (except Exception semantics)', () => {
  it('pyCompat.rethrowCancelled: only CancelledError is re-raised', () => {
    expect(() => rethrowCancelled(new A.CancelledError())).toThrow(A.CancelledError);
    expect(() => rethrowCancelled(new A.TimeoutError())).not.toThrow();
    expect(() => rethrowCancelled(new Error('x'))).not.toThrow();
    expect(() => rethrowCancelled(null)).not.toThrow();
  });

  for (const ex of ['bingx', 'binance', 'okx']) {
    it(`${ex} get_balance under wait_for(…, 2): one request, then nothing — no error log, no fallback, TimeoutError`, async () => {
      const w = world(ex, async (r, clk) => { await clk.sleep(30); return json({ code: 0, data: [] }); });
      const t0 = w.clk.mono();
      const args = ex === 'okx' ? ['k'.repeat(16), 's'.repeat(16), 'pp'] : ['k'.repeat(16), 's'.repeat(16)];
      const p = A.waitFor(() => w.trader.getBalance(...args), 2, { timers: w.clk.timers });
      await expect(w.clk.run(p)).rejects.toMatchObject({ name: 'TimeoutError', message: '' });
      expect(w.sent.length).toBe(1);
      expect(w.lines.filter(([t]) => t >= t0 + 2)).toEqual([]);
    });
  }

  it('binance place_trade under a timeout: the hanging order request is abandoned, nothing follows it (no fallback / cleanup / log)', async () => {
    const w = world('binance', async (r, clk) => {
      if (r.method === 'POST' && /\/fapi\/v1\/(batchOrders|order)\?/.test(r.url)) { await clk.sleep(30); return json([]); }
      if (r.url.includes('/fapi/v1/exchangeInfo')) {
        return json({ symbols: [{ symbol: 'ETHUSDT', status: 'TRADING', filters: [{ filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' }, { filterType: 'PRICE_FILTER', tickSize: '0.01' }] }] });
      }
      if (r.url.includes('/fapi/v2/balance')) return json([{ asset: 'USDT', balance: '1000', availableBalance: '1000' }]);
      if (r.url.includes('/ticker/price')) return json({ symbol: 'ETHUSDT', price: '3000' });
      if (r.url.includes('/positionSide/dual')) return json({ code: -4059, msg: 'No need to change position side.' });
      if (r.url.includes('/leverage')) return json({ leverage: 10, symbol: 'ETHUSDT' });
      return json({});
    });
    const p = A.waitFor(() => w.trader.placeTrade('k'.repeat(16), 's'.repeat(16), 'ETH-USDT-SWAP', 'LONG', 3000, 2950, 3100, 1.0, 10,
      { orderType: 'Market', clientOrderId: 'chm_0123456789ab' }), 20, { timers: w.clk.timers });
    await expect(w.clk.run(p)).rejects.toMatchObject({ name: 'TimeoutError' });
    const first = w.sent.findIndex(([, m, path]) => m === 'POST' && /^\/fapi\/v1\/(batchOrders|order)$/.test(path));
    expect(first).toBeGreaterThanOrEqual(0);
    const tHang = w.sent[first][0];
    expect(w.sent.slice(first + 1)).toEqual([]);
    expect(w.lines.filter(([t]) => t > tHang)).toEqual([]);
  });
});

describe('Bybit pybit thread semantics', () => {
  const wallet = json({ retCode: 0, retMsg: 'OK', result: { list: [{ accountType: 'UNIFIED', totalAvailableBalance: '900', coin: [{ coin: 'USDT', availableToWithdraw: '900', walletBalance: '1000' }] }] }, retExtInfo: {}, time: 1 });

  it('get_balance under wait_for(…, 2): the coroutine stops, the thread finishes its pybit request', async () => {
    let answered = 0;
    const w = world('bybit', async (r, clk) => {
      if (r.url.includes('/v5/market/time')) return json({ retCode: 0, retMsg: 'OK', result: { timeSecond: '1767781800', timeNano: '1767781800250000000' } });
      await clk.sleep(5);
      answered += 1;
      return wallet;
    });
    const p = A.waitFor(() => w.trader.getBalance('k'.repeat(16), 's'.repeat(16), false), 2, { timers: w.clk.timers });
    await expect(w.clk.run(p)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(answered).toBeGreaterThanOrEqual(1);          // the thread got its answer at t=5 (dropped)
  });

  it('bybit_call: hard timeout → TimeoutError("") + the bot line; the thread answer arrives later and is dropped', async () => {
    const w = world('bybit', async () => json({}));
    let done = false;
    const fn = async () => { await w.clk.sleep(12); done = true; return { retCode: 0 }; };
    const p = w.trader.bybitCall(fn, { qty: '1' }, { apiKey: 'k'.repeat(16), fnName: 'place_order', timeout: 8.0 });
    await expect(w.clk.run(p)).rejects.toMatchObject({ pyType: 'TimeoutError', message: '' });
    expect(done).toBe(true);
    expect(w.lines.map(([, l, m]) => `${l} ${m}`)).toContain('ERROR bybit_call place_order hard timeout=8.0s');
  });

  it('bybit_call inside the timeout: the value, and no timer left behind', async () => {
    const w = world('bybit', async () => json({}));
    const p = w.trader.bybitCall(async (k) => ({ retCode: 0, echo: k.qty }), { qty: '2' }, { apiKey: 'k'.repeat(16), fnName: 'place_order', timeout: 8.0 });
    expect(await w.clk.run(p)).toEqual({ retCode: 0, echo: '2' });
    expect(w.clk.pending()).toBe(0);
    expect(w.clk.mono()).toBe(1000);
  });
});
