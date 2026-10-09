'use strict';
/**
 * world.js — the money-safety test world (tests/autotrade/safety): the site's real auto-trade,
 * trade-ops and key code over a temp site DB and the stateful fake exchanges of the E2E
 * (tests/autotrade/e2e/fakeExchanges.js — signatures checked, orders matched, NO network), with a
 * fault-injecting transport in front of them and the core differential's virtual clock for the
 * executor's wait_for timeouts.
 *
 * The caller sets the env (DATABASE_PATH, JWT / wallet secrets) BEFORE requiring this module.
 *
 *   createWorld({ duplicateClientIds }) → {
 *     db, ts, keysSvc, clk, fake, faults, quiet, msgs, logs,
 *     user(uid, ex, {mode, ...settings}) → {uid, ex, key, secret, passphrase}   (keys stored encrypted)
 *     signal(u, {trade_id, ...}) → the PENDING signal_trades row the scanner inserts
 *     autoTrade({d18, killswitch, ...}) → createAutoTrade over the fake exchanges + virtual clock
 *     kw(u, row, extra) → the scanners' execute_auto_trade kwargs
 *     run(promise) → drive the virtual clock until it settles
 *     opsRegistry({killswitch}) → the trade-ops trader registry (the bot's hooks) on the fake exchanges
 *     row(tid) · entries(u) · orderReqs(u) · positions(u) · orders(u) · maxLong(u)
 *   }
 *
 * Faults (`faults.add({...})`, each fires `times` times, default 1):
 *   on      'entry' | 'read' | 'close' | 'any' | fn(peek) — which request
 *   kind    'lost-before'   the request never reaches the exchange and never answers (a dead link)
 *           'lost-after'    the exchange processes it, the answer never arrives (timeout-after-accept)
 *           'connect-error' a connect failure (never reached the exchange)
 *           'reset-after'   processed, then the connection resets (ServerDisconnectedError)
 *           'hold'          held until `fault.release()`, then sent (a slow exchange)
 *   afterEntry  armed only once an entry request has gone out (the C78 double-check reads)
 *   ex / key    restrict to one exchange / one account
 */

const { createFakeExchanges } = require('../e2e/fakeExchanges');
const { TransportError } = require('../../../services/exchanges/transport');
const { memoryKv } = require('../../../services/exchanges/runtime');
const { createVClock } = require('../core/vclock');

const EXCHANGES = Object.freeze(['bybit', 'bingx', 'binance', 'okx']);
const BASE = 'SAFE';
const SYM = 'SAFE-USDT-SWAP';
const PRICE = 100;          // the signal's entry
const LAST = 99.9;          // the exchange's last price: the 0.05 %-improved LONG limit (99.95) is marketable
const T0 = 1767186000;
// every request that creates / changes / cancels an order or a position (the rest only reads)
const ORDER_PATHS = /\/v5\/order\/|\/v5\/position\/(set-leverage|switch-isolated|trading-stop)|\/openApi\/swap\/v2\/trade\/|\/fapi\/v1\/(order|batchOrders|leverage|positionSide\/dual|allOpenOrders)|\/api\/v5\/trade\/|\/api\/v5\/account\/set-leverage/;

const quietLog = () => {
  const lines = [];
  const mk = (level) => (...a) => { lines.push(`[${level}] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`); };
  const log = { debug: mk('debug'), info: mk('info'), warning: mk('warning'), warn: mk('warning'), error: mk('error'), critical: mk('error'), exception: mk('error') };
  return { log, lines };
};

/** The request as the fake exchange will parse it (exchange, method, path, query, body). */
function peek({ method, url, body }) {
  const u = new URL(url);
  const host = u.hostname;
  let ex = null;
  if (/(^|\.)bybit\.com$/.test(host)) ex = 'bybit';
  else if (host === 'open-api.bingx.com') ex = 'bingx';
  else if (/binance\.com$/.test(host)) ex = 'binance';
  else if (host === 'www.okx.com') ex = 'okx';
  const query = {};
  for (const [k, v] of u.searchParams) query[k] = v;
  let parsed = null;
  if (body !== undefined && body !== null && String(body)) { try { parsed = JSON.parse(String(body)); } catch (_e) { parsed = null; } }
  return { ex, host, method, path: u.pathname, query, body: parsed };
}

const notReduce = (v) => !(v === true || v === 'true');
/** The request that opens the entry (not a reduce-only / conditional / closing order). */
function isEntry(p) {
  if (p.ex === 'bybit') return p.path === '/v5/order/create' && p.body && notReduce(p.body.reduceOnly);
  if (p.ex === 'bingx') return p.method === 'POST' && p.path === '/openApi/swap/v2/trade/order' && ['MARKET', 'LIMIT'].includes(p.query.type) && notReduce(p.query.reduceOnly);
  if (p.ex === 'binance') {
    if (p.path === '/fapi/v1/batchOrders') return true;
    return p.method === 'POST' && p.path === '/fapi/v1/order' && ['MARKET', 'LIMIT'].includes(p.query.type) && notReduce(p.query.reduceOnly);
  }
  if (p.ex === 'okx') return p.path === '/api/v5/trade/order' && p.body && notReduce(p.body.reduceOnly);
  return false;
}
/** The C78 double-check reads (positions, open orders). */
function isRead(p) {
  return ['/v5/position/list', '/v5/order/realtime', '/openApi/swap/v2/user/positions', '/openApi/swap/v2/trade/openOrders',
    '/fapi/v2/positionRisk', '/fapi/v1/openOrders', '/api/v5/account/positions', '/api/v5/trade/orders-pending'].includes(p.path);
}
/** A position close (quick close). */
function isClose(p) {
  if (p.ex === 'okx') return p.path === '/api/v5/trade/close-position';
  if (p.ex === 'bybit') return p.path === '/v5/order/create' && p.body && !notReduce(p.body.reduceOnly);
  if (p.ex === 'bingx') return p.method === 'POST' && p.path === '/openApi/swap/v2/trade/order' && p.query.type === 'MARKET';
  if (p.ex === 'binance') return p.method === 'POST' && p.path === '/fapi/v1/order' && p.query.type === 'MARKET';
  return false;
}
const keyOf = (req) => {
  const h = req.headers || {};
  return h['X-BAPI-API-KEY'] || h['X-BX-APIKEY'] || h['X-MBX-APIKEY'] || h['OK-ACCESS-KEY'] || null;
};

function createFaults(fake) {
  const list = [];
  let entriesOut = 0;
  const log = [];
  const hang = () => new Promise(() => {});
  async function transport(req) {
    const p = peek(req);
    const entry = isEntry(p);
    const key = keyOf(req);
    let hit = null;
    for (const f of list) {
      if (f.left <= 0) continue;
      if (f.ex && f.ex !== p.ex) continue;
      if (f.key && f.key !== key) continue;
      if (f.afterEntry && entriesOut === 0) continue;
      const m = typeof f.on === 'function' ? f.on(p)
        : f.on === 'entry' ? entry : f.on === 'read' ? isRead(p) : f.on === 'close' ? isClose(p) : f.on === 'any';
      if (!m) continue;
      hit = f;
      break;
    }
    if (entry) entriesOut += 1;
    if (!hit) return fake.transport(req);
    hit.left -= 1;
    hit.hits += 1;
    log.push({ kind: hit.kind, ex: p.ex, path: p.path });
    if (hit.kind === 'hold') { await hit.gate; return fake.transport(req); }
    if (hit.kind === 'lost-before') return hang();
    if (hit.kind === 'connect-error') throw new TransportError('connect', `Cannot connect to host ${p.host}:443 ssl:default [Connect call failed ('${p.host}', 443)]`);
    const r = await fake.transport(req);
    if (hit.kind === 'lost-after') return hang();
    if (hit.kind === 'reset-after') throw new TransportError('error', 'Server disconnected', { pyType: 'ServerDisconnectedError' });
    return r;
  }
  return {
    transport,
    add(f) {
      const x = { times: 1, ...f };
      x.left = x.times;
      x.hits = 0;
      if (x.kind === 'hold') x.gate = new Promise((r) => { x.release = r; });
      list.push(x);
      return x;
    },
    clear() { list.length = 0; },
    log,
  };
}

function createWorld({ duplicateClientIds = true } = {}) {
  const db = require('../../../models/database');
  const ts = require('../../../services/traderSettingsService');
  const keysSvc = require('../../../services/exchangeKeysService');
  const AT = require('../../../services/autotrade');
  const { createKillswitch } = require('../../../services/autotrade/killswitch');

  const clk = createVClock(T0);
  const fake = createFakeExchanges({
    clock: { now: () => clk.now() },
    instruments: { [BASE]: { tick: 0.01, step: 0.001, minQty: 0.001, ctVal: 0.01, lotSz: 1, maxLev: 100 } },
    prices: { [BASE]: LAST },
    duplicateClientIds,
  });
  const faults = createFaults(fake);
  const { log: quiet, lines: logs } = quietLog();
  const msgs = [];
  const users = new Map();

  /** opts: {perms} the account's key permissions on the fake exchange (D15), {storeKeys: false} → the
   *  key is only on the exchange (the test adds it through a route). */
  function user(uid, ex, settings = {}, { perms = null, storeKeys = true } = {}) {
    db.prepare('INSERT OR IGNORE INTO users (id, email, password_hash, referral_code) VALUES (?, ?, ?, ?)').run(uid, `safe${uid}@x.test`, 'x', `S${uid}`);
    const u = ts.getOrCreate(uid, { now: clk.now() });
    Object.assign(u, {
      auto_trade: true, auto_trade_mode: 'auto', trade_exchange: ex, trade_risk_pct: 1.0, trade_leverage: 10,
      max_trades_limit: 10, sub_plan: 'pro', sub_status: 'active', sub_expires: clk.now() + 30 * 86400, lang: 'ru',
      partial_tp_enabled: true, hold_lock_enabled: false, active: true,
    }, settings);
    ts.save(u, { now: clk.now() });
    const k = { uid, ex, key: `${ex.toUpperCase()}SAFEKEY${uid}`, secret: `${ex}-safe-secret-${uid}`, passphrase: ex === 'okx' ? `Pp#${uid}` : '' };
    if (storeKeys) keysSvc.writeKeys(uid, ex, k.key, k.secret, k.passphrase);
    fake.addAccount(ex, { key: k.key, secret: k.secret, passphrase: k.passphrase, balance: 10000, perms });
    users.set(uid, k);
    return k;
  }

  let seq = 0;
  function signal(u, over = {}) {
    seq += 1;
    const row = {
      trade_id: `${u.uid}_safe_${seq}`, user_id: u.uid, symbol: SYM, direction: 'LONG', entry: PRICE, sl: 98.0, original_sl: 98.0,
      tp1: 102.0, tp2: 104.0, tp3: 106.0, created_at: clk.now(), state: 'PENDING', state_changed_at: clk.now(),
      strategy: 'LEVELS', breakout_type: 'LEVELS', timeframe: '1h', quality: 7, exchange: 'bybit', ...over,
    };
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO signal_trades (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]));
    return row;
  }

  function kw(u, r, extra = {}) {
    return {
      user_id: u.uid, symbol: r.symbol, direction: r.direction, entry: r.entry, sl: r.sl, tp1: r.tp1, tp2: r.tp2, tp3: r.tp3,
      trade_id: r.trade_id, api_key: u.key, api_secret: u.secret, risk_pct: 1.0, leverage: 10, auto_trade_mode: 'auto',
      max_trades: 10, strategy: r.strategy, exchange: u.ex, bybit_demo: false, order_type: 'Market', quality: 7, trend_ctx: '',
      ...extra,
    };
  }

  /** A memory kv for the killswitch (operational_state); `fail` → every read throws. */
  function ksStore() {
    const m = new Map();
    const st = { fail: false };
    return {
      st,
      kv: { get: (k) => { if (st.fail) throw new Error('database is locked'); return m.has(k) ? m.get(k) : null; }, set: (k, v) => m.set(k, String(v)) },
    };
  }

  /**
   * `clock` — another virtual clock for this executor (a doomed process: its timers are never
   * driven, so its placement stays frozen mid-flight while the rest of the world moves on).
   */
  function autoTrade({ d18, killswitch, clock = null, ...over } = {}) {
    const c = clock || clk;
    const ks = killswitch || createKillswitch({ kv: ksStore().kv, monotonic: c.mono, now: c.now, log: quiet, emitMutation: async () => false });
    return AT.createAutoTrade({
      env: { AUTOTRADE_EXCHANGES: EXCHANGES.join(',') }, log: quiet, now: c.now, sleep: c.sleep, timers: c.timers,
      bot: { sendMessage: async () => true, alertAdmins: async () => true },
      sendMessage: async (_bot, uid, text) => { msgs.push({ uid, text }); return true; },
      traderRuntime: { transport: faults.transport, sleep: c.sleep, now: c.now, monotonic: c.mono, kv: memoryKv(), log: quiet, env: {} },
      killswitch: ks,
      exchangeSymbols: { isSymbolAvailable: () => true, recordSkip: () => {} },
      cache: { getCandles: async () => null },
      regime: {
        getCachedRegime: () => 'ranging', detectRegime: () => 'ranging', regimeAllowsDirection: () => true, regimeWarningText: () => '',
      },
      trend: { ctxRiskMult: () => 1.0, ctxLabel: () => '' },
      aiFilter: { evaluateSignal: async () => ({ passed: true, layers: [], blocking_layers: [], confidence_score: 0, preset_name: null }) },
      balanceCache: { getCachedBalance: async () => null, gcCache: () => 0 },
      challengeGate: async () => null,
      adminAlerts: { sendAdminAlert: async () => true, alertSlStreak: async () => true, alertAuthBreaker: async () => true },
      isAdmin: () => false,
      d18,
      ...over,
    });
  }

  function opsRegistry({ killswitch = null } = {}) {
    const ks = killswitch || createKillswitch({ kv: ksStore().kv, log: quiet, emitMutation: async () => false });
    return AT.createTradeOpsRegistry({
      log: quiet, killswitch: ks,
      overrides: { transport: faults.transport, now: () => clk.now(), sleep: async () => {}, kv: memoryKv(), log: quiet, env: {} },
    });
  }

  const row = (tid) => db.prepare('SELECT * FROM signal_trades WHERE trade_id=?').get(String(tid));
  const reqsOf = (u) => fake.requests.filter((r) => r.ex === u.ex && r.key === u.key);
  return {
    db, ts, keysSvc, clk, fake, faults, quiet, logs, msgs, users, user, signal, kw, autoTrade, opsRegistry, ksStore, row,
    run: (p) => clk.run(p),
    /** entry requests that reached the exchange (and were not refused as duplicates) */
    entries: (u) => reqsOf(u).filter((r) => isEntry(r) && !/110072|-4116|101404|51016/.test(String(r.answer || ''))),
    entriesSent: (u) => reqsOf(u).filter((r) => isEntry(r)),
    orderReqs: (u) => reqsOf(u).filter((r) => ORDER_PATHS.test(r.path)),
    allReqs: (u) => reqsOf(u),
    positions: (u) => fake.positions(u.ex, u.key),
    orders: (u) => fake.orders(u.ex, u.key),
    maxLong: (u) => fake.maxSize(u.ex, u.key, BASE, 'LONG'),
    opens: (u) => fake.account(u.ex, u.key).opens,
  };
}

module.exports = { createVClock, createWorld, peek, isEntry, isRead, isClose, EXCHANGES, BASE, SYM, PRICE, LAST, T0, ORDER_PATHS };
