/**
 * Trade-ops units around the replay (tradeOpsReplay.test.js):
 *   • every kept bot quirk, named, with the bot's own evidence in the fixture (the replay requires
 *     the site to reproduce that step exactly);
 *   • the locks: exec_trade's per-trade lock (a second press answers «⏳ Сделка уже открывается…»),
 *     the per-user FIFO lock every money action runs under, idle locks dropped;
 *   • the trade-ops queue: in-process runner, the worker half over a MessageChannel (job / ping /
 *     heartbeat / shutdown), the supervisor (worker_lost, restart back-off, heartbeat watchdog), the
 *     route's pending / unavailable answers;
 *   • applyEffects (card snapshot without buttons + SSE, every message that stayed → `trade`
 *     notification, nothing for a deleted one, never another user's card);
 *   • unpack3 / position(), the bot's texts (i18n.py), the routes' 404 / 405, D16's card check, and
 *     the SPA's call sites (frontend/app/app.js) against the routes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { EventEmitter } from 'events';
import { MessageChannel } from 'worker_threads';
import { createRequire } from 'module';
import { setupEnv, loadFixture, insertUser, cardJson, makeDelivery, makeLog, rawRequest } from './helpers.js';

const nodeRequire = createRequire(import.meta.url);
setupEnv('units');

const FX = loadFixture();
const S = Object.fromEntries(FX.steps.map((s) => [s.name, s]));
let db; let ts; let CM; let QC; let W; let appTrade; let appRouter; let authService; let repo; let keyboards; let server; let port;

const UID = 9501;
const OTHER = 9502;
const NOW = 1767261600;

function seedTrade(tid, uid, card, extra = {}) {
  const t = { trade_id: tid, user_id: uid, symbol: 'BTC-USDT-SWAP', direction: 'LONG', entry: 87000.5, sl: 86000, tp1: 88500, created_at: NOW - 600, _card: card, ...extra };
  db.prepare(`INSERT INTO signal_trades (trade_id, user_id, symbol, direction, entry, sl, tp1, tp2, tp3, created_at, signal_card_json)
              VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`).run(tid, uid, t.symbol, t.direction, t.entry, t.sl, t.tp1, t.created_at, cardJson(repo, keyboards, t));
}

beforeAll(async () => {
  db = nodeRequire('../../../models/database.js');
  const app = (await import('../../../server.js')).default;
  ts = nodeRequire('../../../services/traderSettingsService.js');
  CM = nodeRequire('../../../services/autotrade/confirmMode.js');
  QC = nodeRequire('../../../services/autotrade/quickClose.js');
  W = nodeRequire('../../../workers/tradeOpsWorker.js');
  appTrade = nodeRequire('../../../routes/appTrade.js');
  appRouter = nodeRequire('../../../routes/app.js');
  authService = nodeRequire('../../../services/authService.js');
  repo = nodeRequire('../../../services/engine/signalTradesRepo.js').defaultRepo;
  keyboards = nodeRequire('../../../services/engine/cards/keyboards.js');
  for (const uid of [UID, OTHER]) {
    insertUser(db, uid);
    const u = ts.getOrCreate(uid);
    Object.assign(u, { sub_plan: 'pro', sub_status: 'active', sub_expires: Math.floor(Date.now() / 1000) + 86400, trade_exchange: 'bybit' });
    ts.save(u);
  }
  seedTrade('u-exec', UID, 'exec');
  seedTrade('u-qc', UID, 'qc');
  seedTrade('u-plain', UID, null);
  seedTrade('u-foreign', OTHER, 'exec');
  seedTrade('u-fx', UID, 'exec');
  appRouter.resetRateLimits();
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

afterAll(async () => {
  if (appTrade) appTrade.configure({ tradeOps: null, execWaitS: null, log: null });
  if (W) W.configureLocal(null);
  if (server) await new Promise((r) => server.close(r));
});

const auth = (uid = UID) => ({ Authorization: `Bearer ${authService._signAccessToken(uid)}`, 'Content-Type': 'application/json' });

// ═══════════════════════════════════════════════════════════════════════
describe('kept bot quirks — each one is a replayed step (the site must match it byte for byte)', () => {
  const sends = (s) => s.effects.filter((e) => e.op === 'send').map((e) => e.text);
  const answers = (s) => s.effects.filter((e) => e.op === 'answer' && e.text).map((e) => e.text);
  const QUIRKS = [
    ['OKX positions: get_dashboard returns (summary, positions) → the 3-way unpack always fails', 'positions okx (3-way unpack of a 2-tuple)',
      (s) => s.text === '{"ok": false, "error": "unavailable", "message": "not enough values to unpack (expected 3, got 2)"}'],
    ['confirm exec calls Bybit without demo: a demo user\'s trade goes to the live host', 'exec bybit demo user → live host (quirk)',
      (s) => s.requests.length > 0 && s.requests.every((r) => r.url.startsWith('https://api.bybit.com/'))],
    ['confirm exec: no orderLinkId (no idempotency key / trade id to the trader)', 'exec bybit opened',
      (s) => s.requests.filter((r) => r.url.endsWith('/order/create')).every((r) => !r.body.includes('orderLinkId'))],
    ['confirm exec: qty is not stored', 'exec bybit opened', (s) => s.trade_after.order_id === 'ord-entry' && s.trade_after.qty === 0 && s.trade_after.tp_placed === 1],
    ['confirm exec on BingX / Binance / OKX never writes tp_placed', 'exec bingx opened', (s) => s.trade_after.order_id !== '' && s.trade_after.tp_placed === 0],
    ['… Binance', 'exec binance opened', (s) => s.trade_after.order_id !== '' && s.trade_after.tp_placed === 0],
    ['… OKX', 'exec okx opened', (s) => s.trade_after.order_id !== '' && s.trade_after.tp_placed === 0],
    ['exec: trade_exchange outside bingx/binance/okx trades on Bybit, the placing text names it capitalised', 'exec trade_exchange kraken → bybit',
      (s) => sends(s)[0] === '⏳ Выставляю ордер на Kraken...' && s.requests.every((r) => r.url.startsWith('https://api.bybit.com/'))],
    ['exec: an empty trade_exchange → "на ..." and Bybit', 'exec empty trade_exchange', (s) => sends(s)[0] === '⏳ Выставляю ордер на ...'],
    ['exec: OKX keys missing → "Okx API не настроен" (the not-set-up map has no okx)', 'exec okx no keys (Okx label)', (s) => sends(s)[0].startsWith('❌ <b>Okx API не настроен</b>')],
    ['sub_expired is defined twice in i18n.py: the later «Подписка истекла!» wins', 'exec banned → sub_expired', (s) => sends(s)[0] === 'Подписка истекла!'],
    ['exec: a missing trade answers exec_signal_stale', 'exec missing trade (bot: stale) → site 404',
      (s) => s.effects[1].text === FX.i18n.exec_signal_stale.ru],
    // [EXEC-STALE-GUARD 2026-10]
    ['exec: a signal the tracker closed (SL) is refused, nothing sent', 'exec stage SL → stale (EXEC-STALE-GUARD)',
      (s) => s.requests.length === 0 && answers(s)[0] === FX.i18n.exec_signal_stale.ru],
    ['… TP1 / MISSED / EXPIRED too', 'exec stage EXPIRED → stale', (s) => s.requests.length === 0],
    ['… a signal older than the tracker horizon too', 'exec older than the tracker horizon → stale', (s) => s.requests.length === 0],
    ['… stage ENTRY passes the guard', 'exec stage ENTRY → placed', (s) => !JSON.stringify(s.effects).includes(FX.i18n.exec_signal_stale.ru)],
    ['exec: check_access passes an expired Pro (free access) — the placement is attempted', 'exec expired pro (free access passes)', (s) => s.requests.length > 0],
    ['exec: the open-trade limit counts rows with an order (this one excluded)', 'exec limit reached', (s) => answers(s)[0].startsWith('⛔ Лимит сделок достигнут (1/1)')],
    ['quick close uses the trade row\'s exchange column, not trade_exchange', 'qc force okx row of the hold user',
      (s) => s.user_after.trade_exchange === 'bybit' && s.requests.length > 0 && s.requests.every((r) => r.url.startsWith('https://www.okx.com/'))],
    ['… a NULL exchange column (SMC rows) is bybit', 'qc half SMC row (NULL exchange → bybit, no bybit keys)', (s) => sends(s)[0] === 'API-ключи не настроены'],
    ['quick close: pos_idx NULL → int(None) TypeError text', 'qc half pos_idx NULL → int(None)',
      (s) => sends(s)[0].startsWith('❌ Ошибка: int() argument must be a string, a bytes-like object')],
    // [QC-SIDE-FIX 2026-10] (bot and site): close_position gets the POSITION direction — a LONG
    // closes with a reduce-only Sell (Bybit), side=SELL positionSide=LONG (BingX / Binance)
    ['quick close — Bybit LONG → reduce-only Sell', 'qc half bybit',
      (s) => s.requests.some((r) => r.url.endsWith('/order/create') && r.body.includes('"side": "Sell"') && r.body.includes('"reduceOnly": true'))],
    ['… BingX LONG → side=SELL positionSide=LONG', 'qc half bingx',
      (s) => s.requests.some((r) => r.method === 'POST' && r.url.includes('positionSide=LONG') && r.url.includes('side=SELL'))],
    ['… Binance LONG → side=SELL positionSide=LONG', 'qc half binance',
      (s) => s.requests.some((r) => r.method === 'POST' && r.url.includes('side=SELL&positionSide=LONG'))],
    ['… a trade without LONG / SHORT is refused before any request', 'qc half direction empty → refused before any request',
      (s) => sends(s)[0] === 'Направление сделки неизвестно' && s.requests.length === 0],
    ['… hedge: the size is the trade direction\'s position, not the first one', 'qc half bybit hedge → the LONG\'s size, not the first position',
      (s) => s.requests.some((r) => r.url.endsWith('/order/create') && r.body.includes('"qty": "0.006"') && r.body.includes('"side": "Sell"'))],
    ['… OKX 50 % → a market order of the opposite side on the same posSide', 'qc half okx → partial market order (QC-SIDE-FIX)',
      (s) => sends(s)[0].startsWith('✅ Закрыта половина') && s.requests.some((r) => r.url.endsWith('/api/v5/trade/order')
        && r.body.includes('"side": "sell"') && r.body.includes('"posSide": "long"') && r.body.includes('"ordType": "market"'))],
    ['… OKX 50 % below one lot sends nothing', 'qc half okx below one lot → nothing sent',
      (s) => s.requests.every((r) => r.method === 'GET')],
    // [OKX-CLOSE-CLEANUP 2026-10]: a failed close keeps the SL / TP while the position may be alive
    ['OKX: a failed close with the position alive cancels nothing', 'qc full okx LONG failed close → SL/TP kept',
      (s) => s.requests.some((r) => r.url.endsWith('/close-position') && r.body.includes('"posSide": "long"'))
        && !s.requests.some((r) => /cancel-(order|algos)$/.test(r.url))],
    ['… a failed close with the position gone removes the leftovers', 'qc full okx LONG failed close, position gone → leftovers cancelled',
      (s) => s.requests.some((r) => r.url.endsWith('/cancel-algos'))],
    ['… a closed LONG with a live hedge SHORT cancels only the long side', 'qc full okx LONG closed, hedge SHORT alive → only the long side\'s orders go',
      (s) => s.requests.some((r) => r.url.endsWith('/cancel-algos') && r.body.includes('sl-long') && !r.body.includes('sl-short'))
        && s.requests.filter((r) => r.url.endsWith('/cancel-order')).every((r) => r.body.includes('"9"'))],
    ['quick close: a timed-out position read is "already closed"', 'qc half positions timeout', (s) => sends(s)[0] === 'Позиция уже закрыта'],
    ['hold-lock lets the close through when the cache has no price (fail-open)', 'qc full hold-lock, no cache price → closes (fail-open)',
      (s) => sends(s)[0] === '✅ Позиция закрыта полностью'],
    ['hold_lock_min_rr 0 → 0.5 (`or 0.5`)', 'qc full hold-lock min 0 → 0.5', (s) => answers(s)[0].endsWith('min для закрытия = 0.50R')],
    ['the hold-lock dialog offers force / wait', 'qc full hold-lock dialog',
      (s) => JSON.stringify(s.effects[1].keyboard) === JSON.stringify([[{ text: '❌ Всё равно закрыть', callback_data: 'qc_full_force_qc-hold' }, { text: '✅ Подождать', callback_data: 'qc_holdlock_wait' }]])],
    ['progress is shown for a closed trade too', 'progress pr-closed', (s) => sends(s)[0].startsWith('📊 <b>BTC LONG</b> — прогресс')],
    ['progress without SL / TP: R 0, distances 0', 'progress pr-nosl', (s) => sends(s)[0].includes('PnL: +0.00R') && sends(s)[0].includes('SL: <code>0</code>')],
    ['keys: can() reads sub_plan only — an expired Pro may connect keys', 'keys expired pro (can() reads sub_plan only)', (s) => JSON.parse(s.text).ok === true],
    ['keys: OKX test_connection says ok (balance 0.0) for keys the balance call rejects', 'keys okx test fails',
      (s) => s.text === '{"ok": true, "exchange": "okx", "key_hint": "OKKE\\u202667", "balance_usdt": 0.0}'],
    ['keys remove keeps trade_exchange (only auto_trade goes off)', 'remove 217 {"exchange": "bingx"}',
      (s) => s.user_after.trade_exchange === 'bingx' && s.user_after.auto_trade === false && s.user_after.bingx_api_key === ''],
    ['… and auto_trade stays on when the removed exchange is not trade_exchange', 'remove 223 {"exchange": "bybit"}',
      (s) => s.user_after.auto_trade === true && s.user_after.bybit_api_key === ''],
    ['positions: an unknown trade_exchange reads Bybit', 'positions invalid exchange → bybit', (s) => JSON.parse(s.text).exchange === 'bybit'],
    ['the confirm button says Bybit for every exchange', null, () => FX.i18n.signal_open_trade_btn.ru === '✅ Открыть сделку на Bybit'],
  ];
  for (const [quirk, step, holds] of QUIRKS) {
    it(quirk, () => {
      const s = step === null ? null : S[step];
      if (step !== null) expect(s, step).toBeTruthy();
      expect(holds(s)).toBe(true);
    });
  }

  it('progress: the sign follows R, so a loss without a stop reads "+-1.50%"', () => {
    const text = QC.formatProgressText({ symbol: 'BTC-USDT-SWAP', direction: 'LONG', entry: 100, sl: 0, tp1: 0 },
      { price: 98.5, pnl_pct: -1.5, pnl_r: 0.0, dist_to_tp1_pct: 0.0, dist_to_sl_pct: 0.0, minutes_open: 61 });
    expect(text.split('\n')[3]).toBe('💹 Сейчас: <code>98.5</code> (+-1.50%)');
    expect(text.split('\n')[4]).toBe('🟠 <b>PnL: +0.00R</b> (+-1.50%)');
    expect(text.split('\n')[9]).toBe('⏱ Открыто 1ч 1мин назад');
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('the bot\'s texts and numbers', () => {
  it('i18n.py texts of exec_trade (fixture i18n)', () => {
    expect(CM.MESSAGES).toEqual(FX.i18n);
  });
  it('miniapp constants: buckets, exchanges', () => {
    expect(appTrade.KEYS_RATE_LIMIT).toEqual(FX.miniapp.keys_rate);
    expect(appTrade.POSITIONS_RATE_LIMIT).toEqual(FX.miniapp.positions_rate);
    expect(nodeRequire('../../../services/exchangeKeysService.js').EXCHANGES).toEqual(FX.miniapp.exchanges);
  });
  it('unpack3: CPython\'s unpack errors', () => {
    expect(appTrade.unpack3([1, 2, 3])).toEqual([1, 2, 3]);
    expect(() => appTrade.unpack3([1, 2])).toThrow('not enough values to unpack (expected 3, got 2)');
    expect(() => appTrade.unpack3([1, 2, 3, 4])).toThrow('too many values to unpack (expected 3)');
    expect(() => appTrade.unpack3(null)).toThrow('cannot unpack non-iterable NoneType object');
    expect(() => appTrade.unpack3(5)).toThrow('cannot unpack non-iterable int object');
    expect(() => appTrade.unpack3({ a: 1, b: 2 })).toThrow('not enough values to unpack (expected 3, got 2)');
  });
  it('position(): _build_positions_text normalisation', () => {
    expect(appTrade.position({ symbol: '1000PEPEUSDT', side: 'Sell', avgPrice: '0.00391', markPrice: '0.00401', unrealisedPnl: '-34.09', leverage: '5', size: '3409000' }, 'bybit'))
      .toEqual({ exchange: 'bybit', symbol: '1000PEPE', side: 'SHORT', size: 3409000, entry: 0.00391, mark: 0.00401, pnl_usd: -34.09, pnl_pct: -12.79, leverage: 5 });
    expect(appTrade.position({ symbol: 'ADA-USDT', side: 'long', entryPrice: '0.5', leverage: 'x', positionAmt: '-10' }, 'bingx'))
      .toEqual({ exchange: 'bingx', symbol: 'ADA', side: 'LONG', size: 10, entry: 0.5, mark: 0, pnl_usd: 0, pnl_pct: -100, leverage: 1 });
    expect(() => appTrade.position({ symbol: 'X', avgPrice: 'abc' }, 'bybit')).toThrow();
    expect(() => appTrade.position({ symbol: 'X', leverage: 'inf' }, 'bybit')).toThrow(/OverflowError|cannot convert float infinity/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('locks', () => {
  it('exec_trade: a second press while the first runs → the locked alert (RU), nothing else', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const deps = {
      db, log: makeLog(), checkAccess: () => [true, ''], keysOf: () => ['', '', ''],
      userLock: () => ({ run: async (fn) => { await gate; return fn(); } }),
    };
    const user = { user_id: UID, lang: 'en', trade_exchange: 'bybit' };
    const first = CM.execTrade(user, 'lock-1', deps);
    const second = await CM.execTrade(user, 'lock-1', deps);
    expect(second).toEqual({ outcome: 'locked', effects: [{ op: 'answer', text: '⏳ Сделка уже открывается, подожди...', show_alert: true }], result: null });
    expect((await CM.execTrade(user, 'lock-2', { ...deps, userLock: null })).outcome).toBe('api_not_setup');   // another trade is not locked
    release();
    expect((await first).outcome).toBe('api_not_setup');
    expect(CM._execTradeLocks.size).toBe(0);
    expect((await CM.execTrade(user, 'lock-1', { ...deps, userLock: null })).outcome).toBe('api_not_setup');   // released
  });

  it('per-user lock: FIFO, one at a time, per user, released on errors, idle locks dropped', async () => {
    const L = W.createUserLocks();
    const order = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    const a = L.lockFor(1).run(async () => { order.push('a+'); await gate; order.push('a-'); return 'A'; });
    const b = L.lockFor(1).run(async () => { order.push('b'); throw new Error('boom'); });
    const c = L.lockFor(1).run(async () => { order.push('c'); return 'C'; });
    const other = L.lockFor(2).run(async () => { order.push('other'); return 'O'; });
    expect(await other).toBe('O');
    expect(L.lockFor(1).locked()).toBe(true);
    expect(order).toEqual(['a+', 'other']);
    release();
    expect(await a).toBe('A');
    await expect(b).rejects.toThrow('boom');
    expect(await c).toBe('C');
    expect(order).toEqual(['a+', 'other', 'a-', 'b', 'c']);
    expect(L.size()).toBe(0);
    expect(L.lockFor(1).locked()).toBe(false);
  });

  it('every money action runs under the user lock; the hold-lock wait answer does not need it', async () => {
    const seen = [];
    const deps = {
      db, log: makeLog(), keysOf: () => ['', '', ''], checkAccess: () => [true, ''],
      userLock: (uid) => ({ run: (fn) => { seen.push(uid); return fn(); } }),
    };
    const user = { user_id: UID, lang: 'ru', trade_exchange: 'bybit' };
    for (const fn of [QC.cbQcHalf, QC.cbQcFull, QC.cbQcFullForce, QC.cbQcBe]) await fn(user, 'u-qc', deps);
    await CM.execTrade(user, 'u-exec', deps);
    expect(seen).toEqual([UID, UID, UID, UID, UID]);
    expect((await QC.cbHoldlockWait(user, 'u-qc', deps)).outcome).toBe('wait');
    expect(seen.length).toBe(5);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('the trade-ops queue', () => {
  it('in-process: unknown kinds refused, drain stops new jobs (unavailable)', async () => {
    const ops = W.createTradeOps({ log: makeLog(), resetAuthFailures: async () => {} });
    await expect(ops.submit('nope', {})).rejects.toThrow('unknown job kind');
    expect(await ops.submit('qc', { userId: UID, tradeId: 'u-qc', action: 'wait', applyEffects: false }))
      .toEqual({ outcome: 'wait', effects: [{ op: 'answer', text: '✅ Хорошо. Дождись TP1 или SL.', show_alert: true }], result: null, res: null });
    await expect(ops.submit('qc', { userId: UID, tradeId: 'u-qc', action: 'sell-everything' })).rejects.toThrow('unknown quick-close action');
    expect(await ops.drain(1000)).toBe(0);
    await expect(ops.submit('qc', { userId: UID, tradeId: 'u-qc', action: 'wait' })).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('worker half over a MessageChannel: heartbeat, job → job-result, ping → pong, shutdown → stopped', async () => {
    const { port1, port2 } = new MessageChannel();
    const got = [];
    const resets = [];
    const waitFor = (pred) => new Promise((resolve) => {
      const tick = () => { const m = got.find(pred); if (m) resolve(m); else setTimeout(tick, 5); };
      tick();
    });
    port2.on('message', (m) => got.push(m));
    let exited = null;
    const w = W.runWorker(port1, { deps: { log: makeLog(), resetAuthFailures: async (u, e) => { resets.push([u, e]); } }, heartbeatMs: 20, exit: (c) => { exited = c; } });
    expect((await waitFor((m) => m.type === 'heartbeat')).running).toBe(0);
    port2.postMessage({ type: 'job', id: 7, kind: 'qc', payload: { userId: UID, tradeId: 'u-qc', action: 'wait' } });
    const r = await waitFor((m) => m.type === 'job-result' && m.id === 7);
    expect(r.ok).toBe(true);
    expect(r.result.outcome).toBe('wait');
    port2.postMessage({ type: 'job', id: 8, kind: 'reset_auth_failures', payload: { userId: UID, exchange: 'okx' } });
    expect((await waitFor((m) => m.type === 'job-result' && m.id === 8)).ok).toBe(true);
    expect(resets).toEqual([[UID, 'okx']]);
    port2.postMessage({ type: 'job', id: 9, kind: 'bogus', payload: {} });
    expect(await waitFor((m) => m.type === 'job-result' && m.id === 9)).toMatchObject({ ok: false, error: 'unknown job kind: bogus' });
    port2.postMessage({ type: 'ping', id: 3 });
    expect((await waitFor((m) => m.type === 'pong')).id).toBe(3);
    expect(got.filter((m) => m.type === 'heartbeat').length).toBeGreaterThanOrEqual(1);
    port2.postMessage({ type: 'shutdown' });
    expect((await waitFor((m) => m.type === 'stopped')).running).toBe(0);
    expect(exited).toBe(0);
    w.stop();
    port1.close();
    port2.close();
  });

  it('supervisor: forwards jobs, a dead worker fails its jobs with worker_lost and restarts after 10 s doubling; silence → terminate', async () => {
    const workers = [];
    const spawn = () => {
      const w = new EventEmitter();
      w.posted = [];
      w.postMessage = (m) => w.posted.push(m);
      w.terminate = () => { w.terminated = true; w.emit('exit', 1); return Promise.resolve(); };
      workers.push(w);
      return w;
    };
    const t = 1000;
    const L = makeLog();
    const sup = W.createSupervisor({ spawn, log: L, delivery: { handleWorkerMessage: () => false }, now: () => t, heartbeatTimeoutMs: 120_000, watchdogEveryMs: 10 });
    sup.start();
    expect(workers.length).toBe(1);
    const j1 = sup.submit('exec', { userId: UID, tradeId: 'x' });
    expect(workers[0].posted[0]).toMatchObject({ type: 'job', kind: 'exec', payload: { userId: UID, tradeId: 'x' } });
    workers[0].emit('message', { type: 'job-result', id: workers[0].posted[0].id, ok: true, result: { outcome: 'opened' } });
    expect(await j1).toEqual({ outcome: 'opened' });
    const j2 = sup.submit('qc', { userId: UID, tradeId: 'x', action: 'half' });
    workers[0].emit('exit', 1);
    await expect(j2).rejects.toMatchObject({ code: 'worker_lost' });
    expect(L.lines.some((l) => l.includes('worker exited — restart in 10s'))).toBe(true);
    expect(sup.state.delay).toBe(20);
    await expect(sup.submit('qc', {})).rejects.toMatchObject({ code: 'unavailable' });     // no worker until the restart
    expect(sup.state.restartTimer).toBeTruthy();
    await sup.stop();                                                                       // stop cancels the pending restart
    expect(sup.state.restartTimer).toBeTruthy();
    expect(workers.length).toBe(1);
  });

  it('a real worker thread: heartbeat, a job through its own DB connection, clean shutdown', async () => {
    const L = makeLog();
    const sup = W.createSupervisor({ log: L, delivery: { handleWorkerMessage: () => false } });
    sup.start();
    try {
      const r = await sup.submit('qc', { userId: UID, tradeId: 'u-qc', action: 'wait' });
      expect(r).toEqual({ outcome: 'wait', effects: [{ op: 'answer', text: '✅ Хорошо. Дождись TP1 или SL.', show_alert: true }], result: null, res: null });
      expect(sup.state.lastBeat).toBeGreaterThan(0);
      await expect(sup.submit('bogus', {})).rejects.toThrow('unknown job kind: bogus');
    } finally {
      expect(await sup.stop({ graceMs: 20_000 })).toEqual({ stopped: true });
    }
    expect(L.lines.filter((l) => l.startsWith('ERROR'))).toEqual([]);
  }, 30_000);

  it('supervisor watchdog: no heartbeat for 120 s → the worker is terminated', async () => {
    const workers = [];
    const spawn = () => {
      const w = new EventEmitter();
      w.postMessage = () => {};
      w.terminate = () => { w.terminated = true; return Promise.resolve(); };
      workers.push(w);
      return w;
    };
    let t = 1000;
    const L = makeLog();
    const sup = W.createSupervisor({ spawn, log: L, delivery: { handleWorkerMessage: () => false }, now: () => t, heartbeatTimeoutMs: 120_000, watchdogEveryMs: 5 });
    sup.start();
    workers[0].emit('message', { type: 'heartbeat', ts: t });
    t += 60;
    await new Promise((r) => setTimeout(r, 20));
    expect(workers[0].terminated).toBeUndefined();
    t += 61;
    await new Promise((r) => setTimeout(r, 20));
    expect(workers[0].terminated).toBe(true);
    expect(L.lines.some((l) => l.includes('no heartbeat'))).toBe(true);
    sup.state.stopping = true;
    clearInterval(sup.state.watchdog);
  });

  it('the route: a placement past EXEC_WAIT_S answers pending (the job goes on); a lost worker answers unavailable', async () => {
    let finish;
    const job = new Promise((r) => { finish = r; });
    appTrade.configure({ tradeOps: { submit: () => job }, execWaitS: 0.05, log: makeLog() });
    let r = await rawRequest(port, { method: 'POST', target: '/api/app/trades/u-exec/exec', headers: auth(), body: '{}' });
    expect([r.status, r.text]).toEqual([200, '{"ok": true, "pending": true}']);
    finish({ outcome: 'opened', effects: [] });
    appTrade.configure({ tradeOps: { submit: () => Promise.reject(Object.assign(new Error('lost'), { code: 'worker_lost' })) }, execWaitS: 5 });
    r = await rawRequest(port, { method: 'POST', target: '/api/app/trades/u-exec/exec', headers: auth(), body: '{}' });
    expect([r.status, r.text]).toEqual([200, '{"ok": false, "error": "unavailable"}']);
    appTrade.configure({ tradeOps: null, execWaitS: null, log: null });
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('D16 and the routes', () => {
  it('cardOffers: only a callback button of the delivered card counts', () => {
    const row = (actions) => ({ signal_card_json: JSON.stringify({ html: 'x', actions, lang: 'ru' }) });
    expect(CM.cardOffers(row([[{ kind: 'callback', action: 'exec_trade_t1' }]]), 'exec_trade_t1')).toBe(true);
    expect(CM.cardOffers(row([[{ kind: 'url', action: 'exec_trade_t1' }]]), 'exec_trade_t1')).toBe(false);
    expect(CM.cardOffers(row(null), 'exec_trade_t1')).toBe(false);
    expect(CM.cardOffers(row([[{ kind: 'callback', action: 'exec_trade_t10' }]]), 'exec_trade_t1')).toBe(false);
    expect(CM.cardOffers({ signal_card_json: '{bad' }, 'exec_trade_t1')).toBe(false);
    expect(CM.cardOffers({ signal_card_json: '' }, 'exec_trade_t1')).toBe(false);
    expect(CM.cardOffers(null, 'exec_trade_t1')).toBe(false);
  });

  it('404 before any work: foreign trade, card without the button, missing / hostile ids; the submit is never reached', async () => {
    const calls = [];
    appTrade.configure({ tradeOps: { submit: (k, p) => { calls.push([k, p]); return Promise.resolve({ outcome: 'x', effects: [] }); } } });
    const NF = '{"ok": false, "error": "not_found"}';
    for (const [m, p] of [['POST', 'u-foreign/exec'], ['POST', 'u-plain/exec'], ['POST', 'u-qc/exec'], ['POST', 'u-exec/qc/half'], ['POST', 'u-exec/qc/full'],
      ['POST', 'u-exec/qc/force'], ['POST', 'u-exec/qc/be'], ['POST', 'nope/exec'], ['POST', '..%2Fu-exec/exec'], ['POST', 'u-exec%00/exec'],
      ['GET', 'u-foreign/progress'], ['GET', 'nope/progress'], ['POST', "u-exec'%20OR%201=1--/exec"]]) {
      const r = await rawRequest(port, { method: m, target: `/api/app/trades/${p}`, headers: auth(), body: m === 'POST' ? '{}' : null });
      expect([p, r.status, r.text]).toEqual([p, 404, NF]);
    }
    expect(calls).toEqual([]);
    const r = await rawRequest(port, { method: 'POST', target: '/api/app/trades/u-qc/qc/half', headers: auth(), body: '{}' });
    expect(r.status).toBe(200);
    expect(calls).toEqual([['qc', { userId: UID, admin: false, tradeId: 'u-qc', action: 'half' }]]);
    appTrade.configure({ tradeOps: null });
  });

  it('405 + Allow for a known path with another method; 404 for near misses; 401 without a token', async () => {
    const cases = [
      ['GET', '/api/app/trades/u-exec/exec', 405, 'POST'], ['DELETE', '/api/app/trades/u-exec/qc/half', 405, 'POST'],
      ['POST', '/api/app/trades/u-exec/progress', 405, 'GET,HEAD'], ['GET', '/api/app/trades/u-exec/exec/', 404, undefined],
      ['GET', '/api/app/trades//progress', 404, undefined], ['POST', '/api/app/trades/u-exec/qc', 404, undefined],
      ['POST', '/api/app/trades/u-exec/QC/half', 404, undefined],
    ];
    for (const [m, p, st, allow] of cases) {
      const r = await rawRequest(port, { method: m, target: p, headers: auth(), body: m === 'POST' ? '{}' : null });
      expect([m, p, r.status, r.headers.allow]).toEqual([m, p, st, allow]);
      if (st === 405) expect(r.text).toBe('405: Method Not Allowed');
    }
    expect(appTrade.methods('/trades/abc/exec')).toEqual(['POST']);
    expect(appTrade.methods('/trades/abc/progress')).toEqual(['GET', 'HEAD']);
    expect(appTrade.methods('/trades/abc/qc/wait')).toEqual(['POST']);
    // yarl decodes %7B / %7D before aiohttp's `[^{}/]+` id match: never part of an id
    expect(appTrade.methods('/trades/a%7Bb/exec')).toEqual([]);
    expect(appTrade.methods('/trades/{x}/exec')).toEqual([]);
    expect(appTrade.methods('/trades/a%2Fb/progress')).toEqual(['GET', 'HEAD']);
    const r = await rawRequest(port, { method: 'POST', target: '/api/app/trades/u-exec/exec', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect([r.status, r.text]).toEqual([401, '{"ok": false, "error": "unauthorized"}']);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('applyEffects — the site\'s channels for what the callback did', () => {
  it('card snapshot without buttons + SSE card event; messages that stayed → trade notifications; a deleted one never', async () => {
    const fx = CM.createEffects();
    fx.edit('⏳ Открываю сделку...');
    fx.answer();
    const wait = fx.send('⏳ Выставляю ордер на Bybit...');
    wait.delete();
    fx.send('✅ <b>done</b>', { parseMode: 'HTML' });
    const dl = makeDelivery();
    await CM.applyEffects(fx.list, { userId: UID, tradeId: 'u-fx', lang: 'ru', delivery: dl, db, log: makeLog() });
    const card = db.prepare('SELECT signal_card_json c FROM signal_trades WHERE trade_id=?').get('u-fx').c;
    expect(card).toBe('{"html": "⏳ Открываю сделку...", "actions": null, "lang": "ru"}');
    expect(CM.cardOffers({ signal_card_json: card }, 'exec_trade_u-fx')).toBe(false);
    expect(dl.broadcasts).toEqual([{ uid: UID, event: 'trade', data: { kind: 'card', trade_id: 'u-fx', html: '⏳ Открываю сделку...', actions: null } }]);
    expect(dl.sent).toEqual([{ uid: UID, text: '✅ <b>done</b>', opts: { type: 'trade', kind: 'trade', link: '/app/?tab=signals&id=u-fx', keyboard: null, lang: 'ru', tradeId: 'u-fx' } }]);
    expect(CM.summarize(fx.list)).toEqual({ message: '✅ <b>done</b>', alert: null, card: '⏳ Открываю сделку...' });
  });

  it('never edits another user\'s card', async () => {
    const before = db.prepare('SELECT signal_card_json c FROM signal_trades WHERE trade_id=?').get('u-foreign').c;
    const fx = CM.createEffects();
    fx.edit('hijack');
    await CM.applyEffects(fx.list, { userId: UID, tradeId: 'u-foreign', delivery: makeDelivery(), db, log: makeLog() });
    expect(db.prepare('SELECT signal_card_json c FROM signal_trades WHERE trade_id=?').get('u-foreign').c).toBe(before);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('frontend/app/app.js call sites ↔ the routes', () => {
  const APP_JS = fs.readFileSync(path.join(process.cwd(), '..', 'frontend', 'app', 'app.js'), 'utf8');
  const keysSvc = () => nodeRequire('../../../services/exchangeKeysService.js');

  it('exchange/keys: POST {exchange, api_key, api_secret, passphrase?}, a timeout that covers the test (20 s) + the D15 read (8 s)', () => {
    const m = APP_JS.match(/api\("exchange\/keys", \{ method: "POST", body: body, timeout: (\d+) \}\)/);
    expect(m).toBeTruthy();
    expect(Number(m[1])).toBeGreaterThan((keysSvc().TEST_TIMEOUT_S + keysSvc().PERMISSION_TIMEOUT_S) * 1000);
    expect(APP_JS).toContain('var body = { exchange: e, api_key: k, api_secret: sc };');
    expect(APP_JS).toContain('if (p) body.passphrase = p;');
    // a refusal (D15 or invalid keys) shows the answer's message
    expect(APP_JS).toMatch(/if \(!d \|\| !d\.ok\) throw Object\.assign\(new ApiError\(\(d && d\.error\) \|\| "network"\), \{ msg: d && d\.message \}\);/);
    expect(appTrade.methods('/exchange/keys')).toEqual(['POST']);
  });

  it('exchange/keys/remove: POST {exchange}', () => {
    expect(APP_JS).toMatch(/api\("exchange\/keys\/remove", \{ method: "POST", body: \{ exchange: e \}, timeout: 15000 \}\)/);
    expect(appTrade.methods('/exchange/keys/remove')).toEqual(['POST']);
  });

  it('positions: GET; every field the position card reads is in the answer; the 8 s text matches DASHBOARD_TIMEOUT_S', () => {
    expect(APP_JS).toContain('secLoad("positions", "positions")');
    expect(appTrade.methods('/positions')).toEqual(['GET', 'HEAD']);
    const fn = APP_JS.slice(APP_JS.indexOf('function positionCard(p)'), APP_JS.indexOf('function secPositions(root)'));
    const fields = [...new Set([...fn.matchAll(/\bp\.([a-z_]+)/g)].map((x) => x[1]))].sort();
    const keys = Object.keys(appTrade.position({ symbol: 'BTCUSDT', side: 'Buy' }, 'bybit'));
    for (const f of fields) expect(keys, f).toContain(f);
    expect(fields).toEqual(['entry', 'exchange', 'leverage', 'mark', 'pnl_pct', 'pnl_usd', 'side', 'size', 'symbol']);
    expect(APP_JS).toContain(`Биржа не ответила за ${appTrade.DASHBOARD_TIMEOUT_S} секунд`);
    expect(APP_JS).toMatch(/num\(c\.data\.orders_count\)/);
  });

  it('trade buttons: GET trades/{id}/card, the button routes = signalDelivery ACTION_ROUTES, a timeout over EXEC_WAIT_S', () => {
    expect(APP_JS).toContain('api("trades/" + encodeURIComponent(sig.id) + "/card", { timeout: 15000 })');
    expect(appTrade.methods('/trades/x_1/card')).toEqual(['GET', 'HEAD']);
    const SDm = nodeRequire('../../../services/engine/signalDelivery.js');
    const block = APP_JS.slice(APP_JS.indexOf('var TRADE_ROUTES = ['), APP_JS.indexOf('function tradeRoute('));
    const spa = [...block.matchAll(/\[\/(.+?)\/, "(GET|POST)", "([a-z/]+)"\]/g)].map((m) => [m[1], m[2], m[3]]);
    expect(spa.length).toBe(6);
    const id = 'u1_vol_1_2';
    for (const [re, method, tail] of spa) {
      const action = re.replace('^', '').replace('(.+)$', id);
      expect(SDm.actionRoute(action), action).toEqual({ method, path: `trades/${id}/${tail}` });
      // and the route the press goes to exists with that method
      expect(appTrade.methods(`/trades/${id}/${tail}`)).toContain(method);
    }
    expect(APP_JS).toContain('if (a === "qc_holdlock_wait") return { method: "POST", path: "trades/" + encodeURIComponent(tradeId) + "/qc/wait" };');
    const t = Number(/var TRADE_TIMEOUT = (\d+);/.exec(APP_JS)[1]);
    expect(t).toBeGreaterThan(appTrade.EXEC_WAIT_S * 1000);
    // the press posts an empty JSON body (POST) and shows the bot's text as plain text, never as HTML
    expect(APP_JS).toContain('if (b.api.method === "POST") opt.body = {};');
    expect(APP_JS).toMatch(/h\("p", \{ class: "trade-answer" \+ \(answer\.err \? " err" : ""\), text: answer\.text \}\)/);
  });
});
