/**
 * Self-test of the M15 replay harness (harness.js) against its Python twin (py/m15_harness.py
 * self_test, recorded in fixtures/m15_units.json.gz → `harness`):
 *   the fake traderFor answers the bot's recorded calls in order and binds every site call to the bot
 *   signature (values, strict-read err_out, raises, latency / hang on the virtual clock under waitFor,
 *   a synchronous function, two named tasks in parallel) — same results at the same virtual instants;
 *   the bot's TypeError text for a call the site must not make; mismatching / extra / missing calls are
 *   reported; the delivery recorder and the log capture produce the Python record shapes; the site DB
 *   seed + dump against a real db_set_trade_result round; vclock.runUntil for loop shells; a cancelled
 *   virtual sleep leaves no timer behind (consecutive clk.run steps keep the bot's instants); same-instant
 *   timers fire in the bot's (FIFO) order; the call recorders tag the bot and no fixture holds an address.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);
const H = req('./harness.js');
const site = H.setupSiteDb('selftest');
const FX = H.loadFixture('m15_units');
const S = FX.harness;
const asyncio = req('../../../services/autotrade/asyncio.js');
const { pf } = req('../../../services/autotrade/pyfmt.js');
const { PyError } = req('../../../services/exchanges/pyCompat.js');
const TDB = req('../../../services/autotrade/tradeDb.js');

const [, W0, M0] = S.out[0];

/** The JS twin of m15_harness._selftest_body (site method names, positional site calls). */
async function twin(fk, clk) {
  const t = (ex) => fk.traderFor(ex);
  const out = [['start', clk.now(), clk.mono()]];
  const t0 = clk.mono();
  const w0 = clk.now();
  const errs = [];
  let r = await t('bybit').getPositions('BYK-1', 'BYS-1', '', true, { strict: true, errOut: errs });
  out.push(['bybit.get_positions', r, [...errs], clk.mono() - t0]);
  const errs2 = [];
  r = await t('okx').getPositions('OKK-1', 'OKS-1', null, 'OKP-1', { strict: true, errOut: errs2 });
  out.push(['okx.get_positions', r, [...errs2], clk.mono() - t0]);
  r = await t('okx').getPositions('OKK-1', 'OKS-1', 'OKP-1', '');          // BE1-Q9: the bot's positional binding
  out.push(['okx.get_positions.positional', r, clk.mono() - t0]);
  try {
    await asyncio.waitFor(() => t('bingx').getPositions('BXK-1', 'BXS-1'), 6.0, { timers: clk.timers });
    out.push(['bingx.no_timeout']);
  } catch (e) {
    out.push([asyncio.isTimeoutError(e) ? 'bingx.timeout' : `bingx.${e.message}`, clk.mono() - t0]);
  }
  // BE1-Q12: the bot's call raises TypeError before any request — the site makes no call and logs the text
  out.push(['binance.get_open_orders.TypeError', S.bind_errors[0].error]);
  r = await t('binance').cancelAllOrders('BNK-1', 'BNS-1', 'BTCUSDT');
  out.push(['binance.cancel_all_orders', r, clk.mono() - t0]);
  try {
    await t('okx').getAlgoSlOrders('OKK-1', 'OKS-1', 'BTC-USDT-SWAP', 'OKP-1');
  } catch (e) {
    out.push(['okx.get_algo_sl_orders.raise', e.pyType, e.message]);
  }
  out.push(['bybit.is_delisted', t('bybit').isDelisted('BTCUSDT'), t('bybit').isDelisted('BTCUSDT'), t('bybit').isDelisted('ETHUSDT')]);
  const worker = async (name, fn) => [name, await fn(), clk.mono() - t0];
  const pa = asyncio.runAsTask('slv_a', () => worker('a', () => t('bingx').getOpenOrders('BXK-1', 'BXS-1')));
  const pb = asyncio.runAsTask('slv_b', () => worker('b', () => t('bybit').getOpenOrders('BYK-1', 'BYS-1', false)));
  const res = await Promise.allSettled([pa, pb]);
  out.push(['gather', res.map((x) => (x.status === 'fulfilled' ? x.value : String(x.reason)))]);
  await clk.sleep(10);
  out.push(['after_sleep', clk.mono() - t0, clk.now() - w0]);
  const D = H.makeDeliveryRecorder({ clock: clk, failOn: ['FAIL'], safeResults: [['blocked', false]] });
  const ok1 = await D.sendMessage(D.bot, 201, '<b>hello</b>');
  const ok2 = await D.sendMessage(D.bot, 202, 'you blocked me', { parseMode: null });
  try {
    await D.bot.sendMessage(123, 'admin FAIL', { parseMode: 'HTML' });
    out.push(['bot.no_raise']);
  } catch (e) {
    out.push(['bot.send_message.raise', e.message]);
  }
  await D.bot.sendMessage(123, 'admin ok', { parseMode: 'HTML' });
  out.push(['safe_send', ok1, ok2]);
  const L = H.makeLogCapture(clk);
  L.info(pf('[M15-SELFTEST] value=%s ratio=%.2f', 3, 0.125));
  try {
    throw new PyError('ValueError', 'boom');
  } catch (e) {
    L.exception('[M15-SELFTEST] caught', e);
  }
  return { out, sent: D.sent, logs: L.lines };
}

describe('harness self-test: the JS twin of m15_harness.self_test', () => {
  let got;
  let fk;
  let clk;
  beforeAll(async () => {
    clk = H.createVClock(W0, M0);
    fk = H.makeFakeTraders({ calls: S.calls, sigs: S.sigs, clock: clk, labels: S.labels });
    got = await clk.run(twin(fk, clk));
  });

  it('the Python side checked its own contract (no harness errors, one bind error, the recorded calls)', () => {
    expect(S.errors).toEqual([]);
    expect(S.bind_errors.map((b) => [b.ex, b.fn, b.error])).toEqual([
      ['binance', 'get_open_orders', 'get_open_orders() takes 2 positional arguments but 3 were given']]);
    expect(S.calls.map((c) => `${c.task}:${c.ex}.${c.fn}`)).toEqual([
      'main:bybit.get_positions', 'main:okx.get_positions', 'main:okx.get_positions', 'main:bingx.get_positions',
      'main:binance.cancel_all_orders', 'main:okx.get_algo_sl_orders', 'main:bybit.is_delisted', 'main:bybit.is_delisted',
      'main:bybit.is_delisted', 'slv_a:bingx.get_open_orders', 'slv_b:bybit.get_open_orders']);
  });

  it('same results at the same virtual instants', () => {
    expect(got.out).toEqual(S.out);
  });

  it('the run ends where the bot step ends: the timed-out hang left no timer (no jump to its abandoned deadline)', () => {
    const afterSleep = S.out.find((r) => r[0] === 'after_sleep');
    expect(clk.pending()).toBe(0);
    expect(clk.mono()).toBe(M0 + afterSleep[1]);          // not M0 + 30 (bingx {hang: 30} under waitFor(6))
    expect(clk.now()).toBe(W0 + afterSleep[2]);
  });

  it('every site call bound to the bot signature equals the bot call (no mismatch, extra or missing call)', () => {
    expect(fk.problems()).toEqual([]);
    expect(fk.jsCalls.map((c) => [c.t, c.mono, c.task, c.ex, c.fn, c.bound])).toEqual(S.calls.map((c) => [c.t, c.mono, c.task, c.ex, c.fn, c.bound]));
  });

  it('the delivery recorder and the log capture give the Python record shapes', () => {
    expect(got.sent).toEqual(S.sent);
    expect(got.logs.map(({ t, task, level, msg, exc }) => ({ t, task, level, msg, exc })))
      .toEqual(S.logs.map(({ t, task, level, msg, exc }) => ({ t, task, level, msg, exc })));
  });
});

describe('harness self-test: consecutive clk.run steps keep the bot instants (vclockSleep)', () => {
  it('step 1 = a hang under waitFor(6) → TimeoutError at +6; step 2\'s call is recorded at +6, as in the bot', async () => {
    const hang = S.calls.find((c) => c.ex === 'bingx' && c.fn === 'get_positions');
    const next = S.calls.find((c) => c.ex === 'binance' && c.fn === 'cancel_all_orders');
    expect(hang.answer).toEqual({ hang: 30 });
    expect(next.mono - hang.mono).toBe(6);                 // the bot: the cancelled sleep handle never moved the clock
    const clk = H.createVClock(hang.t, hang.mono);
    const fk = H.makeFakeTraders({ calls: [hang, next], sigs: S.sigs, clock: clk, labels: S.labels });
    const e1 = await clk.run(asyncio.waitFor(() => fk.traderFor('bingx').getPositions('BXK-1', 'BXS-1'), 6.0, { timers: clk.timers }).catch((e) => e));
    expect(asyncio.isTimeoutError(e1)).toBe(true);
    expect([clk.mono(), clk.pending()]).toEqual([hang.mono + 6, 0]);
    expect(await clk.run(fk.traderFor('binance').cancelAllOrders('BNK-1', 'BNS-1', 'BTCUSDT'))).toEqual(next.answer.value);
    expect(fk.jsCalls.map((c) => [c.fn, c.mono, c.t])).toEqual([[hang.fn, hang.mono, hang.t], [next.fn, next.mono, next.t]]);
    expect(fk.problems()).toEqual([]);
  });

  it('vclockSleep = cancellableSleep(clk.sleep) for the caller, minus the orphan timer', async () => {
    const clk = H.createVClock(W0, M0);
    const ctrl = new AbortController();
    const sleep = H.vclockSleep(clk);
    const p = asyncio.runInScope(ctrl.signal, () => sleep(1e9)).catch((e) => e);
    await Promise.resolve();
    expect(clk.pending()).toBe(1);
    ctrl.abort();
    expect(asyncio.isCancelledError(await p)).toBe(true);
    expect(clk.pending()).toBe(0);
    await expect(asyncio.runInScope(ctrl.signal, () => sleep(1))).rejects.toThrow();   // already cancelled: no timer at all
    expect(clk.pending()).toBe(0);
    expect(await clk.run(sleep(2.5).then(() => clk.mono()))).toBe(M0 + 2.5);           // outside any scope: a plain sleep
  });
});

describe('harness self-test: same-instant timers fire in the bot order (FIFO on both clocks)', () => {
  const T = S.ties;
  for (const n of [4, 8, 16]) {
    it(`${n} equal sleeps wake in creation order`, async () => {
      expect(T[`sleep_${n}`]).toEqual(Array.from({ length: n }, (_x, i) => `t${i + 1}`));
      const clk = H.createVClock(W0, M0);
      const order = [];
      const tasks = Array.from({ length: n }, (_x, i) => asyncio.runAsTask(`t${i + 1}`, async () => { await clk.sleep(4); order.push(`t${i + 1}`); }));
      await clk.run(Promise.all(tasks));
      expect(order).toEqual(T[`sleep_${n}`]);
    });
  }
  it('call_later callbacks of three instants scheduled out of order', async () => {
    const clk = H.createVClock(W0, M0);
    const order = [];
    T.call_later_delays.forEach((d, i) => clk.timers.setTimeout(() => order.push(`c${i}@${d}`), d * 1000));
    await clk.run(clk.sleep(5));
    expect(order).toEqual(T.call_later);
  });
});

describe('harness self-test: call recorders and fixture determinism', () => {
  it('the bot object passed to a fire-and-forget collaborator is the {__bot__: true} tag; unknown objects carry no address', () => {
    expect(S.recorded.map((r) => [r.task, r.fn, r.args, r.kwargs])).toEqual([
      ['main', 'smart_prompts.trigger_after_win', [{ __bot__: true }, 201, 'BTCUSDT', 1.5], {}],
      ['main', 'trade_autopsy.stream_analyze_closed_trade', [{ __bot__: true }, 201, { trade_id: 'st-1', symbol: 'BTCUSDT' }],
        { lang: 'ru', notify: { __bot__: true } }],
      ['main', 'metrics.record', ['be_monitor.pass', 1], { tags: { obj: { __obj__: 'object' }, fn: { __obj__: 'function' } } }],
    ]);
    expect(S.recorder_results).toEqual([null, true, null]);
  });
  it('no M15 fixture holds a memory address (two generator runs write the same bytes)', () => {
    for (const f of fs.readdirSync(H.FIXTURES).filter((x) => x.endsWith('.json.gz'))) {
      const raw = zlib.gunzipSync(fs.readFileSync(path.join(H.FIXTURES, f))).toString('utf8');
      expect(raw.match(/ at 0x[0-9a-fA-F]+/g), f).toBe(null);
    }
  });
});

describe('harness self-test: the fake traders report every disagreement', () => {
  const sig = S.sigs.bybit.get_positions;
  const call = (bound, answer = { value: [] }, extra = {}) => ({ i: 0, t: 0, mono: 0, task: 'main', ex: 'bybit', fn: 'get_positions', bound, answer, ...extra });
  const boundOf = (args) => H.bindToSig(sig.sig, args, new Map()).bound;

  it('different arguments, an extra call and a missing call', async () => {
    const clk = H.createVClock(W0, M0);
    const fk = H.makeFakeTraders({
      calls: [call(boundOf(['k', 's', '', true])), call(boundOf(['k', 's', '', false])), call(boundOf(['k', 's', 'BTCUSDT', false]))],
      sigs: { bybit: { get_positions: sig } }, clock: clk,
    });
    const t = fk.traderFor('bybit');
    await t.getPositions('k', 's', '', true);            // same
    await t.getPositions('k', 's', '', true);            // demo differs
    expect(fk.problems().map((p) => p.kind)).toEqual(['args', 'missing']);
    await t.getPositions('k', 's', 'BTCUSDT', false);
    await expect(t.getPositions('k', 's')).rejects.toThrow('made no further bybit.get_positions call');
    expect(fk.problems().map((p) => p.kind)).toEqual(['args', 'extra']);
  });

  it('per-task queues (byTask): the same call in another task is not taken', async () => {
    const clk = H.createVClock(W0, M0);
    const fk = H.makeFakeTraders({ calls: [call(boundOf(['k', 's']), { value: [1] }, { task: 'slv_t1' })], sigs: { bybit: { get_positions: sig } }, clock: clk, byTask: true });
    await expect(fk.traderFor('bybit').getPositions('k', 's')).rejects.toThrow('in task main');
    expect(await asyncio.runAsTask('slv_t1', () => fk.traderFor('bybit').getPositions('k', 's'))).toEqual([1]);
  });

  it('bindToSig: options object = keyword-only parameters; errors for arity / unknown keywords', () => {
    const b = H.bindToSig(sig.sig, ['k', 's', '', true, { strict: true, errOut: [] }]);
    expect(b.error).toBe(null);
    expect(b.bound).toEqual([['api_key', '<secret>'], ['api_secret', '<secret>'], ['symbol', ''], ['demo', true], ['strict', true], ['err_out', []]]);
    expect(H.bindToSig(sig.sig, ['k', 's', '', false, { foo: 1 }]).error).toBe("unexpected keyword argument 'foo'");
    expect(H.bindToSig(sig.sig, ['k']).error).toBe("missing a required argument: 'api_secret'");
    expect(H.bindToSig(S.sigs.bingx.get_open_orders.sig, ['k', 's', 'x']).error).toMatch(/too many positional/);
  });
});

describe('harness self-test: site DB seed + dump = the bot DB after db_set_trade_result', () => {
  const D = S.db;
  let db;
  beforeAll(() => {
    db = site.db;
    H.seedSite(db, { usersRaw: D.users_raw, users: D.users, trades: D.trades, kv: D.kv });
  });
  afterAll(() => site.cleanup());

  it('setTradeResult rows, trades / kv / trade_events / trade_feedback dumps', async () => {
    const now = () => D.t + 5.0;
    const log = H.makeLogCapture();
    const tdb = TDB.createTradeDb({ db, now, log, exchanges: ['bybit'], invalidateUserCache: () => {} });
    const rows = [];
    for (const [tid, result, rr, kw] of D.calls) {
      const r = await tdb.setTradeResult(tid, result, rr, { closedPnlUsd: kw.closed_pnl_usd === undefined ? null : kw.closed_pnl_usd,
        skipReason: kw.skip_reason === undefined ? null : kw.skip_reason });
      rows.push(r ? Object.fromEntries(['trade_id', 'result', 'result_rr', 'state', 'skip_reason', 'closed_pnl_usd'].map((k) => [k, r[k]])) : null);
    }
    expect(rows).toEqual(D.rows);
    const dump = H.dumpSiteDb(db, { tRef: D.t, tradeIds: ['st-1', 'st-2', 'st-3'], kvPrefix: 'm15_selftest' });
    expect(H.firstDiff(dump, D.dump)).toBe(null);
    expect(log.at('WARNING')).toEqual(D.logs);
    expect((await tdb.getUserWithKeys(9001)).bybit_api_key).toBe('ST-KEY-0001');
  });
});

describe('vclock.runUntil: an infinite loop shell up to a horizon', () => {
  it('fires every timer due by the limit, leaves the rest, the clock stops at the limit', async () => {
    const clk = H.createVClock(1767225600, 1000);
    const ctrl = new AbortController();
    const passes = [];
    const sleep = H.vclockSleep(clk);
    const shell = asyncio.runInScope(ctrl.signal, async () => {
      for (;;) {
        passes.push(clk.mono());
        await sleep(30);
      }
    });
    const settled = shell.catch((e) => e);
    await clk.runUntil(1095);
    expect(passes).toEqual([1000, 1030, 1060, 1090]);
    expect(clk.mono()).toBe(1095);
    expect(clk.now()).toBe(1767225600 + 95);
    expect(clk.pending()).toBe(1);
    ctrl.abort();
    expect(asyncio.isCancelledError(await settled)).toBe(true);
    expect(clk.pending()).toBe(0);                           // the aborted sleep removed its timer
    await clk.runUntil(2000);
    expect(passes.length).toBe(4);
  });
});
