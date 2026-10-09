'use strict';
/**
 * harness.js — the JS twin of gen/gen_execute_vectors.py: builds the executor with the real
 * auto-trade modules over an in-memory site DB and FAKE exchange traders on a virtual clock,
 * records trader calls / messages / side effects / INFO+ logs per logical task exactly like the
 * Python driver, and dumps the same DB slices.
 *
 *   const env = buildEnv(vector.case, fixture)   →  { exec, run(), dump(), recs, ... }
 */

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const schema = require('../../../models/engineSchema');
const { createSignalTradesRepo } = require('../../../services/engine/signalTradesRepo');
const { createTradeDb } = require('../../../services/autotrade/tradeDb');
const { createKillswitch } = require('../../../services/autotrade/killswitch');
const { createCooldowns } = require('../../../services/autotrade/cooldowns');
const { createIdempotency } = require('../../../services/autotrade/idempotency');
const { createReconcile } = require('../../../services/autotrade/reconcile');
const { createCorrelationCap } = require('../../../services/autotrade/correlationCap');
const { createAdaptiveSizing } = require('../../../services/autotrade/adaptiveSizing');
const { createTiltDetector } = require('../../../services/autotrade/tiltDetector');
const { createSkipNotify } = require('../../../services/autotrade/skipNotify');
const { createAdminAlerts } = require('../../../services/autotrade/adminAlerts');
const { createAiFilter } = require('../../../services/autotrade/aiFilter');
const { createExecutor } = require('../../../services/autotrade/executeAutoTrade');
const { createAutoTrade, ALL_EXCHANGES } = require('../../../services/autotrade');
const { readConfig } = require('../../../services/autotrade/config');
const { regimeWarningText } = require('../../../services/autotrade/messages');
const asyncio = require('../../../services/autotrade/asyncio');
const { MODULES, PMULT } = require('../../../services/autotrade/traders');
const { resolveExchange } = require('../../../services/exchanges');
const { createBalanceCache } = require('../../../services/exchanges/balanceCache');
const { parseCtxRisk, ctxLabel } = require('../../../services/engine/trendMonitor');
const marketRegime = require('../../../strategies/common/marketRegime');
const { Frame } = require('../../../strategies/common/frame');
const { pyTruthy } = require('../../../services/exchanges/pyCompat');
const { createVClock } = require('./vclock');

const FIXTURE = path.join(__dirname, 'fixtures', 'execute_vectors.json.gz');

function loadFixture(file = FIXTURE) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
}

const PY_NAME = {
  placeTrade: 'place_trade', placeTradeSplit: 'place_trade_split', getBalance: 'get_balance', getPositions: 'get_positions',
  getOpenOrders: 'get_open_orders', cancelAllOrders: 'cancel_all_orders', getLastPrice: 'get_last_price',
  setTrailingSl: 'set_trailing_sl', placeSlTpForPosition: 'place_sl_tp_for_position', placeTpOrders: 'place_tp_orders',
  getFundingRate: 'get_funding_rate', getSpreadPct: 'get_spread_pct',
};
const OPT_FNS = new Set(['placeTrade', 'placeTradeSplit']);
const SNAKE = {
  tp2: 'tp2', tp3: 'tp3', riskMode: 'risk_mode', orderType: 'order_type', tradeId: 'trade_id', userId: 'user_id',
  allowLowNotionalBoost: 'allow_low_notional_boost', demo: 'demo', passphrase: 'passphrase',
};
const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && v.constructor === Object;

/** Bind a JS trader call (positional + trailing opts for placeTrade*) to the Python signature. */
function bindCall(sig, jsName, args) {
  let pos = args.slice();
  let kw = {};
  if (OPT_FNS.has(jsName) && pos.length && isPlain(pos[pos.length - 1])) kw = pos.pop();
  while (pos.length && pos[pos.length - 1] === undefined) pos.pop();
  const out = {};
  const named = sig.filter((p) => p[1] === 'POSITIONAL_OR_KEYWORD' || p[1] === 'POSITIONAL_ONLY');
  const varKw = sig.find((p) => p[1] === 'VAR_KEYWORD');
  pos.forEach((v, i) => {
    if (i < named.length) out[named[i][0]] = v === undefined ? named[i][2] : v;
    else out.__bind_error__ = `too many positional arguments (${pos.length})`;
  });
  for (const [k, v] of Object.entries(kw)) {
    if (v === undefined) continue;
    const n = SNAKE[k] || k;
    if (sig.some((p) => p[0] === n && p[1] !== 'VAR_KEYWORD' && p[1] !== 'VAR_POSITIONAL')) out[n] = v;
    else if (varKw) (out[varKw[0]] = out[varKw[0]] || {})[n] = v;
    else out.__bind_error__ = `unexpected keyword argument '${n}'`;
  }
  for (const p of sig) {
    if (Object.prototype.hasOwnProperty.call(out, p[0])) continue;
    if (p[1] === 'VAR_KEYWORD') out[p[0]] = {};
    else if (p[1] === 'VAR_POSITIONAL') out[p[0]] = [];
    else if (p[2] && p[2].__nodefault__) out.__bind_error__ = `missing a required argument: '${p[0]}'`;
    else out[p[0]] = p[2];
  }
  return JSON.parse(JSON.stringify(out));
}

function mkErr(spec) {
  const type = spec.type || 'Exception';
  if (type === 'TimeoutError') return new asyncio.TimeoutError(spec.raise);
  const e = new Error(spec.raise);
  e.pyType = type;
  e.name = type;
  return e;
}

function engineDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)');
  db.exec(schema.traderSettingsDDL());
  db.exec(schema.signalTradesDDL());
  db.exec(schema.ENGINE_KV_DDL);
  db.exec(schema.TRADE_EVENTS_DDL);
  return db;
}

const TS_COLS = new Set(['user_id', ...schema.TRADER_SETTINGS_COLUMNS.map((c) => c[0])]);
const ROW_EXTRA = ['username', 'okx_passphrase'];

/**
 * opts.via = 'index' runs the case through the production entry point
 * (services/autotrade/index.js createAutoTrade, every exchange enabled) instead of createExecutor.
 */
function buildEnv(c, fx, { d6 = { executedOnReject: true, fixedAmountPercent: false }, via = 'executor', indexDeps = {} } = {}) {
  const clk = createVClock(c.clock);
  const now = clk.now;
  const recs = [];
  const tag = () => asyncio.currentTaskName();
  const rec = (kind, data) => recs.push([tag(), kind, clone(data)]);
  const mk = (level) => (msg) => {
    if (level === 'DEBUG') return;
    const s = String(msg);
    if (s.startsWith('[TG-SAFE]')) return;
    recs.push([tag(), 'log', [level, s]]);
  };
  const log = { debug: mk('DEBUG'), info: mk('INFO'), warning: mk('WARNING'), warn: mk('WARNING'), error: mk('ERROR'), exception: mk('ERROR') };

  // ── DB ──
  const db = engineDb();
  db.prepare('INSERT INTO engine_kv (key, value, updated_at) VALUES (?, ?, 0)').run('operational_state',
    JSON.stringify({ state: (c.ks || ['ACTIVE', ''])[0], reason: (c.ks || ['ACTIVE', ''])[1] }));
  // the users row the bot wrote (UserSettings.to_db + the case overrides): trader_settings gets
  // its columns, username / okx_passphrase (users table / exchange_keys on the site) ride along
  const userExtra = {};
  const urow = c.user_row || null;
  if (urow) {
    const cols = Object.keys(urow).filter((k) => TS_COLS.has(k));
    for (const k of ROW_EXTRA) if (Object.prototype.hasOwnProperty.call(urow, k)) userExtra[k] = urow[k];
    db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(urow.user_id, `u${urow.user_id}@x`);
    db.prepare(`INSERT INTO trader_settings (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...cols.map((k) => (typeof urow[k] === 'boolean' ? (urow[k] ? 1 : 0) : urow[k])));
  }
  for (const tr of c.trades) {
    const cols = Object.keys(tr);
    db.prepare(`INSERT INTO signal_trades (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((k) => tr[k]));
  }
  for (const [k, v] of Object.entries(c.kv || {})) db.prepare('INSERT INTO engine_kv (key, value, updated_at) VALUES (?, ?, 0)').run(k, v);
  const repo = createSignalTradesRepo({ db, now, log, onClosed: null });
  const tdb = createTradeDb({ db, now, log, repo, invalidateUserCache: () => {} });
  const kvStore = {
    get: (k) => { const r = db.prepare('SELECT value FROM engine_kv WHERE key=?').get(String(k)); return r ? r.value : null; },
    set: (k, v) => tdb.kvSet(k, v),
  };

  // ── scripted traders ──
  const script = clone(c.script || {});
  if (c.ptp) script.ptp = clone(c.ptp);
  const take = (key, dflt) => {
    const q = script[key];
    if (!q || !q.length) return dflt;
    return q.length > 1 ? q.shift() : q[0];
  };
  async function respond(spec) {
    if (spec.hang) await asyncio.guardCancel(new Promise(() => {}));
    if (spec.after !== undefined) await asyncio.guardCancel(clk.sleep(spec.after));
    if (spec.raise !== undefined) throw mkErr(spec);
    return clone(spec.ret);
  }
  const handles = new Map();
  function traderFor(exchange) {
    const ex = resolveExchange(exchange);
    if (handles.has(ex)) return handles.get(ex);
    const mod = MODULES[ex];
    const h = { exchange: ex, mod, inst: null };
    for (const [js, py] of Object.entries(PY_NAME)) {
      const sig = (fx.sigs[ex] || {})[py];
      if (!sig) continue;
      h[js] = (...args) => {
        rec('call', [ex, py, bindCall(sig, js, args)]);
        return respond(take(`${ex}.${py}`, fx.defaults[`${ex}.${py}`] || fx.defaults[py]));
      };
    }
    h.formatTradeResult = (...a) => mod.formatTradeResult(...a);
    if (ex === 'bybit') h.formatTradeResultSplit = (...a) => mod.formatTradeResultSplit(...a);
    h.priceMultiplier = (sym) => PMULT[ex](sym);
    handles.set(ex, h);
    return h;
  }

  // ── Telegram ──
  const sendFail = c.send_fail || [];
  const kbRows = (kb) => (kb ? kb.map((row) => row.map((b) => [b.label, b.action])) : null);
  const sendMessage = async (_bot, uid, text, opts = {}) => {
    rec('msg', [uid, text, opts.parseMode === undefined ? null : opts.parseMode, kbRows(opts.replyMarkup)]);
    return !sendFail.some((s) => String(text).includes(s));
  };
  const bot = {
    async sendMessage(chatId, text, opts = {}) {
      rec('msg', [chatId, text, opts.parseMode === undefined ? null : opts.parseMode, kbRows(opts.replyMarkup)]);
      if (sendFail.some((s) => String(text).includes(s))) throw new Error('send failed');
      return true;
    },
  };
  const enqueueCritical = async (_bot, uid, text, { parseMode = 'HTML', reason = '' } = {}) => {
    rec('side', ['enqueue', uid, text, parseMode, reason]);
    return 'q1';
  };

  // ── collaborators ──
  const tasks = asyncio.createTaskGroup({ log });
  const adminAlerts = createAdminAlerts({ now, kvGet: tdb.kvGet, kvSet: tdb.kvSet, adminIds: async () => [123], log });
  const cooldowns = createCooldowns({
    now, kvSet: tdb.kvSet, kvItemsWithPrefix: tdb.kvItemsWithPrefix, tasks, log,
    setAutoTrade: tdb.setAutoTrade, invalidateUserCaches: async () => {}, sendMessage,
    alertAuthBreaker: adminAlerts.alertAuthBreaker,
  });
  let uuidN = 0;
  const idempotency = createIdempotency({
    now, uuidHex: () => { uuidN += 1; return uuidN.toString(16).padStart(8, '0') + '0'.repeat(24); },
    kvGet: tdb.kvGet, kvSet: tdb.kvSet, kvKeysWithPrefix: tdb.kvKeysWithPrefix, tasks, log,
  });
  const reconcile = createReconcile({ traderFor, log, sleep: clk.sleep, timers: clk.timers });
  const candles = c.candles || {};
  const cache = { getCandles: (sym, tf) => (candles[`${sym}|${tf}`] ? Frame.fromBars(candles[`${sym}|${tf}`]) : null) };
  const correlationCap = createCorrelationCap({ db, cache, now, log });
  const adaptiveSizing = createAdaptiveSizing({ db, cache, now, log });
  const tiltDetector = createTiltDetector({ db, now, log, sendMessage });
  const skipNotify = createSkipNotify({ now, log, sendMessage, enqueueCritical, env: {} });
  const regimeValue = Object.prototype.hasOwnProperty.call(c, 'regime') ? c.regime : 'ranging';
  const regime = {
    getCachedRegime: () => regimeValue,
    detectRegime: (df) => marketRegime.detectRegime(df),
    regimeAllowsDirection: marketRegime.regimeAllowsDirection,
    regimeWarningText,
  };
  const aiFilter = createAiFilter({
    getCachedRegime: () => regimeValue, regimeAllowsDirection: marketRegime.regimeAllowsDirection,
    getLastMutationInfo: () => clone(c.mutation_info === undefined ? null : c.mutation_info),
    env: { AI_FILTER_ENABLED: '1' }, log,
  });
  const balanceCache = createBalanceCache({ getTrader: () => { throw new Error('no keys in the view'); }, now, log });
  const CTX = parseCtxRisk({});
  const trend = {
    ctxRiskMult: (ctx) => { const k = pyTruthy(ctx) ? String(ctx) : ''; return Object.prototype.hasOwnProperty.call(CTX, k) ? Number(CTX[k]) : 1.0; },
    ctxLabel: (ctx) => ctxLabel(ctx, 'ru'),
  };
  const config = { ...readConfig({}), ...(c.config || {}) };
  const killswitch = createKillswitch({ kv: kvStore, monotonic: clk.mono, now, log });

  // ── seeded module state ──
  const st = c.state || {};
  for (const [uid, ex, until] of st.zb || []) cooldowns._zeroBalanceUntil.set(`${uid}|${ex}`, until);
  for (const [uid, sym, until] of st.commodity || []) cooldowns._commodityBlocklist.set(`${uid}|${sym}`, until);
  for (const [uid, ex, tss] of st.auth_log || []) cooldowns._authFailLog.set(`${uid}|${ex}`, tss.slice());
  for (const [uid, ex, bal, exp] of st.balance_cache || []) balanceCache._cache.set(`${uid}|${ex}`, [bal, exp]);
  for (const [uid, tss] of st.unfilled || []) skipNotify._userUnfilled.set(uid, tss.slice());

  const make = via === 'index'
    ? (deps) => {
      const at = createAutoTrade({ ...deps, tradeDb: tdb, exchanges: ALL_EXCHANGES, bot: null, onConfirmPending: null, ...indexDeps });
      return { ...at._exec, executeAutoTrade: at.executeAutoTrade, _autoTrade: at };
    }
    : createExecutor;
  const exec = make({
    db: tdb, traderFor, killswitch, cooldowns, idempotency, reconcile, tasks, correlationCap, adaptiveSizing,
    tiltDetector, skipNotify, adminAlerts, aiFilter, balanceCache, log, now, sleep: clk.sleep, timers: clk.timers,
    env: c.env || {}, config,
    isAdmin: async (uid) => Number(uid) === 123,
    getUserRow: async (uid) => {
      const r = await tdb.getUser(uid);
      if (!r) return null;
      const out = { ...r };
      for (const k of ROW_EXTRA) out[k] = Object.prototype.hasOwnProperty.call(userExtra, k) ? (userExtra[k] === null && k === 'okx_passphrase' ? '' : userExtra[k]) : (k === 'okx_passphrase' ? '' : null);
      return out;
    },
    sendMessage, enqueueCritical,
    exchangeSymbols: {
      isSymbolAvailable: (ex, sym, { strict = false } = {}) => {
        rec('side', ['symbol_check', ex, sym, strict]);
        const v = c.symbol_ok === undefined ? true : c.symbol_ok;
        if (v === 'raise') throw new Error('symbol cache broken');
        return v;
      },
      recordSkip: (ex, sym) => rec('side', ['record_skip', ex, sym]),
    },
    regime, cache, trend,
    challengeGate: async (uid) => {
      rec('side', ['challenge_gate', uid]);
      const spec = c.challenge === undefined ? null : c.challenge;
      if (spec && typeof spec === 'object') throw new Error(spec.raise);
      return spec;
    },
    emitMutation: async (type, o) => { rec('side', ['mutation', type, o]); return true; },
    userLog: {
      tradeBlocked: (uid, username, sym, dir, reason) => rec('side', ['user_log_blocked', uid, username, sym, dir, reason]),
      tradeOpen: (uid, username, sym, dir, kw) => rec('side', ['user_log_open', uid, username, sym, dir, kw]),
    },
    funnelTrackOnce: async (event, uid, tags) => { rec('side', ['funnel', event, uid, tags]); return true; },
    recordLeverageCap: () => rec('side', ['leverage_cap']),
    partialTp: {
      placePartialTpOrders: async (kw) => {
        const k2 = {};
        for (const [k, v] of Object.entries(kw)) k2[k] = k === 'user' ? '<user>' : (k === 'bot' && v !== null && v !== undefined ? '<bot>' : v);
        rec('side', ['partial_tp', k2]);
        return respond(take('ptp', { ret: true }));
      },
    },
    d6,
  });

  for (const [uid, ts] of st.low_notional || []) exec._lowNotionalNotifyTs.set(uid, ts);

  async function run() {
    const results = new Array(c.calls.length).fill(null);
    const one = async (i, kw) => {
      const kw2 = { ...kw, bot: kw.bot === false ? null : bot };
      try {
        results[i] = { ok: await asyncio.runAsTask(`call${i}`, () => exec.executeAutoTrade(kw2)) };
      } catch (e) {
        results[i] = { raised: [e.pyType || e.name, e.message] };
      }
    };
    const main = async () => {
      if (c.parallel) await Promise.all(c.calls.map((kw, i) => one(i, kw)));
      else for (let i = 0; i < c.calls.length; i++) await one(i, c.calls[i]);
    };
    await clk.run(main());
    await clk.run(tasks.drain());
    return results;
  }

  function dump() {
    const trades = db.prepare('SELECT trade_id, result, result_rr, state, state_changed_at, placement_attempts, order_id, pos_idx, '
      + 'qty, tp_placed, skip_reason, ai_filter_json FROM signal_trades ORDER BY trade_id').all();
    const users = db.prepare('SELECT user_id, auto_trade, prop_peak_balance, prop_last_trade_day, prop_trading_days, '
      + 'prop_day_start_balance FROM trader_settings ORDER BY user_id').all();
    const kv = {};
    for (const r of db.prepare('SELECT key, value FROM engine_kv ORDER BY key').all()) if (r.key !== 'operational_state') kv[r.key] = r.value;
    const events = db.prepare('SELECT trade_id, event_type, payload_json FROM trade_events ORDER BY id').all()
      .map((r) => [r.trade_id, r.event_type, r.payload_json]);
    return { trades, users, kv, events };
  }

  return { exec, run, dump, recs, clk, db, tasks };
}

/** recs → {task: [[kind, data], …]} */
function byTask(recs) {
  const out = {};
  for (const [t, kind, data] of recs) (out[t] = out[t] || []).push([kind, data]);
  return out;
}

module.exports = { loadFixture, buildEnv, bindCall, byTask, FIXTURE };
