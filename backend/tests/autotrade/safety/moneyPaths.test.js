/**
 * Money paths — every code path of the site that can send, modify, cancel or close an order, each
 * one driven on the stateful fake exchanges (tests/autotrade/e2e/fakeExchanges.js: signatures checked,
 * orders matched, NO network) with injected network faults, proving at the wire level:
 *   idempotent under retry · timeout-after-accept · process restart / worker crash mid-flight ·
 *   double click / concurrent requests (per-user / per-trade locks) · fail-closed where the bot is ·
 *   never more than one position for one signal.
 *
 * The inventory (grep of every exchange-client call outside services/exchanges; see the
 * `MONEY_PATHS` table below — a test fails when a new call site appears that is not listed):
 *   A  auto-trade        services/autotrade/executeAutoTrade.js  placeTrade (2-attempt loop), placeTradeSplit
 *   A' auto background   partialTp.placePartialTpOrders, placeTpOrders / placeSlTpForPosition (fallback),
 *                        reconcile.limitUnfilledGuard → cancelAllOrders, timeout path → setTrailingSl (SL
 *                        fallback) + placePartialTpOrders + cancelPendingAfterTimeout → cancelAllOrders
 *   B  confirm exec      services/autotrade/confirmMode.js  placeTrade / placeTradeSplit (POST trades/{id}/exec)
 *   C  quick close       services/autotrade/quickClose.js  closePosition (qc half / full / force), setTrailingSl (qc be)
 *
 * Site decisions exercised here (docs/PORT_DECISIONS.md D18): the in-flight placement guard, no blind
 * OKX retry, a failed retry after a timeout reconciles instead of SKIP, the confirm card loses its
 * button before the order goes out, the engine lets a placement in flight finish on shutdown. Each one
 * also runs in bot mode, pinning what the bot does.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import request from 'supertest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safety-money-'));
process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(tmpDir, 'money.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';

const req = createRequire(import.meta.url);
const W = req('./world.js');

const BOT_D18 = { inflightGuard: false, reconcileFailedRetry: false };
// 1 % of 10 000 over a 1.95 stop; OKX in whole contracts ([OKX-LOT-CONTRACTS]: ctVal 0.01, lotSz 1 → 5128 contracts)
const QTY = { bybit: 51.282, bingx: 51.282, binance: 51.282, okx: 51.28 };
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
/** Let a call run (microtasks only — the virtual clock does not move) until `cond`. */
async function pumpUntil(cond, max = 3000) {
  for (let i = 0; i < max && !cond(); i++) await new Promise((r) => setImmediate(r));
  return cond();
}
const near = (a, b) => Math.abs(a - b) < 1e-6;

let w;
let uidSeq = 6000;
const newUser = (ex, settings = {}) => w.user(uidSeq++, ex, settings);
const hasSl = (u) => w.positions(u).some((p) => p.sl > 0) || w.orders(u).some((o) => o.type === 'STOP');
const longSize = (u) => w.positions(u).filter((p) => p.side === 'LONG').reduce((s, p) => s + p.size, 0);
const shortSize = (u) => w.positions(u).filter((p) => p.side === 'SHORT').reduce((s, p) => s + p.size, 0);

beforeAll(() => {
  w = W.createWorld({ duplicateClientIds: true });
});
afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* tmp */ }
});

// ═══════════════════════════════════════════════════════════════════════
describe('the inventory: every exchange-client call that can move money is a listed path', () => {
  it('no unlisted call site of an order-sending trader method outside services/exchanges', () => {
    const root = path.join(__dirname, '..', '..', '..');
    const files = [];
    const walk = (d) => {
      for (const n of fs.readdirSync(d)) {
        const p = path.join(d, n);
        if (['node_modules', 'tests', 'exchanges', 'logs', 'data'].includes(n) && fs.statSync(p).isDirectory()) continue;
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (n.endsWith('.js')) files.push(p);
      }
    };
    for (const d of ['services', 'routes', 'workers', 'server.js']) {
      const p = path.join(root, d);
      if (fs.statSync(p).isDirectory()) walk(p); else files.push(p);
    }
    const RE = /\.(placeTrade|placeTradeSplit|placeTpOrders|placeSlTpForPosition|setTrailingSl|setBreakeven|closePosition|cancelAllOrders|cancelOrder|cancelTpOrdersOnly|placePartialTpOrders|place_order|_request)\(/g;
    const found = new Set();
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(RE)) found.add(`${path.relative(root, f)}:${m[1]}`);
    }
    // path → what proves it (the describe blocks below)
    const MONEY_PATHS = {
      'services/autotrade/executeAutoTrade.js:placeTrade': 'A — auto entry (2-attempt loop)',
      'services/autotrade/executeAutoTrade.js:placeTradeSplit': 'A — SMC split entry (Bybit, no retry)',
      'services/autotrade/executeAutoTrade.js:placePartialTpOrders': "A' — partial TP after open / after a reconciled timeout",
      'services/autotrade/executeAutoTrade.js:placeTpOrders': "A' — main-TP fallback (Bybit)",
      'services/autotrade/executeAutoTrade.js:placeSlTpForPosition': "A' — main-TP fallback (BingX / Binance / OKX)",
      'services/autotrade/executeAutoTrade.js:setTrailingSl': "A' — SL of a reconciled position",
      'services/autotrade/reconcile.js:cancelAllOrders': "A' — LIMIT-unfilled guard / timeout without a position",
      'services/autotrade/partialTp.js:_request': "A' — partial-TP orders (BingX / Binance / OKX)",
      'services/autotrade/partialTp.js:place_order': "A' — partial-TP orders (Bybit)",
      'services/autotrade/confirmMode.js:placeTrade': 'B — confirm exec',
      'services/autotrade/confirmMode.js:placeTradeSplit': 'B — confirm exec, SMC split (Bybit)',
      'services/autotrade/quickClose.js:closePosition': 'C — quick close 50 % / 100 %',
      'services/autotrade/quickClose.js:setTrailingSl': 'C — SL → BE',
      // read-only uses of the generic request helper (not order paths)
      'services/autotrade/keyPermissions.js:_request': 'D15 — permission read (GET only)',
    };
    const unlisted = [...found].filter((k) => !Object.prototype.hasOwnProperty.call(MONEY_PATHS, k));
    expect(unlisted).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('A — auto-trade entry: idempotent under retry and timeout-after-accept, one position per signal', () => {
  for (const ex of W.EXCHANGES) {
    it(`${ex}: a plain signal opens exactly one position with its stop`, async () => {
      const at = w.autoTrade();
      const u = newUser(ex);
      const r = w.signal(u);
      const res = await w.run(at.executeAutoTrade(w.kw(u, r)));
      await w.run(at.drain());
      expect(res.executed).toBe(true);
      expect(w.entries(u).length).toBe(1);
      expect(near(longSize(u), QTY[ex])).toBe(true);
      expect(near(w.maxLong(u), QTY[ex])).toBe(true);
      expect(hasSl(u)).toBe(true);
      const row = w.row(r.trade_id);
      expect(row.result).toBe('');
      expect(row.state).toBe('OPEN');
      expect(row.order_id).not.toBe('');
      expect(row.exchange).toBe(ex);    // D17
    });

    it(`${ex}: timeout-after-accept — the exchange took the entry, the answer was lost → recorded once, never re-sent`, async () => {
      const at = w.autoTrade();
      const u = newUser(ex);
      const r = w.signal(u);
      w.faults.add({ on: 'entry', kind: 'lost-after', key: u.key });
      await w.run(at.executeAutoTrade(w.kw(u, r)));
      await w.run(at.drain());
      expect(w.entriesSent(u).length).toBe(1);               // the C78 double-check found it: no second send
      expect(near(w.maxLong(u), QTY[ex])).toBe(true);
      expect(near(longSize(u), QTY[ex])).toBe(true);
      expect(hasSl(u)).toBe(true);                           // attached, or the [TIMEOUT-RECONCILE-SL] fallback
      const row = w.row(r.trade_id);
      expect(row.result).toBe('');
      expect(row.order_id).not.toBe('');
      expect(row.qty).toBeGreaterThan(0);
      expect(row.state).toBe('PLACING');                     // bot quirk 11: a reconciled timeout stays PLACING
      expect(w.msgs.some((m) => m.uid === u.uid && m.text.includes('биржа отвечала с задержкой'))).toBe(true);
    });

    it(`${ex}: the entry never reached the exchange (dead link) → ${ex === 'okx' ? 'no blind OKX retry ([OKX-NO-BLIND-RETRY]) — reconciled, nothing placed' : 'one retry after 5 s places it once'}`, async () => {
      const at = w.autoTrade();
      const u = newUser(ex);
      const r = w.signal(u);
      w.faults.add({ on: 'entry', kind: 'lost-before', key: u.key });
      await w.run(at.executeAutoTrade(w.kw(u, r)));
      await w.run(at.drain());
      const row = w.row(r.trade_id);
      if (ex === 'okx') {
        expect(w.entries(u).length).toBe(0);
        expect(longSize(u)).toBe(0);
        expect(row.result).toBe('SKIP');
        expect(w.logs.some((l) => l.includes('[OKX-NO-BLIND-RETRY]'))).toBe(true);
      } else {
        expect(w.entries(u).length).toBe(1);
        expect(near(longSize(u), QTY[ex])).toBe(true);
        expect(row.result).toBe('');
        expect(row.order_id).not.toBe('');
      }
    });

    it(`${ex}: timeout-after-accept while the double-check cannot read the exchange → still one position, tracked`, async () => {
      const at = w.autoTrade();
      const u = newUser(ex);
      const r = w.signal(u);
      w.faults.add({ on: 'entry', kind: 'lost-after', key: u.key });
      // the C78 reads (positions, open orders) fail; every trader answers a failed read with "nothing"
      w.faults.add({ on: 'read', kind: 'reset-after', key: u.key, afterEntry: true, times: 2 });
      await w.run(at.executeAutoTrade(w.kw(u, r)));
      await w.run(at.drain());
      expect(near(w.maxLong(u), QTY[ex])).toBe(true);        // never doubled
      expect(near(longSize(u), QTY[ex])).toBe(true);
      expect(w.opens(u)).toBe(1);
      const row = w.row(r.trade_id);
      expect(row.result).toBe('');                            // tracked: the BE monitor / reconcile own it
      expect(row.order_id).not.toBe('');
      expect(hasSl(u)).toBe(true);
    });
  }

  it('bot mode pins (D18 off): OKX — one entry, found by clOrdId ([OKX-ENTRY-TIMEOUT], it used to re-send blindly); Binance -4116 → the row is SKIP while the position lives', async () => {
    const at = w.autoTrade({ d18: BOT_D18 });
    // OKX: the bot itself (2026-10) sends the entry with a clOrdId and looks it up after a lost answer —
    // no second entry, the position is recorded
    const uo = newUser('okx');
    const ro = w.signal(uo);
    w.faults.add({ on: 'entry', kind: 'lost-after', key: uo.key });
    w.faults.add({ on: 'read', kind: 'reset-after', key: uo.key, afterEntry: true, times: 2 });
    await w.run(at.executeAutoTrade(w.kw(uo, ro)));
    await w.run(at.drain());
    expect(w.entriesSent(uo).length).toBe(1);
    expect(near(longSize(uo), QTY.okx)).toBe(true);
    expect(w.row(ro.trade_id).order_id).not.toBe('');
    // Binance: the retry carries the same newClientOrderId, the exchange answers -4116 (duplicate),
    // the bot reads only -4015 as a duplicate → ok:false → SKIP, the first position stays untracked
    const ub = newUser('binance');
    const rb = w.signal(ub);
    w.faults.add({ on: 'entry', kind: 'lost-after', key: ub.key });
    w.faults.add({ on: 'read', kind: 'reset-after', key: ub.key, afterEntry: true, times: 2 });
    await w.run(at.executeAutoTrade(w.kw(ub, rb)));
    await w.run(at.drain());
    expect(near(longSize(ub), QTY.binance)).toBe(true);
    expect(w.row(rb.trade_id).result).toBe('SKIP');
    expect(w.row(rb.trade_id).order_id).toBe('');
    // BingX: the duplicate retry is read as "the first attempt worked" — the row is OPEN, but the first
    // attempt never reached its SL step: the position has NO stop (the bot's BE monitor adds one later)
    const ux = newUser('bingx');
    const rx = w.signal(ux);
    w.faults.add({ on: 'entry', kind: 'lost-after', key: ux.key });
    w.faults.add({ on: 'read', kind: 'reset-after', key: ux.key, afterEntry: true, times: 2 });
    await w.run(at.executeAutoTrade(w.kw(ux, rx)));
    await w.run(at.drain());
    expect(near(longSize(ux), QTY.bingx)).toBe(true);
    expect(w.row(rx.trade_id).state).toBe('OPEN');
    expect(hasSl(ux)).toBe(false);
  });

  it('D18 reconcile of a failed retry: Binance -4116 → the live position is recorded with its stop, not SKIPped', async () => {
    const at = w.autoTrade();
    const u = newUser('binance');
    const r = w.signal(u);
    w.faults.add({ on: 'entry', kind: 'lost-after', key: u.key });
    w.faults.add({ on: 'read', kind: 'reset-after', key: u.key, afterEntry: true, times: 2 });
    await w.run(at.executeAutoTrade(w.kw(u, r)));
    await w.run(at.drain());
    expect(w.logs.some((l) => l.includes('[D18-RETRY-RECONCILE]'))).toBe(true);
    const row = w.row(r.trade_id);
    expect(row.result).toBe('');
    expect(row.order_id).not.toBe('');
    expect(near(row.qty, QTY.binance)).toBe(true);
    expect(hasSl(u)).toBe(true);
  });

  it('a failed retry with nothing on the exchange → pending orders cancelled, SKIP (fail-closed), no position', async () => {
    const at = w.autoTrade();
    const u = newUser('bybit');
    const r = w.signal(u);
    w.faults.add({ on: 'entry', kind: 'lost-before', key: u.key });
    // the retry is answered with an error by the exchange
    w.faults.add({ on: (p) => p.path === '/v5/order/create', kind: 'connect-error', key: u.key, afterEntry: true, times: 4 });
    await w.run(at.executeAutoTrade(w.kw(u, r)));
    await w.run(at.drain());
    expect(longSize(u)).toBe(0);
    expect(w.orders(u).length).toBe(0);
    expect(w.row(r.trade_id).result).toBe('SKIP');
  });

  it('per-user lock: two signals of one user on one symbol at the same moment (LEVELS + SMC) → one position, the second SKIPped as duplicate', async () => {
    for (const ex of W.EXCHANGES) {
      const at = w.autoTrade();
      const u = newUser(ex);
      const r1 = w.signal(u, { strategy: 'LEVELS' });
      const r2 = w.signal(u, { strategy: 'SMC', breakout_type: 'SMC' });
      const [a, b] = await w.run(Promise.all([at.executeAutoTrade(w.kw(u, r1)), at.executeAutoTrade(w.kw(u, r2, { strategy: 'SMC' }))]));
      await w.run(at.drain());
      expect([a.executed, b.executed].filter(Boolean).length, ex).toBe(1);
      expect(w.entries(u).length, ex).toBe(1);
      expect(near(w.maxLong(u), QTY[ex]), ex).toBe(true);
      expect(w.row(r2.trade_id).result, ex).toBe('SKIP');
      expect(w.row(r2.trade_id).skip_reason, ex).toBe('auto_trade.py:1060');
    }
  });

  it('the same signal delivered twice (one trade_id, two calls) never places twice and keeps its row (D18; the bot SKIPs its own live row)', async () => {
    for (const [d18, rowResult] of [[undefined, ''], [BOT_D18, 'SKIP']]) {
      const at = w.autoTrade({ d18 });
      const u = newUser('bybit');
      const r = w.signal(u);
      await w.run(Promise.all([at.executeAutoTrade(w.kw(u, r)), at.executeAutoTrade(w.kw(u, r))]));
      await w.run(at.drain());
      expect(w.entries(u).length).toBe(1);
      expect(near(w.maxLong(u), QTY.bybit)).toBe(true);
      expect(w.row(r.trade_id).result, d18 ? 'bot' : 'site').toBe(rowResult);
      expect(w.row(r.trade_id).order_id).not.toBe('');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('A — process restart / engine worker crash mid-placement (D18 in-flight guard)', () => {
  /** Start a placement whose entry the exchange accepts but never answers, and let the process "die". */
  async function crashMidFlight(ex, d18) {
    // the doomed process has its own clock that never moves again: its wait_for never fires
    const at = w.autoTrade({ d18, clock: W.createVClock(w.clk.now()) });
    const u = newUser(ex);
    const r = w.signal(u);
    w.faults.add({ on: 'entry', kind: 'lost-after', key: u.key });
    at.executeAutoTrade(w.kw(u, r)).catch(() => {});        // never awaited: the process dies here
    expect(await pumpUntil(() => w.entriesSent(u).length === 1)).toBe(true);
    await settle();
    return { u, r };
  }

  for (const ex of W.EXCHANGES) {
    it(`${ex}: after the restart nothing re-places the in-flight trade, and a re-detected signal does not open a second position`, async () => {
      const { u, r } = await crashMidFlight(ex);
      expect(w.row(r.trade_id).state).toBe('PLACING');
      expect(w.row(r.trade_id).order_id).toBe('');
      expect(near(longSize(u), QTY[ex])).toBe(true);        // the order IS on the exchange
      // the restarted engine: a fresh executor over the same DB (bot.py start-up restore)
      const before = w.allReqs(u).length;
      const at2 = w.autoTrade();
      await w.run(at2.restore());
      expect(w.allReqs(u).length).toBe(before);              // the restore never talks to the exchange
      // the scanner sees the same setup again → a new signal row for the same symbol
      const r2 = w.signal(u);
      const res = await w.run(at2.executeAutoTrade(w.kw(u, r2)));
      await w.run(at2.drain());
      expect(res.executed).toBe(false);
      expect(w.row(r2.trade_id).result).toBe('SKIP');
      expect(w.row(r2.trade_id).skip_reason).toBe('d18_inflight_placement');
      expect(w.entriesSent(u).length).toBe(1);
      expect(near(w.maxLong(u), QTY[ex])).toBe(true);
      expect(w.logs.some((l) => l.includes('[D18-INFLIGHT]'))).toBe(true);
    });
  }

  it('bot mode pins (D18 off): the re-detected signal opens a SECOND position over the in-flight one', async () => {
    const { u } = await crashMidFlight('bybit', BOT_D18);
    const at2 = w.autoTrade({ d18: BOT_D18 });
    const r2 = w.signal(u);
    await w.run(at2.executeAutoTrade(w.kw(u, r2)));
    await w.run(at2.drain());
    expect(w.entriesSent(u).length).toBe(2);
    expect(near(longSize(u), 2 * QTY.bybit)).toBe(true);
  });

  it('the guard is bounded by the bot\'s 30-min PLACING horizon (_STUCK_PLACING_MAX_AGE_S) and ignores other symbols / users', async () => {
    const { u, r } = await crashMidFlight('bingx');
    const tdb = w.autoTrade()._parts.tdb;
    const t = w.clk.now();
    expect(await tdb.inflightPlacementForSymbol(u.uid, W.SYM, t - 1800, 'other')).toBe(r.trade_id);
    expect(await tdb.inflightPlacementForSymbol(u.uid, W.SYM, t - 1800, r.trade_id)).toBe(null);      // itself
    expect(await tdb.inflightPlacementForSymbol(u.uid, 'OTHER-USDT-SWAP', t - 1800, '')).toBe(null);
    expect(await tdb.inflightPlacementForSymbol(u.uid + 1000, W.SYM, t - 1800, '')).toBe(null);
    expect(await tdb.inflightPlacementForSymbol(u.uid, W.SYM, t + 1, '')).toBe(null);                 // older than the horizon
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('A — graceful engine stop: a placement in flight finishes, none starts (D18)', () => {
  it('beginShutdown during a placement: it completes (one position, OPEN); a new auto signal is SKIPped without an order', async () => {
    const at = w.autoTrade();
    const u = newUser('bybit');
    const r = w.signal(u);
    const slow = w.faults.add({ on: 'entry', kind: 'hold', key: u.key });
    const p = at.executeAutoTrade(w.kw(u, r));
    expect(await pumpUntil(() => slow.hits === 1)).toBe(true);   // the entry is on its way
    expect(at.inflight()).toBe(1);
    at.beginShutdown();
    const idle = at.waitIdle(5000);
    slow.release();
    await w.run(p);
    expect(await idle).toBe(0);
    expect(w.row(r.trade_id).state).toBe('OPEN');
    expect(near(longSize(u), QTY.bybit)).toBe(true);
    const u2 = newUser('bybit');
    const r2 = w.signal(u2);
    await w.run(at.executeAutoTrade(w.kw(u2, r2)));
    expect(w.orderReqs(u2)).toEqual([]);
    expect(w.row(r2.trade_id).skip_reason).toBe('d18_shutting_down');
    await w.run(at.drain());
  });

  it('confirm mode still answers with the button while stopping (no order is involved)', async () => {
    const at = w.autoTrade();
    at.beginShutdown();
    const u = newUser('bybit', { auto_trade_mode: 'confirm' });
    const r = w.signal(u);
    const res = await w.run(at.executeAutoTrade(w.kw(u, r, { auto_trade_mode: 'confirm' })));
    expect(res.show_trade_btn).toBe(true);
    expect(w.orderReqs(u)).toEqual([]);
  });

  it('workers/engineWorker.js stop(): beginShutdown → scheduler stop → wait for the placements in flight → registry save → stopped', async () => {
    const EW = req('../../../workers/engineWorker.js');
    const { MessageChannel } = req('worker_threads');
    const ch = new MessageChannel();
    const seen = [];
    const order = [];
    ch.port2.on('message', (m) => { seen.push(m); if (m.type === 'stopped') order.push('stopped'); });
    let release;
    const busy = new Promise((r) => { release = r; });
    const fakeAt = {
      beginShutdown: () => order.push('beginShutdown'),
      waitIdle: async (ms) => { order.push(`waitIdle:${ms}`); await busy; return 0; },
      executeAutoTrade: async () => ({}), getApiKeys: () => null, getBalance: async () => null, gc: {}, exchanges: () => [],
    };
    const cache = { getCache: () => ({}), initCache: () => {}, getCandles: () => null, getCoins: () => null };
    const ew = EW.runWorker(ch.port1, {
      logs: false,
      deps: {
        log: w.quiet, cache, fetcher: {}, registry: { forceSave: () => { order.push('forceSave'); return 0; } },
        exchangeSymbols: { startBackgroundRefresh: async () => ({ stop() {} }), getStats: () => ({}) }, autoTrade: fakeAt,
      },
    });
    ch.port2.postMessage({ type: 'start', options: { only: [] } });
    expect(await pumpUntil(() => seen.some((m) => m.type === 'ready'))).toBe(true);
    const stopping = ew.stop();
    await settle(50);
    expect(order[0]).toBe('beginShutdown');
    expect(order).toContain(`waitIdle:${EW.AUTOTRADE_DRAIN_MS}`);
    expect(seen.some((m) => m.type === 'stopped')).toBe(false);          // still waiting for the placement
    release();
    await stopping;
    await settle();
    expect(order.slice(-2)).toEqual(['forceSave', 'stopped']);
    expect(EW.SHUTDOWN_GRACE_WITH_DRAIN_MS).toBeGreaterThan(EW.AUTOTRADE_DRAIN_MS);
    expect(EW.SHUTDOWN_GRACE_WITH_DRAIN_MS).toBeLessThan(22000);          // inside the bot's 22 s deadline
    ch.port1.close();
    ch.port2.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('A — fail-closed gates: no order request leaves where the bot blocks', () => {
  for (const ex of W.EXCHANGES) {
    it(`${ex}: killswitch HALTED_NEW and an unreadable killswitch (→ HALTED_ALL) → not one request to the exchange`, async () => {
      for (const mode of ['halted', 'read_error']) {
        const store = w.ksStore();
        const { createKillswitch } = req('../../../services/autotrade/killswitch.js');
        const ks = createKillswitch({ kv: store.kv, monotonic: w.clk.mono, now: w.clk.now, log: w.quiet, emitMutation: async () => false });
        if (mode === 'halted') await ks.setState('HALTED_NEW', { reason: 'test', actorUid: 1 });
        else store.st.fail = true;
        const at = w.autoTrade({ killswitch: ks });
        const u = newUser(ex);
        const r = w.signal(u);
        const res = await w.run(at.executeAutoTrade(w.kw(u, r)));
        expect(res.limit_msg, mode).toMatch(/^killswitch_halted: HALTED_(NEW|ALL)$/);
        expect(w.allReqs(u), mode).toEqual([]);
        expect(w.row(r.trade_id).result).toBe('');      // the bot writes no SKIP here
      }
    });
  }

  it('plan gate DB error, free plan, circuit breaker read error, prop balance error, challenge gate error → no order request', async () => {
    const cases = [
      ['plan_db_error', (o) => { o.tradeDb = failingTdb('getUser'); }, (res) => expect(res.limit_msg).toBe('plan_gate: db_error_fail_closed')],
      ['plan_free', null, (res) => expect(res.limit_msg).toBe('plan_gate: free'), { sub_plan: 'free' }],
      ['circuit_breaker_error', (o) => { o.tradeDb = failingTdb('getTodayLossRr'); }, (_res, row) => expect(row.skip_reason).toBe('circuit_breaker_gate_error'), { circuit_breaker_enabled: true, circuit_breaker_threshold_r: 3 }],
      ['prop_balance_error', null, (_res, row) => expect(row.skip_reason).toBe('prop_balance_fetch_fail'), { prop_mode: true }, { on: (p) => /wallet-balance/.test(p.path), kind: 'reset-after', times: 5 }],
      ['challenge_error', (o) => { o.challengeGate = async () => { throw new Error('kv down'); }; }, (_res, row) => expect(row.skip_reason).toBe('challenge_gate_error')],
      ['max_sl_too_wide', null, (_res, row) => expect(row.skip_reason).toBe('max_sl_too_wide'), {}, null, { sl: 80 }],
    ];
    for (const [name, patch, check, settings = {}, fault = null, sig = {}] of cases) {
      const u = newUser('bybit', settings);
      const r = w.signal(u, sig);
      const o = {};
      if (patch) patch(o);
      const at = w.autoTrade(o);
      if (fault) w.faults.add({ ...fault, key: u.key });
      const res = await w.run(at.executeAutoTrade(w.kw(u, r)));
      await w.run(at.drain());
      check(res, w.row(r.trade_id));
      expect(w.orderReqs(u), name).toEqual([]);
    }
  });

  function failingTdb(method) {
    const { createTradeDb } = req('../../../services/autotrade/tradeDb.js');
    const t = createTradeDb({ log: w.quiet, now: w.clk.now });
    return { ...t, [method]: async () => { throw new Error('database is locked'); } };
  }
});

// ═══════════════════════════════════════════════════════════════════════
describe("A' — background orders after the open never add exposure", () => {
  for (const ex of W.EXCHANGES) {
    it(`${ex}: partial-TP / fallback orders are closing orders; the position never grows past the entry`, async () => {
      const at = w.autoTrade();
      const u = newUser(ex);
      const r = w.signal(u);
      await w.run(at.executeAutoTrade(w.kw(u, r)));
      await w.run(at.drain());
      const entries = new Set(w.entries(u));
      const after = w.orderReqs(u).filter((q) => !entries.has(q) && q.method === 'POST' && /order|Orders|algo/.test(q.path));
      for (const q of after) {
        const closing = (q.body && (q.body.reduceOnly === true || q.body.reduceOnly === 'true'))
          || (q.query && (q.query.reduceOnly === 'true' || ['TAKE_PROFIT_MARKET', 'STOP_MARKET', 'TAKE_PROFIT', 'STOP'].includes(q.query.type)))
          || /order-algo|cancel|close-position|leverage|positionSide|switch|trading-stop|batchOrders/.test(q.path);
        expect(closing, `${ex} ${q.path} ${JSON.stringify(q.query || q.body)}`).toBe(true);
      }
      expect(near(w.maxLong(u), QTY[ex])).toBe(true);
      expect(shortSize(u)).toBe(0);
    });
  }

  it('LIMIT-unfilled guard: a resting entry is cancelled after the grace — no position, no orders left, the row untouched (bot)', async () => {
    const at = w.autoTrade();
    const u = newUser('bybit');
    const r = w.signal(u, { entry: 99, sl: 97 });           // a LONG limit under the market (99.9) rests
    await w.run(at.executeAutoTrade(w.kw(u, r, { order_type: 'Limit' })));
    await w.run(at.drain());                                 // the 60 s grace on the virtual clock
    expect(w.entriesSent(u).length).toBe(1);
    expect(w.entriesSent(u)[0].body.orderType).toBe('Limit');
    expect(w.allReqs(u).some((q) => q.path === '/v5/order/cancel-all')).toBe(true);
    expect(w.orders(u)).toEqual([]);
    expect(longSize(u)).toBe(0);
    expect(w.logs.some((l) => l.includes('[LIMIT-UNFILLED]'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('B / C — confirm exec and quick close through the routes and the trade-ops queue', () => {
  let app;
  let ops;
  let auth;
  const tradeOps = req('../../../workers/tradeOpsWorker.js');
  const appTrade = req('../../../routes/appTrade.js');
  const appRouter = req('../../../routes/app.js');
  const SD = req('../../../services/engine/signalDelivery.js');
  const authService = req('../../../services/authService.js');
  const ENV_ON = { AUTOTRADE_ENABLED: '1', AUTOTRADE_EXCHANGES: 'bybit,bingx,binance,okx' };
  let opsReg;
  let facade;

  const card = (tid, actions) => JSON.stringify({ html: 'card', actions, lang: 'ru' });
  const execCard = (tid) => card(tid, [[{ id: 'exec', label: '✅ Открыть сделку на Bybit', action: `exec_trade_${tid}`, kind: 'callback' }]]);
  const qcCard = (tid) => card(tid, [[
    { id: 'qc_half', label: '🎯 50%', action: `qc_half_${tid}`, kind: 'callback' },
    { id: 'qc_full', label: '💰 100%', action: `qc_full_${tid}`, kind: 'callback' },
    { id: 'qc_be', label: '🛡 SL→BE', action: `qc_be_${tid}`, kind: 'callback' },
  ]]);
  const setCard = (tid, json) => w.db.prepare('UPDATE signal_trades SET signal_card_json=? WHERE trade_id=?').run(json, tid);
  const post = (uid, url) => request(app).post(`/api/app/${url}`).set(auth(uid)).send({});

  function freshOps() {
    ops = tradeOps.configureLocal({ registry: opsReg, log: w.quiet, now: () => w.clk.now(), delivery: facade, env: ENV_ON });
    return ops;
  }

  beforeAll(async () => {
    app = (await import('../../../server.js')).default;
    opsReg = w.opsRegistry();
    facade = SD.localFacade(SD.createSignalDelivery({ log: w.quiet }));
    appTrade.configure({ clock: () => w.clk.now(), log: w.quiet, registry: opsReg, execWaitS: 30 });
    appRouter.resetRateLimits();
    appRouter.setClock(() => w.clk.now());
    freshOps();
    const tokens = {};
    auth = (uid) => {
      if (!tokens[uid]) tokens[uid] = authService._signAccessToken(uid);
      return { Authorization: `Bearer ${tokens[uid]}` };
    };
  });
  afterAll(() => {
    try { appTrade.configure({ clock: null, log: null, registry: null, execWaitS: null }); } catch (_e) { /* */ }
    try { tradeOps.configureLocal(null); } catch (_e) { /* */ }
    try { appRouter.setClock(null); } catch (_e) { /* */ }
  });

  /** A confirm-mode signal with its delivered card (the exec button). */
  function confirmSignal(ex) {
    const u = newUser(ex, { auto_trade_mode: 'confirm' });
    const r = w.signal(u);
    setCard(r.trade_id, execCard(r.trade_id));
    return { u, r };
  }

  /** An auto-opened position with its delivered card (the quick-close buttons). */
  async function openPosition(ex) {
    const at = w.autoTrade();
    const u = newUser(ex);
    const r = w.signal(u);
    await w.run(at.executeAutoTrade(w.kw(u, r)));
    await w.run(at.drain());
    setCard(r.trade_id, qcCard(r.trade_id));
    expect(near(longSize(u), QTY[ex])).toBe(true);
    return { u, r };
  }

  for (const ex of W.EXCHANGES) {
    it(`${ex} B: two presses of «Открыть сделку» at the same moment → one order (per-trade lock), the second answers «уже открывается»`, async () => {
      freshOps();
      const { u, r } = confirmSignal(ex);
      const tid = encodeURIComponent(r.trade_id);
      const [a, b] = await Promise.all([post(u.uid, `trades/${tid}/exec`), post(u.uid, `trades/${tid}/exec`)]);
      // the second press meets the per-trade lock («уже открывается») or — once the first job took the
      // button off the card (persisted before the order goes out) — the D16 404; never a second order
      const outcomes = [a, b].map((x) => (x.status === 404 ? 'not_found' : x.body.outcome)).sort();
      expect(outcomes[1]).toBe('opened');
      expect(['locked', 'not_found']).toContain(outcomes[0]);
      expect(w.entries(u).length).toBe(1);
      expect(w.opens(u)).toBe(1);                            // one fill (confirm sizes on the raw entry: no 0.05 % improvement)
      expect(near(w.maxLong(u), longSize(u))).toBe(true);
      // the card lost its button: a third press is a 404 before any work
      const c = await post(u.uid, `trades/${tid}/exec`);
      expect(c.status).toBe(404);
      expect(w.entries(u).length).toBe(1);
    });

    it(`${ex} B: two exec jobs of one trade in the queue at once (past the route) → the per-trade lock answers «уже открывается», one order`, async () => {
      freshOps();
      const { u, r } = confirmSignal(ex);
      const job = () => ops.submit('exec', { userId: u.uid, admin: false, tradeId: r.trade_id });
      const [a, b] = await Promise.all([job(), job()]);
      expect([a.outcome, b.outcome].sort()).toEqual(['locked', 'opened']);
      const locked = [a, b].find((x) => x.outcome === 'locked');
      expect(locked.effects).toEqual([{ op: 'answer', text: '⏳ Сделка уже открывается, подожди...', show_alert: true }]);
      expect(w.entries(u).length).toBe(1);
      // the lock is released: a later job sees the order id and answers «уже была открыта на бирже»
      const c = await job();
      expect(c.outcome).toBe('already_on_exchange');
      expect(w.entries(u).length).toBe(1);
    });

    it(`${ex} B: the trade-ops worker dies mid-placement → after the restart the card has no button (D18), a press is 404, no second order`, async () => {
      freshOps();
      const { u, r } = confirmSignal(ex);
      const tid = encodeURIComponent(r.trade_id);
      w.faults.add({ on: 'entry', kind: 'lost-after', key: u.key });
      ops.submit('exec', { userId: u.uid, admin: false, tradeId: r.trade_id }).catch(() => {});   // never answers
      expect(await pumpUntil(() => w.entriesSent(u).length === 1)).toBe(true);
      // the button went away BEFORE the order left (persisted, not with the effects at the end)
      const cardNow = JSON.parse(w.row(r.trade_id).signal_card_json);
      expect(cardNow.actions).toBe(null);
      expect(cardNow.html).toBe('⏳ Открываю сделку...');
      // the worker is restarted: fresh queue, fresh per-trade locks
      freshOps();
      const again = await post(u.uid, `trades/${tid}/exec`);
      expect(again.status).toBe(404);
      expect(w.entriesSent(u).length).toBe(1);
    });

    it(`${ex} B: an in-flight auto placement of the symbol (PLACING, no order id) blocks a confirm exec (D18) — no order`, async () => {
      freshOps();
      const { u, r } = confirmSignal(ex);
      // a crashed auto placement of the same user and symbol
      w.signal(u, { state: 'PLACING', state_changed_at: w.clk.now(), order_id: '' });
      const res = await post(u.uid, `trades/${encodeURIComponent(r.trade_id)}/exec`);
      expect(res.body.outcome).toBe('dup_symbol');
      expect(w.orderReqs(u)).toEqual([]);
    });

    it(`${ex} B: killswitch unreadable (→ HALTED_ALL) → the trader refuses, nothing reaches the exchange`, async () => {
      const store = w.ksStore();
      store.st.fail = true;
      const { createKillswitch } = req('../../../services/autotrade/killswitch.js');
      const ks = createKillswitch({ kv: store.kv, log: w.quiet, emitMutation: async () => false });
      const reg = w.opsRegistry({ killswitch: ks });
      const o = tradeOps.configureLocal({ registry: reg, log: w.quiet, now: () => w.clk.now(), delivery: facade, env: ENV_ON });
      const { u, r } = confirmSignal(ex);
      const res = await o.submit('exec', { userId: u.uid, admin: false, tradeId: r.trade_id });
      expect(res.outcome).toBe('failed');
      expect(JSON.stringify(res.result)).toContain('killswitch_halted: HALTED_ALL');
      expect(w.orderReqs(u)).toEqual([]);
      freshOps();
    });

    it(`${ex} C: «100 %» pressed twice at once → one close (per-user lock), the second finds no position; nothing ever opens the other side`, async () => {
      freshOps();
      const { u, r } = await openPosition(ex);
      const tid = encodeURIComponent(r.trade_id);
      const [a, b] = await Promise.all([post(u.uid, `trades/${tid}/qc/full`), post(u.uid, `trades/${tid}/qc/full`)]);
      const msgsOf = [a.body.message, b.body.message].sort();
      expect(msgsOf).toEqual(['Позиция уже закрыта', '✅ Позиция закрыта полностью'].sort());
      expect(longSize(u)).toBe(0);
      expect(shortSize(u)).toBe(0);
      expect(near(w.maxLong(u), QTY[ex])).toBe(true);
    });

    it(`${ex} C: «50 %» pressed twice at once → 50 % then 25 % (never 50 % + 50 % on one stale read)`, async () => {
      freshOps();
      const { u, r } = await openPosition(ex);
      const tid = encodeURIComponent(r.trade_id);
      await Promise.all([post(u.uid, `trades/${tid}/qc/half`), post(u.uid, `trades/${tid}/qc/half`)]);
      // [QC-SIDE-FIX 2026-10]: OKX 50 % is a market order on the same posSide (it used to be the bot's TypeError)
      expect(longSize(u)).toBeGreaterThan(QTY[ex] * 0.2);
      expect(longSize(u)).toBeLessThan(QTY[ex] * 0.3);
      expect(shortSize(u)).toBe(0);
    });

    it(`${ex} C: the close was executed but its answer was lost → the next press reads the live size (0) and sends nothing`, async () => {
      freshOps();
      const { u, r } = await openPosition(ex);
      const tid = encodeURIComponent(r.trade_id);
      w.faults.add({ on: 'close', kind: 'reset-after', key: u.key });
      await post(u.uid, `trades/${tid}/qc/full`);
      expect(longSize(u)).toBe(0);
      const closes = w.allReqs(u).filter((q) => W.isClose(q)).length;
      const again = await post(u.uid, `trades/${tid}/qc/full`);
      expect(again.body.message).toBe('Позиция уже закрыта');
      expect(w.allReqs(u).filter((q) => W.isClose(q)).length).toBe(closes);
      expect(shortSize(u)).toBe(0);
    });

    it(`${ex} C: SL→BE twice → the stop sits at the entry, the position is untouched, no entry is sent`, async () => {
      freshOps();
      const { u, r } = await openPosition(ex);
      const tid = encodeURIComponent(r.trade_id);
      const entriesBefore = w.entriesSent(u).length;
      w.fake.setPrice(W.BASE, 101);                          // in profit: a stop at the entry is below the mark
      const a = await post(u.uid, `trades/${tid}/qc/be`);
      const b = await post(u.uid, `trades/${tid}/qc/be`);
      w.fake.setPrice(W.BASE, W.LAST);
      expect(a.body.outcome).toBe('be_set');
      expect(['be_set', 'failed']).toContain(b.body.outcome);
      expect(w.row(r.trade_id).be_set).toBe(1);
      expect(near(longSize(u), QTY[ex])).toBe(true);
      expect(w.entriesSent(u).length).toBe(entriesBefore);
    });
  }

  it('another user\'s trade id and a card without the button → 404 before any work, for every money action', async () => {
    freshOps();
    const { u, r } = await openPosition('bybit');
    const intruder = newUser('bybit');
    const tid = encodeURIComponent(r.trade_id);
    const before = w.fake.requests.length;
    for (const a of ['exec', 'qc/half', 'qc/full', 'qc/force', 'qc/be']) {
      const res = await post(intruder.uid, `trades/${tid}/${a}`);
      expect(res.status, a).toBe(404);
    }
    expect((await request(app).get(`/api/app/trades/${tid}/progress`).set(auth(intruder.uid))).status).toBe(404);
    expect((await request(app).get(`/api/app/trades/${tid}/card`).set(auth(intruder.uid))).status).toBe(404);
    // the owner, but the card does not offer exec (an auto trade) → 404
    expect((await post(u.uid, `trades/${tid}/exec`)).status).toBe(404);
    expect(w.fake.requests.length).toBe(before);
  });
});
