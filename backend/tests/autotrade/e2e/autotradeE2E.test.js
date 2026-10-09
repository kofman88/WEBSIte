/**
 * End-to-end auto-trade on fake exchange servers (all four exchanges, no network).
 *
 * The real engine path: the VOLUME scanner (volume_scanner._scan_cycle on the golden candles of the
 * scanner differential — cycle 1767186020, the SYNUP07 LONG of the fixture's user 2003) wired by the
 * scheduler exactly like the engine worker (scheduler.ctx.scannerDeps('VOLUME') over
 * services/autotrade createAutoTrade: execute_auto_trade + the users' exchange keys + balances), the
 * site's delivery (signalDelivery → notifications + the card snapshot), the app routes (exchange keys
 * with D15, positions, the card, the trade buttons through the trade-ops queue) and one stateful fake
 * exchange per venue (fakeExchanges.js — signatures checked, orders matched).
 *
 *   auto      Pro user, auto-trade on, mode auto → entry with SL on the exchange, two partial-TP
 *             orders, signal_trades OPEN (+ D17: the exchange recorded), the open message = the bot's
 *             format_trade_result (CPython 3.11, gen/gen_e2e_messages.py: fixtures/e2e_messages.json),
 *             the card carries the quick-close buttons, GET positions shows the position, quick close
 *             closes it (50 % then 100 %; OKX 50 % is the bot's TypeError — nothing sent)
 *   confirm   mode confirm → no order, the card offers «✅ Открыть сделку…» (exec_trade_<id>), the row
 *             PENDING; POST trades/<id>/exec → placed with SL / TP, the card edited without buttons,
 *             the message = format_trade_result (kept quirks: the row stays PENDING, qty 0); a second
 *             press → 404 (D16: the button is gone) with nothing sent
 *   expiry    mode confirm → the tracker closes the signal on time (EXPIRED; the card keeps its
 *             keyboard like the bot's), the 3-day ghost cleanup marks the row SKIP, the exec button
 *             answers «ℹ️ Сделка уже была открыта ранее.» — no order request ever reaches an exchange.
 *             Pinned bot quirk: between the tracker's EXPIRED and the ghost pass an exec still places
 *             (no age check in exec_trade) — the `window` user
 *   D5 / killswitch  an exec while AUTOTRADE_ENABLED is off / the exchange is not enabled → the
 *             site's gate, nothing sent; the killswitch HALTED → the trader's killswitch_halted dict
 *             (format_trade_result of it), nothing sent
 *
 * Fixture: E2E_CAPTURE=<file> npx vitest run tests/autotrade/e2e  → the format_trade_result inputs,
 * then gen/gen_e2e_messages.py <file> (CPython 3.11, the bot's own formatters) → fixtures/e2e_messages.json.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import request from 'supertest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm13-e2e-'));
process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(tmpDir, 'e2e.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';

const req = createRequire(import.meta.url);
const H = req('../../engine/scanners/levels_harness.js');
const { createFakeExchanges } = req('./fakeExchanges.js');
const FIX = H.loadFixture(path.join(__dirname, '..', '..', 'engine', 'scanners', 'volume_fixtures', 'scan.json.gz'));
const MSG_PATH = path.join(__dirname, 'fixtures', 'e2e_messages.json');
const MSG = fs.existsSync(MSG_PATH) ? JSON.parse(fs.readFileSync(MSG_PATH, 'utf8')) : { i18n: {} };
const CAPTURE = process.env.E2E_CAPTURE || null;

const EXCHANGES = ['bybit', 'bingx', 'binance', 'okx'];
const ENV_ON = { AUTOTRADE_ENABLED: '1', AUTOTRADE_EXCHANGES: 'bybit,bingx,binance,okx' };
const T0 = FIX.cycles[0].ts;                      // 1767186020
const SYM = 'SYNUP07-USDT-SWAP';
const BASE = 'SYNUP07';
const LAST_PRICE = 7896.5;                        // marketable for the 0.05 %-improved LONG limit (7896.89)
const KEYS = {
  bybit: ['BYE2EKEY00000001', 'by-e2e-secret-0001'],
  bingx: ['BXE2EKEY00000001', 'bx-e2e-secret-0001'],
  binance: ['BNE2EKEY00000001', 'bn-e2e-secret-0001'],
  okx: ['OKE2EKEY00000001', 'ok-e2e-secret-0001', 'E2E-pass#1'],
};
// one user (and one exchange account) per group × exchange; `window` only on Bybit
const GROUPS = {
  auto: { uid: 5101, mode: 'auto', risk: 0.5, exchanges: EXCHANGES },
  confirm: { uid: 5201, mode: 'confirm', risk: 1.0, exchanges: EXCHANGES },
  expiry: { uid: 5301, mode: 'confirm', risk: 0.5, exchanges: EXCHANGES },
  halt: { uid: 5401, mode: 'confirm', risk: 0.5, exchanges: EXCHANGES },
  window: { uid: 5501, mode: 'confirm', risk: 0.5, exchanges: ['bybit'] },
};
const uidOf = (g, ex) => GROUPS[g].uid + EXCHANGES.indexOf(ex);
const keyOf = (g, ex) => `${KEYS[ex][0]}${g[0].toUpperCase()}`;
const secretOf = (g, ex) => `${KEYS[ex][1]}-${g}`;
const PASSPHRASE = KEYS.okx[2];
// the requests that create / change / cancel an order or a position (everything else only reads)
const ORDER_PATHS = /\/v5\/order\/|\/v5\/position\/(set-leverage|switch-isolated|trading-stop)|\/openApi\/swap\/v2\/trade\/|\/fapi\/v1\/(order|batchOrders|leverage|positionSide\/dual|allOpenOrders)|\/api\/v5\/trade\/|\/api\/v5\/account\/set-leverage/;

const quiet = process.env.E2E_DEBUG
  ? Object.fromEntries(['debug', 'info', 'warning', 'warn', 'error', 'critical'].map((l) => [l, (...a) => console.log(`[${l}]`, ...a)]))
  : { debug() {}, info() {}, warning() {}, warn() {}, error() {}, critical() {} };

const S = { ctx: null, fmt: {} };   // the world, built in beforeAll

function seedUsers(db, ts) {
  const tpl = FIX.users.find((u) => u.user_id === 2003);
  const cols = new Set(ts.COLUMNS);
  for (const [g, G] of Object.entries(GROUPS)) {
    for (const ex of G.exchanges) {
      const uid = uidOf(g, ex);
      const row = {
        ...tpl, user_id: uid, auto_trade: 1, auto_trade_mode: G.mode, trade_exchange: ex,
        trade_risk_pct: G.risk, trade_leverage: 25, max_trades_limit: 10, sub_plan: 'pro', sub_status: 'active',
        sub_expires: T0 + 30 * 86400, bybit_demo: 0, lang: 'ru', username: '', hold_lock_enabled: 0,
      };
      db.prepare('INSERT INTO users (id, email, password_hash, referral_code) VALUES (?, ?, ?, ?)').run(uid, `e2e${uid}@x.test`, 'x', `E${uid}`);
      const keys = Object.keys(row).filter((k) => k === 'user_id' || cols.has(k));
      db.prepare(`INSERT INTO trader_settings (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => row[k]));
    }
  }
  ts.invalidateCache();
}

function seedMarket(clock) {
  const candleCache = req('../../../services/marketData/candleCache.js');
  candleCache._resetForTests();
  candleCache.initCache(FIX.cache_max_keys, { now: () => clock.now(), log: quiet });
  const cyc = FIX.cycles[0];
  for (const sym of FIX.symbols) {
    if (FIX.ws_missing.includes(sym)) continue;
    for (const tf of FIX.meta.ws_tfs) {
      if ((FIX.ws_no_htf[sym] || []).includes(tf)) continue;
      const lim = Object.prototype.hasOwnProperty.call(FIX.ws_short, sym) ? FIX.ws_short[sym] : 300;
      const f = H.frameAt(sym, tf, cyc.ts, lim);
      if (f) candleCache.setCandles(sym, tf, f, FIX.cache_ttl);
    }
  }
  const exSym = req('../../../services/exchanges/exchangeSymbols.js');
  exSym._resetForTests();
  const sm = req('../../../services/marketData/symbolMap.js');
  const okx = req('../../../services/exchanges/okxTrader.js');
  const nat = {
    bybit: (s) => sm.toBybitSymbol(s), bingx: (s) => sm.toBingxSymbol(s), binance: (s) => sm.toBinanceSymbol(s), okx: (s) => okx.toOkxSymbol(s),
  };
  // execute_auto_trade asks exchange_symbols with the wall clock (time.time() in the bot): a fresh cache
  for (const ex of EXCHANGES) exSym._setSymbols(ex, FIX.symbols.map(nat[ex]), { updatedAt: Date.now() / 1000 });
  return { candleCache, exSym };
}

/**
 * Capture every format_trade_result call (the four trader modules' exports — read at call time by
 * the auto-trade handles and the confirm exec): its inputs and text, keyed `<group>:<exchange>`.
 */
function captureFormatters(store, restore) {
  const mods = {
    bybit: req('../../../services/exchanges/bybitTrader.js'), bingx: req('../../../services/exchanges/bingxTrader.js'),
    binance: req('../../../services/exchanges/binanceTrader.js'), okx: req('../../../services/exchanges/okxTrader.js'),
  };
  for (const [ex, mod] of Object.entries(mods)) {
    const orig = mod.formatTradeResult;
    restore.push(() => { mod.formatTradeResult = orig; });
    mod.formatTradeResult = (...a) => {
      const text = orig(...a);
      store[`${S.ctx || 'auto'}:${ex}`] = { exchange: ex, args: JSON.parse(JSON.stringify(a)), text };
      return text;
    };
  }
}

async function buildWorld() {
  const db = req('../../../models/database.js');
  const ts = req('../../../services/traderSettingsService.js');
  const exchanges = req('../../../services/exchanges/index.js');
  const { memoryKv } = req('../../../services/exchanges/runtime.js');
  const { createBalanceCache } = req('../../../services/exchanges/balanceCache.js');
  const AT = req('../../../services/autotrade/index.js');
  const KS = req('../../../services/autotrade/killswitch.js');
  const SCH = req('../../../services/engine/scheduler.js');
  const VS = req('../../../services/engine/volumeScanner.js');
  const SD = req('../../../services/engine/signalDelivery.js');
  const ST = req('../../../services/engine/signalTracker.js');
  const GC = req('../../../services/engine/ghostCleanup.js');
  const { createSignalRegistry } = req('../../../services/engine/signalRegistry.js');
  const { createFreshness } = req('../../../services/engine/signalFreshness.js');
  const { createTrendMonitor } = req('../../../services/engine/trendMonitor.js');
  const { createSignalConfluence } = req('../../../services/engine/signalConfluence.js');
  const { createCoinQualityLearner } = req('../../../services/engine/coinQualityLearner.js');
  const { createSignalTradesRepo } = req('../../../services/engine/signalTradesRepo.js');
  const appTrade = req('../../../routes/appTrade.js');
  const appRouter = req('../../../routes/app.js');
  const keysSvc = req('../../../services/exchangeKeysService.js');
  const tradeOps = req('../../../workers/tradeOpsWorker.js');
  const authService = req('../../../services/authService.js');
  const app = (await import('../../../server.js')).default;

  const clock = new H.Clock(T0);
  seedUsers(db, ts);
  const { candleCache, exSym } = seedMarket(clock);

  // ── the four exchanges, one account per user ──
  const fake = createFakeExchanges({
    clock,
    instruments: { [BASE]: { tick: 0.01, step: 0.001, minQty: 0.001, ctVal: 0.01, lotSz: 1, maxLev: 100 } },
    prices: { [BASE]: LAST_PRICE },
  });
  for (const [g, G] of Object.entries(GROUPS)) {
    for (const ex of G.exchanges) fake.addAccount(ex, { key: keyOf(g, ex), secret: secretOf(g, ex), passphrase: ex === 'okx' ? PASSPHRASE : '', balance: 10000 });
  }
  const runtime = (log) => ({ transport: fake.transport, now: () => clock.now(), sleep: async () => {}, kv: memoryKv(), log, env: {} });
  const restore = [];
  captureFormatters(S.fmt, restore);

  // ── the engine side: execute_auto_trade with the site's sources (+ the fake exchanges) ──
  const delivery = SD.createSignalDelivery({ log: quiet });
  const facade = SD.localFacade(delivery);
  const balanceReg = exchanges.createRegistry({ overrides: runtime(quiet) });
  const balanceCache = createBalanceCache({ getTrader: (ex) => exchanges.getTrader(ex, { registry: balanceReg }), now: () => clock.now(), log: quiet });
  const tr = runtime(quiet);
  const at = AT.createAutoTrade({
    bot: facade, env: ENV_ON, log: quiet, now: () => clock.now(), sleep: async () => {},
    traderRuntime: { transport: tr.transport, sleep: tr.sleep, now: tr.now, kv: tr.kv, log: tr.log, env: tr.env },
    balanceCache, exchangeSymbols: exSym, cache: candleCache,
  });
  // auto_trade.reset_auth_failures as the app routes reach it (keys saved, auto-trade switched on)
  const resets = [];
  const resetAuth = at.resetAuthFailures;
  at.resetAuthFailures = (uid, ex) => { resets.push([uid, ex]); return resetAuth(uid, ex); };

  // ── the app side: routes + the trade-ops queue (its own trader instances, the same exchanges,
  //    the bot's trader hooks with a killswitch the test flips) ──
  const ksStore = new Map();
  const killswitch = KS.createKillswitch({ kv: { get: (k) => (ksStore.has(k) ? ksStore.get(k) : null), set: (k, v) => ksStore.set(k, v) }, log: quiet, emitMutation: async () => false });
  const opsReg = AT.createTradeOpsRegistry({ log: quiet, killswitch, overrides: runtime(quiet) });
  const candles = async (symbol, tf) => candleCache.getCandles(symbol, tf);
  const configureOps = (env) => tradeOps.configureLocal({ registry: opsReg, log: quiet, now: () => clock.now(), candles, delivery: facade, env });
  appTrade.configure({ clock: () => clock.now(), log: quiet, registry: opsReg, candles, execWaitS: 60 });
  keysSvc.configure({ log: quiet, registry: opsReg, resetAuthFailures: async (uid, ex) => at.resetAuthFailures(uid, ex) });
  configureOps(ENV_ON);
  appRouter.resetRateLimits();
  appRouter.setClock(() => clock.now());
  const tokens = {};
  const auth = (uid) => {
    if (!tokens[uid]) tokens[uid] = authService._signAccessToken(uid);
    return { Authorization: `Bearer ${tokens[uid]}` };
  };

  // ── the scanner the engine worker builds (scheduler.ctx.scannerDeps) ──
  const sched = SCH.createScheduler({ side: 'worker', deps: { autoTrade: at, bot: facade, log: quiet, env: ENV_ON, now: () => clock.now(), cache: candleCache, db } });
  const sd = sched.ctx.scannerDeps('VOLUME');
  const kv = H.memKv();
  const trend = createTrendMonitor({ env: {}, kv: null, now: () => clock.now(), log: quiet });
  const cyc = FIX.cycles[0];
  const st = {};
  for (const [tf, t] of Object.entries(cyc.trend)) st[tf] = { trend: t, since: cyc.ts - 3600.0, price: 90000.0 };
  trend._seed(st, cyc.strength);
  const scanner = VS.createVolumeScanner({
    ...sd,
    sleep: async () => {},
    random: new H.Rand(),
    trend,
    registry: createSignalRegistry({ kv, now: () => clock.now(), log: quiet, isAdmin: () => false }),
    freshness: createFreshness({ env: {}, getCandles: (s, tf) => candleCache.getCandles(s, tf), log: quiet }),
    confluence: createSignalConfluence({ now: () => clock.now() }),
    coinQuality: createCoinQualityLearner({ now: () => clock.now(), kv: H.memKv(), log: quiet }),
    exchangeSymbols: exSym,
    repo: createSignalTradesRepo({ db, now: () => clock.now(), log: quiet }),
    kv,
    metrics: null,
    isAdmin: () => false,
    filterLog: quiet, strategyLog: quiet, tgLog: quiet, log: quiet,
  });
  const um = { getActiveUsers: () => ts.getActiveUsers({ now: clock.now() }) };
  const fetcher = new H.FakeFetcher(clock, FIX.volumes, {});
  const tracker = ST.createSignalTracker({ db, log: quiet, sleep: async () => {}, clock: () => clock.now(), sse: null, notifier: { dispatch: async () => ({ dispatched: true }) } });
  return {
    db, ts, app, clock, fake, at, scanner, um, fetcher, facade, auth, opsReg, appTrade, keysSvc, tradeOps, appRouter,
    killswitch, configureOps, tracker, GC, restore, resets,
  };
}

const trade = (uid) => S.db.prepare('SELECT * FROM signal_trades WHERE user_id=? AND symbol=? ORDER BY rowid').get(uid, SYM);
const tradeNotes = (uid) => S.db.prepare("SELECT title, body, link FROM notifications WHERE user_id=? AND type='trade' ORDER BY id").all(uid);
const cardOf = (uid) => JSON.parse(trade(uid).signal_card_json);
const callbacks = (c) => ((c && c.actions) || []).flat().filter((b) => b.kind === 'callback').map((b) => b.action);
const orderRequests = (g, ex) => S.fake.requests.filter((r) => r.ex === ex && r.key === keyOf(g, ex) && ORDER_PATHS.test(r.path));
const positionsOf = (g, ex) => S.fake.positions(ex, keyOf(g, ex));
const api = (method, url, uid, body) => {
  const r = request(S.app)[method](`/api/app/${url}`).set(S.auth(uid));
  return body === undefined ? r : r.send(body);
};
const tid = (uid) => encodeURIComponent(trade(uid).trade_id);

describe('auto-trade end to end on fake exchanges (Bybit, BingX, Binance, OKX)', () => {
  beforeAll(async () => {
    Object.assign(S, await buildWorld());
    // keys through the app route: the bot's test_connection + D15 on the exchange, stored encrypted
    S.keyAnswers = {};
    for (const [g, G] of Object.entries(GROUPS)) {
      for (const ex of G.exchanges) {
        const body = { exchange: ex, api_key: keyOf(g, ex), api_secret: secretOf(g, ex) };
        if (ex === 'okx') body.passphrase = PASSPHRASE;
        const r = await api('post', 'exchange/keys', uidOf(g, ex), body);
        S.keyAnswers[`${g}:${ex}`] = r.body;
      }
    }
    S.requestsAfterKeys = S.fake.requests.length;
    // the engine: one VOLUME cycle, then the background tasks (partial TP, LIMIT-unfilled guard)
    await S.scanner._scanCycle(S.facade, S.um, S.fetcher);
    await S.at.drain();
  }, 120_000);

  afterAll(async () => {
    try { S.appTrade.configure({ clock: null, log: null, registry: null, candles: null, execWaitS: null }); } catch (_e) { /* */ }
    try { S.keysSvc.configure({ log: null, registry: null, resetAuthFailures: null }); } catch (_e) { /* */ }
    try { S.tradeOps.configureLocal(null); } catch (_e) { /* */ }
    try { S.appRouter.setClock(null); } catch (_e) { /* */ }
    for (const f of (S.restore || [])) f();
    if (CAPTURE) {
      const users = {};
      for (const [g, G] of Object.entries(GROUPS)) for (const ex of G.exchanges) users[`${g}:${ex}`] = uidOf(g, ex);
      fs.writeFileSync(CAPTURE, JSON.stringify({ fmt: S.fmt, users }, null, 1));
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* tmp */ }
  });

  it('keys: test_connection + D15 on each exchange — every key accepted, stored encrypted, nothing traded', () => {
    for (const [g, G] of Object.entries(GROUPS)) {
      for (const ex of G.exchanges) {
        expect(S.keyAnswers[`${g}:${ex}`], `${g} ${ex}`).toMatchObject({ ok: true, exchange: ex, balance_usdt: 10000 });
        const stored = JSON.stringify(S.db.prepare('SELECT * FROM exchange_keys WHERE user_id=? AND exchange=?').get(uidOf(g, ex), ex));
        expect(stored).toContain('api_key_encrypted');
        expect(stored).not.toContain(keyOf(g, ex));
        expect(stored).not.toContain(secretOf(g, ex));
        if (ex === 'okx') expect(stored).not.toContain(PASSPHRASE);
      }
    }
    expect(S.fake.requests.slice(0, S.requestsAfterKeys).filter((r) => ORDER_PATHS.test(r.path))).toEqual([]);
    expect(S.fake.unhandled).toEqual([]);
  });

  it('auth breaker: saving keys and switching auto-trade on reset the engine\'s auth failures (reset_auth_failures)', async () => {
    const want = [];
    for (const [g, G] of Object.entries(GROUPS)) for (const ex of G.exchanges) want.push([uidOf(g, ex), ex]);
    expect(S.resets).toEqual(want);
    S.resets.length = 0;
    const uid = uidOf('auto', 'okx');
    const r = await api('post', 'settings/all', uid, { trading: { auto_trade: true } });
    expect(r.body.ok).toBe(true);
    expect(S.resets).toEqual([[uid, 'okx']]);
  });

  // ═══ auto ═══
  for (const ex of EXCHANGES) {
    it(`${ex} auto: the signal opens a position with SL and partial-TP orders, the row is OPEN`, () => {
      const row = trade(uidOf('auto', ex));
      expect(row, 'signal row').toBeTruthy();
      expect(row.state).toBe('OPEN');
      expect(row.result).toBe('');
      expect(row.order_id).not.toBe('');
      expect(row.exchange).toBe(ex);                     // D17 (the bot leaves it '' → its quick close reads 'bybit')
      const pos = positionsOf('auto', ex);
      expect(pos).toHaveLength(1);
      expect(pos[0]).toMatchObject({ base: BASE, side: 'LONG' });
      expect(Number(row.qty)).toBeCloseTo(pos[0].size, 9);
      // risk 0.5 % of $10 000 over a 7.44 stop = 6.72 coins; kept OKX quirk (okx_trader.place_trade):
      // the coin size is rounded to lotSz — a CONTRACT step — before the ctVal conversion → 6 coins (600 contracts)
      expect(Number(row.qty)).toBe(ex === 'okx' ? 6 : 6.722);
      const orders = S.fake.orders(ex, keyOf('auto', ex));
      const sl = ex === 'bybit' ? pos[0].sl : orders.filter((o) => o.type === 'STOP').map((o) => o.trigger)[0];
      expect(sl, 'stop-loss on the exchange').toBeGreaterThan(7889);
      expect(sl).toBeLessThan(7890);
      const tps = orders.filter((o) => o.reduceOnly && o.type !== 'STOP');
      expect(tps.length, 'partial TP orders').toBe(2);
      expect(tps.every((o) => o.side === 'SELL' && o.posSide === 'LONG')).toBe(true);
      expect(tps.map((o) => Math.round((o.price || o.trigger) * 100) / 100)).toEqual([7912.23, 7923.61]);
      expect(S.fake.unhandled).toEqual([]);
    });
  }

  it('auto: the partial-TP requests the bot sends that a live exchange might refuse (pinned; served leniently)', () => {
    // partial_tp.py: BingX side "Sell" (Bybit casing) without positionSide; OKX limit TPs without
    // posSide on a long/short account and px = round(price, 8) (not on the tick). Live acceptance unverified.
    expect(S.fake.lenient.map((l) => `${l.ex} ${l.what}`)).toEqual([
      'bingx side Sell', 'bingx no positionSide (TAKE_PROFIT_MARKET)',
      'bingx side Sell', 'bingx no positionSide (TAKE_PROFIT_MARKET)',
      'okx no posSide (limit, reduceOnly)', 'okx px 7912.22640387 off tick 0.01',
      'okx no posSide (limit, reduceOnly)', 'okx px 7923.61468173 off tick 0.01',
    ]);
  });

  for (const ex of EXCHANGES) {
    it(`${ex} auto: the open message is the bot's format_trade_result (CPython 3.11)`, () => {
      const exp = MSG[`auto:${ex}`];
      expect(exp, 'fixture').toBeTruthy();
      expect(S.fmt[`auto:${ex}`].args, 'format_trade_result inputs').toEqual(exp.inputs.args);
      expect(tradeNotes(uidOf('auto', ex)).map((n) => n.body)).toContain(exp.text);
      expect(exp.text.startsWith(ex === 'okx' ? '📈 <b>OKX LONG</b>' : '✅ <b>')).toBe(true);
    });
  }

  for (const ex of EXCHANGES) {
    it(`${ex} auto: the card carries the quick-close buttons with their routes, GET positions shows the position`, async () => {
      const uid = uidOf('auto', ex);
      const id = trade(uid).trade_id;
      const c = await api('get', `trades/${tid(uid)}/card`, uid);
      expect(c.status).toBe(200);
      expect(c.body).toMatchObject({ ok: true, trade_id: id, on_exchange: true, result: '' });
      const btn = Object.fromEntries(c.body.actions.flat().filter((b) => b.api).map((b) => [b.id, b.api]));
      const p = `trades/${tid(uid)}`;
      expect(btn).toEqual({
        qc_half: { method: 'POST', path: `${p}/qc/half` }, qc_full: { method: 'POST', path: `${p}/qc/full` },
        qc_be: { method: 'POST', path: `${p}/qc/be` }, qc_refresh: { method: 'GET', path: `${p}/progress` },
      });
      expect((await api('get', `trades/${tid(uid)}/card`, uidOf('confirm', ex))).status).toBe(404);   // D16
      const r = await api('get', 'positions', uid);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: true, exchange: ex });
      expect(r.body.positions).toHaveLength(1);
      expect(r.body.positions[0]).toMatchObject({ exchange: ex, symbol: BASE, side: 'LONG' });
      expect(r.body.positions[0].size).toBeCloseTo(positionsOf('auto', ex)[0].size, 9);
      expect(r.body.orders_count).toBeGreaterThan(0);
    });
  }

  for (const ex of EXCHANGES) {
    it(`${ex} auto: quick close — 50 % then 100 % through the trade-ops queue closes the position`, async () => {
      const uid = uidOf('auto', ex);
      const before = positionsOf('auto', ex)[0].size;
      const sentBefore = orderRequests('auto', ex).length;
      const half = await api('post', `trades/${tid(uid)}/qc/half`, uid, {});
      expect(half.status).toBe(200);
      if (ex === 'okx') {
        // quick_close.py: OKX close_position has no `size` → TypeError before any request (kept)
        expect(half.body).toMatchObject({ ok: false, outcome: 'failed', message: "❌ Ошибка: close_position() got an unexpected keyword argument 'size'" });
        expect(orderRequests('auto', ex).length).toBe(sentBefore);
        expect(positionsOf('auto', ex)[0].size).toBe(before);
      } else {
        expect(half.body).toMatchObject({ ok: true, outcome: 'closed_half' });
        expect(half.body.message).toMatch(/^✅ Закрыта половина: /);
        expect(positionsOf('auto', ex)[0].size).toBeCloseTo(before / 2, 2);
      }
      const full = await api('post', `trades/${tid(uid)}/qc/full`, uid, {});
      expect(full.status).toBe(200);
      expect(full.body).toMatchObject({ ok: true, outcome: 'closed', message: '✅ Позиция закрыта полностью' });
      expect(positionsOf('auto', ex)).toEqual([]);
      const r = await api('get', 'positions', uid);
      expect(r.body).toMatchObject({ ok: true, exchange: ex, positions: [] });
      // another user's press never reaches the exchange (D16)
      const n = S.fake.requests.length;
      expect((await api('post', `trades/${tid(uid)}/qc/full`, uidOf('confirm', ex), {})).status).toBe(404);
      expect(S.fake.requests.length).toBe(n);
      expect(S.fake.unhandled).toEqual([]);
    });
  }

  // ═══ confirm ═══
  for (const ex of EXCHANGES) {
    it(`${ex} confirm: no order on the signal — the card offers «Открыть сделку», the row is PENDING`, () => {
      for (const g of ['confirm', 'expiry', 'halt']) {
        const uid = uidOf(g, ex);
        const row = trade(uid);
        expect(row.state, g).toBe('PENDING');
        expect(row.order_id).toBe('');
        expect(callbacks(cardOf(uid))).toContain(`exec_trade_${row.trade_id}`);
        expect(cardOf(uid).actions[0][0].label).toBe('✅ Открыть сделку на Bybit');   // the bot's label for every exchange
        expect(orderRequests(g, ex)).toEqual([]);
        expect(positionsOf(g, ex)).toEqual([]);
        expect(tradeNotes(uid)).toEqual([]);
      }
    });
  }

  for (const ex of EXCHANGES) {
    it(`${ex} confirm: POST exec places the order with SL and TPs, the message is format_trade_result`, async () => {
      const uid = uidOf('confirm', ex);
      S.ctx = 'confirm';
      const r = await api('post', `trades/${tid(uid)}/exec`, uid, {});
      S.ctx = null;
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: true, outcome: 'opened' });
      const exp = MSG[`confirm:${ex}`];
      expect(exp, 'fixture').toBeTruthy();
      expect(S.fmt[`confirm:${ex}`].args, 'format_trade_result inputs').toEqual(exp.inputs.args);
      expect(r.body.message).toBe(exp.text);
      expect(tradeNotes(uid).map((n) => n.body)).toEqual([exp.text]);    // «⏳ Размещаю ордер…» was deleted
      const pos = positionsOf('confirm', ex);
      expect(pos).toHaveLength(1);
      expect(pos[0]).toMatchObject({ base: BASE, side: 'LONG' });
      const orders = S.fake.orders(ex, keyOf('confirm', ex));
      const sl = ex === 'bybit' ? pos[0].sl : orders.filter((o) => o.type === 'STOP').map((o) => o.trigger)[0];
      expect(sl).toBeGreaterThan(7889);
      expect(sl).toBeLessThan(7890);
      const row = trade(uid);
      expect(row.order_id).not.toBe('');
      expect(row.exchange).toBe(ex);                    // D17
      expect(row.state).toBe('PENDING');                // kept: exec_trade never moves the state
      expect(row.qty).toBe(0);                          // kept: exec_trade does not store qty
      expect(cardOf(uid)).toEqual({ html: MSG.i18n.exec_opening, actions: null, lang: 'ru' });   // «⏳ Открываю сделку…», no buttons
      const g = await api('get', 'positions', uid);
      expect(g.body.positions.map((p) => [p.symbol, p.side])).toEqual([[BASE, 'LONG']]);
      // a second press: the button is gone → 404 before any work, nothing sent (D16)
      const n = S.fake.requests.length;
      expect((await api('post', `trades/${tid(uid)}/exec`, uid, {})).status).toBe(404);
      expect(S.fake.requests.length).toBe(n);
      expect(positionsOf('confirm', ex)).toHaveLength(1);
      expect(S.fake.unhandled).toEqual([]);
    });
  }

  it('confirm: the exec gate (D5) — AUTOTRADE_ENABLED off / exchange not enabled → nothing sent, the card keeps its button', async () => {
    const tryExec = async (ex) => {
      const uid = uidOf('expiry', ex);
      const n = S.fake.requests.length;
      const r = await api('post', `trades/${tid(uid)}/exec`, uid, {});
      expect(S.fake.requests.length).toBe(n);
      expect(callbacks(cardOf(uid))).toContain(`exec_trade_${trade(uid).trade_id}`);
      expect(trade(uid).order_id).toBe('');
      return r.body;
    };
    try {
      S.configureOps({ AUTOTRADE_ENABLED: '0', AUTOTRADE_EXCHANGES: 'bybit,bingx,binance,okx' });
      for (const ex of EXCHANGES) {
        expect(await tryExec(ex)).toMatchObject({
          ok: false, outcome: 'autotrade_disabled', alert: { text: '⛔ Автоторговля на сайте сейчас выключена — сделка не открыта.', show_alert: true },
        });
      }
      S.configureOps({ AUTOTRADE_ENABLED: '1' });     // the D5 default: bybit, bingx
      for (const ex of ['binance', 'okx']) {
        expect(await tryExec(ex)).toMatchObject({ ok: false, outcome: 'exchange_not_enabled' });
      }
    } finally {
      S.configureOps(ENV_ON);
    }
  });

  for (const ex of EXCHANGES) {
    it(`${ex} confirm: killswitch HALTED_ALL → the trader refuses before any request (killswitch_halted)`, async () => {
      const uid = uidOf('halt', ex);
      await S.killswitch.setState('HALTED_ALL', { reason: 'e2e', actorUid: 1 });
      try {
        S.ctx = 'halt';
        const n = S.fake.requests.length;
        const r = await api('post', `trades/${tid(uid)}/exec`, uid, {});
        expect(S.fake.requests.length).toBe(n);
        expect(r.body).toMatchObject({ ok: false, outcome: 'failed' });
        const exp = MSG[`halt:${ex}`];
        expect(exp, 'fixture').toBeTruthy();
        expect(S.fmt[`halt:${ex}`].args).toEqual(exp.inputs.args);
        expect(exp.inputs.args[0]).toEqual({ ok: false, order_id: '', error: 'killswitch_halted: HALTED_ALL' });
        expect(r.body.message).toBe(exp.text);
        expect(trade(uid).order_id).toBe('');
        // kept: the bot's card edit already removed the button («⏳ Открываю сделку…»)
        expect(cardOf(uid)).toEqual({ html: MSG.i18n.exec_opening, actions: null, lang: 'ru' });
      } finally {
        S.ctx = null;
        await S.killswitch.setState('ACTIVE', { reason: '', actorUid: 1 });
      }
      expect(orderRequests('halt', ex)).toEqual([]);
    });
  }

  // ═══ expiry ═══
  it('expiry: the tracker closes the pending signals on time (72 h) and keeps their keyboard (bot)', async () => {
    S.clock.t = T0 + 72 * 3600 + 60;
    const n = await S.tracker.expireStale({ lastPrice: async () => LAST_PRICE }, S.clock.t);
    expect(n).toBeGreaterThanOrEqual(EXCHANGES.length + 1);
    for (const g of ['expiry', 'window']) {
      for (const ex of GROUPS[g].exchanges) {
        const row = trade(uidOf(g, ex));
        expect(row.progress_stage, `${g} ${ex}`).toBe('EXPIRED');
        expect(row.result).toBe('');
        const c = cardOf(uidOf(g, ex));
        expect(c.html).toContain('⏱');
        expect(callbacks(c)).toContain(`exec_trade_${row.trade_id}`);
      }
    }
  });

  it('expiry: pinned bot quirk — an exec between the tracker\'s EXPIRED and the ghost pass still places (no age check)', async () => {
    const uid = uidOf('window', 'bybit');
    S.ctx = 'window';
    const r = await api('post', `trades/${tid(uid)}/exec`, uid, {});
    S.ctx = null;
    expect(r.body).toMatchObject({ ok: true, outcome: 'opened' });
    expect(r.body.message).toBe(MSG['window:bybit'].text);
    expect(positionsOf('window', 'bybit')).toHaveLength(1);
  });

  it('expiry: the 3-day ghost cleanup marks the pending rows SKIP — exec answers «уже была открыта», nothing ever sent', async () => {
    S.clock.t = T0 + 3 * 86400 + 120;
    const [noOrder, old] = S.GC.runGhostCleanup(S.db, { log: quiet, now: S.clock.t });
    expect(noOrder).toBe(0);                            // every pending card was delivered (signal_msg_id > 0)
    expect(old).toBeGreaterThanOrEqual(EXCHANGES.length);
    for (const ex of EXCHANGES) {
      const uid = uidOf('expiry', ex);
      expect(trade(uid)).toMatchObject({ result: 'SKIP', state: 'FAILED', skip_reason: 'ghost', order_id: '' });
      const n = S.fake.requests.length;
      const r = await api('post', `trades/${tid(uid)}/exec`, uid, {});
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: false, outcome: 'already_opened', card: MSG.i18n.exec_already_opened });
      expect(S.fake.requests.length).toBe(n);
      expect(cardOf(uid)).toEqual({ html: MSG.i18n.exec_already_opened, actions: null, lang: 'ru' });
      expect(orderRequests('expiry', ex)).toEqual([]);
      expect(positionsOf('expiry', ex)).toEqual([]);
    }
    expect(S.fake.unhandled).toEqual([]);
  });
});
