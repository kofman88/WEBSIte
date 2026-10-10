'use strict';
/**
 * harness.js — the JS twin of py/drive_wire_diff.py: one scenario through the PRODUCTION entry point
 * (services/autotrade/index.js createAutoTrade, every exchange enabled) with the REAL site traders
 * (services/exchanges/*Trader.js) and the real partial-TP / reconcile / cooldown / idempotency /
 * killswitch / plan-gate / challenge-gate modules, on an in-memory site DB and the virtual clock.
 *
 * The exchanges are the bot's recording: every request a JS trader sends goes to a REPLAY transport
 * that takes, per logical task (call<i>, partial_tp_<uid>_<sym>, limit_unfilled_guard_*, …), the next
 * request the bot sent in that task, serves the answer the bot got for it (bytes, a hang until the
 * client's own timeout, a refused connection) and records the JS request in the same normalised
 * shape (timestamps / signatures cut out; the signature is verified against the account secret).
 *
 *   const env = buildWireEnv(vector.case)   →  { run(), dump(), recs, at }
 */

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const schema = require('../../../models/engineSchema');
const { createSignalTradesRepo } = require('../../../services/engine/signalTradesRepo');
const { createTradeDb } = require('../../../services/autotrade/tradeDb');
const { createKillswitch } = require('../../../services/autotrade/killswitch');
const { createPlanGate } = require('../../../services/autotrade/planGate');
const { createIdempotency } = require('../../../services/autotrade/idempotency');
const { createAdminAlerts } = require('../../../services/autotrade/adminAlerts');
const { createAiFilter } = require('../../../services/autotrade/aiFilter');
const { createAutoTrade, ALL_EXCHANGES } = require('../../../services/autotrade');
const { readConfig } = require('../../../services/autotrade/config');
const { regimeWarningText } = require('../../../services/autotrade/messages');
const asyncio = require('../../../services/autotrade/asyncio');
const { createBalanceCache } = require('../../../services/exchanges/balanceCache');
const { TransportError, fetchError } = require('../../../services/exchanges/transport');
const { parseCtxRisk, ctxLabel } = require('../../../services/engine/trendMonitor');
const marketRegime = require('../../../strategies/common/marketRegime');
const { Frame } = require('../../../strategies/common/frame');
const { pyTruthy } = require('../../../services/exchanges/pyCompat');
const challengeService = require('../../../services/challengeService');
const { createVClock } = require('../core/vclock');

const FIXTURE = path.join(__dirname, 'fixtures', 'wire_diff.json.gz');

function loadFixture(file = FIXTURE) {
  const { pyJsonParse } = require('../../../services/engine/pyjson');
  return pyJsonParse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
}

const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const DROP_HDRS = new Set(['host', 'user-agent', 'accept-encoding', 'connection', 'content-length']);
const TS_HDRS = new Set(['x-bapi-timestamp', 'ok-access-timestamp']);
const SIG_HDRS = new Set(['x-bapi-sign', 'ok-access-sign']);
const MARKER_RE = /\[[A-Z][A-Z0-9_-]*[A-Z0-9]\]/g;

function okxIsoMs(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/.exec(String(s));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]);
}

/** drive_wire_diff.norm_request, same fields. */
function normRequest({ method, url, headers, body, timeoutMs }, wallNow) {
  const u = new URL(url);
  const q = u.search ? u.search.slice(1) : '';
  let tsMs = null;
  const m = /(?:^|&)timestamp=(\d+)/.exec(q);
  if (m) tsMs = Number(m[1]);
  const qsig = /(?:^|&)signature=/.test(q);
  const q2 = q.replace(/(^|&)(timestamp|signature)=[^&]*/g, '').replace(/^&+/, '');
  const hdrs = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const kl = k.toLowerCase();
    if (DROP_HDRS.has(kl)) continue;
    if (TS_HDRS.has(kl)) {
      tsMs = kl === 'x-bapi-timestamp' && /^\d+$/.test(String(v)) ? Number(v) : okxIsoMs(v);
      hdrs[kl] = '<ts>';
      continue;
    }
    if (SIG_HDRS.has(kl)) { hdrs[kl] = '<sig>'; continue; }
    hdrs[kl] = v;
  }
  const sorted = {};
  for (const k of Object.keys(hdrs).sort()) sorted[k] = hdrs[k];
  return {
    method,
    origin: `${u.protocol}//${u.host}`,
    target: u.pathname + (q2 ? `?${q2}` : ''),
    body: body === undefined || body === null || body === '' ? null : String(body),
    headers: sorted,
    qsig,
    ts_delta: tsMs === null ? null : tsMs - Math.round(wallNow * 1000),
    timeout: timeoutMs === undefined || timeoutMs === null ? null : timeoutMs / 1000,
  };
}

/** The simulator's signature check (fake_exchanges._sig_ok) on the JS request. */
function sigOk(accounts, { method, url, headers, body }) {
  const u = new URL(url);
  const host = u.hostname;
  const rawQs = u.search ? u.search.slice(1) : '';
  const hl = {};
  for (const [k, v] of Object.entries(headers || {})) hl[k.toLowerCase()] = v;
  let ex = null;
  if (host.endsWith('bybit.com')) ex = 'bybit';
  else if (host === 'open-api.bingx.com') ex = 'bingx';
  else if (host.endsWith('binance.com')) ex = 'binance';
  else if (host === 'www.okx.com') ex = 'okx';
  if (!ex) return null;
  const keyHdr = { bybit: 'x-bapi-api-key', bingx: 'x-bx-apikey', binance: 'x-mbx-apikey', okx: 'ok-access-key' }[ex];
  const a = accounts.find((x) => x.ex === ex && x.key === hl[keyHdr]);
  if (!a) return null;
  const hmacHex = (pre) => crypto.createHmac('sha256', Buffer.from(a.secret, 'utf8')).update(Buffer.from(pre, 'utf8')).digest('hex');
  const rawBody = body === undefined || body === null ? '' : String(body);
  if (ex === 'bybit') {
    if (!('x-bapi-sign' in hl)) return null;
    const payload = method === 'GET' ? rawQs : rawBody;
    return hmacHex(String(hl['x-bapi-timestamp']) + a.key + String(hl['x-bapi-recv-window']) + payload) === hl['x-bapi-sign'];
  }
  if (ex === 'bingx' || ex === 'binance') {
    if (!rawQs.includes('&signature=') && !rawQs.startsWith('signature=')) return null;
    const i = rawQs.lastIndexOf('signature=');
    let unsigned = rawQs.slice(0, i);
    if (unsigned.endsWith('&')) unsigned = unsigned.slice(0, -1);
    return hmacHex(unsigned) === rawQs.slice(i + 'signature='.length);
  }
  if (!('ok-access-sign' in hl)) return null;
  const pre = String(hl['ok-access-timestamp']) + method + u.pathname + (rawQs ? `?${rawQs}` : '') + rawBody;
  const want = crypto.createHmac('sha256', Buffer.from(a.secret, 'utf8')).update(Buffer.from(pre, 'utf8')).digest('base64');
  return want === hl['ok-access-sign'] && hl['ok-access-passphrase'] === a.passphrase;
}

function engineDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, telegram_username TEXT)');
  db.exec(schema.traderSettingsDDL());
  db.exec(schema.signalTradesDDL());
  db.exec(schema.ENGINE_KV_DDL);
  db.exec(schema.TRADE_EVENTS_DDL);
  return db;
}

const TS_COLS = new Set(['user_id', ...schema.TRADER_SETTINGS_COLUMNS.map((c) => c[0])]);

/**
 * opts.onRequest(task, jsReq, botEntry) — hook for the test (default: none).
 * opts.d6 / opts.d17 default to the bot-mode switches (the differential runs the bot's behaviour).
 * opts.d18 — the D18 site guards (docs/PORT_DECISIONS.md): omitted → the site's defaults (production);
 * `BOT_D18` → the bot's behaviour (for a scenario that reaches a D18 branch — the bot never sent the
 * requests such a branch adds, so its recording cannot answer them).
 */
function buildWireEnv(c, opts = {}) {
  const clk = createVClock(c.clock);
  const now = clk.now;
  const recs = [];
  const tag = () => asyncio.currentTaskName();
  const rec = (kind, data) => recs.push([tag(), kind, clone(data)]);
  const mkLog = (into) => {
    const mk = (level) => (msg) => {
      if (level === 'DEBUG') return;
      const s = String(msg);
      if (s.startsWith('[TG-SAFE]')) return;
      into(level, s);
    };
    return {
      debug: mk('DEBUG'), info: mk('INFO'), warning: mk('WARNING'), warn: mk('WARNING'), error: mk('ERROR'), exception: mk('ERROR'),
      critical: mk('CRITICAL'),
    };
  };
  const log = mkLog((level, s) => recs.push([tag(), 'log', [level, s]]));
  const traderLog = mkLog((level, s) => {
    const ms = s.match(MARKER_RE);
    if (ms) recs.push([tag(), 'tlog', [level, ms]]);
  });

  // ── DB ──
  const db = engineDb();
  db.prepare('INSERT INTO engine_kv (key, value, updated_at) VALUES (?, ?, 0)').run('operational_state',
    JSON.stringify({ state: (c.ks || ['ACTIVE', ''])[0], reason: (c.ks || ['ACTIVE', ''])[1] }));
  const urow = c.user_row;
  const cols = Object.keys(urow).filter((k) => TS_COLS.has(k));
  db.prepare('INSERT INTO users (id, email, telegram_username) VALUES (?, ?, ?)').run(urow.user_id, `u${urow.user_id}@x`, urow.username || null);
  db.prepare(`INSERT INTO trader_settings (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map((k) => (typeof urow[k] === 'boolean' ? (urow[k] ? 1 : 0) : urow[k])));
  for (const tr of c.trades) {
    const tc = Object.keys(tr);
    db.prepare(`INSERT INTO signal_trades (${tc.join(', ')}) VALUES (${tc.map(() => '?').join(', ')})`).run(...tc.map((k) => tr[k]));
  }
  for (const [k, v] of Object.entries(c.kv || {})) db.prepare('INSERT INTO engine_kv (key, value, updated_at) VALUES (?, ?, 0)').run(k, v);
  const repo = createSignalTradesRepo({ db, now, log, onClosed: null });
  const tdb = createTradeDb({ db, now, log, repo, invalidateUserCache: () => {} });
  const kvStore = {
    get: (k) => { const r = db.prepare('SELECT value FROM engine_kv WHERE key=?').get(String(k)); return r ? r.value : null; },
    set: (k, v) => tdb.kvSet(k, v),
  };

  // ── the bot's recorded exchange traffic, per task ──
  const queues = new Map();
  for (const [task, kind, data] of c._expected_recs || []) {
    if (kind !== 'req') continue;
    if (!queues.has(task)) queues.set(task, []);
    queues.get(task).push(data);
  }
  const accounts = c.accounts || [];
  const transport = async (req) => {
    const task = tag();
    const jsReq = normRequest(req, now());
    jsReq.sig_ok = sigOk(accounts, req);
    const q = queues.get(task) || [];
    const bot = q.shift();
    if (opts.onRequest) opts.onRequest(task, jsReq, bot);
    recs.push([task, 'req', { req: jsReq }]);
    if (!bot) return { status: 404, headers: { 'content-type': 'text/plain' }, text: 'no route (bot sent nothing more in this task)', url: req.url };
    const r = bot.resp;
    const timeoutS = (req.timeoutMs === undefined ? 15000 : req.timeoutMs) / 1000;
    if (r.hang || (r.delay && r.delay >= timeoutS)) {
      // the answer never comes in time: the client's own timeout fires (fetchTransport's mapping)
      await clk.sleep(timeoutS);
      throw fetchError(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }), req.url, req.timeoutMs);
    }
    if (r.connect) throw new TransportError('connect', r.connect.aio, { requestsType: 'ConnectionError', requestsMessage: r.connect.req });
    if (r.delay) await clk.sleep(r.delay);
    const headers = {};
    for (const [k, v] of Object.entries(r.headers || {})) headers[k.toLowerCase()] = v;
    return { status: r.status, headers, text: r.text, url: req.url };
  };

  // ── Telegram ──
  const sendFail = c.send_fail || [];
  const kbRows = (kb) => (kb ? kb.map((row) => row.map((b) => [b.label, b.action])) : null);
  const sendMessage = async (_bot, uid, text, o = {}) => {
    rec('msg', [uid, text, o.parseMode === undefined ? null : o.parseMode, kbRows(o.replyMarkup)]);
    return !sendFail.some((s) => String(text).includes(s));
  };
  const bot = {
    async sendMessage(chatId, text, o = {}) {
      rec('msg', [chatId, text, o.parseMode === undefined ? null : o.parseMode, kbRows(o.replyMarkup)]);
      if (sendFail.some((s) => String(text).includes(s))) throw new Error('send failed');
      return true;
    },
  };
  const enqueueCritical = async (_bot, uid, text, { parseMode = 'HTML', reason = '' } = {}) => {
    rec('side', ['enqueue', uid, text, parseMode, reason]);
    return 'q1';
  };

  // ── collaborators at the test boundary (the Python driver fakes the same ones) ──
  const tasks = asyncio.createTaskGroup({ log });
  let uuidN = 0;
  const idempotency = createIdempotency({
    now, uuidHex: () => { uuidN += 1; return uuidN.toString(16).padStart(8, '0') + '0'.repeat(24); },
    kvGet: tdb.kvGet, kvSet: tdb.kvSet, kvKeysWithPrefix: tdb.kvKeysWithPrefix, tasks, log,
  });
  const adminAlerts = createAdminAlerts({ now, kvGet: tdb.kvGet, kvSet: tdb.kvSet, adminIds: async () => [123], log });
  const killswitch = createKillswitch({ kv: kvStore, monotonic: clk.mono, now, log });
  const isAdmin = async (uid) => Number(uid) === 123;
  const planGate = createPlanGate({ isAdmin, getUser: async (uid) => tdb.getUser(uid), log });
  const candles = c.candles || {};
  const cache = { getCandles: (sym, tf) => (candles[`${sym}|${tf}`] ? Frame.fromBars(candles[`${sym}|${tf}`]) : null) };
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
  const CTX = parseCtxRisk({});
  const trend = {
    ctxRiskMult: (ctx) => { const k = pyTruthy(ctx) ? String(ctx) : ''; return Object.prototype.hasOwnProperty.call(CTX, k) ? Number(CTX[k]) : 1.0; },
    ctxLabel: (ctx) => ctxLabel(ctx, 'ru'),
  };
  const keys = c.keys || {};
  const exchangeKeys = (uid, ex) => {
    if (Number(uid) !== Number(c.uid) || !keys[ex]) return ['', '', ''];
    return keys[ex].slice();
  };
  // bybit _reset_auto_trade_for_key: every holder of the key gets auto_trade=0
  const onAuthReset = async (exchange, apiKey) => {
    const uids = [];
    if (keys[exchange] && keys[exchange][0] === apiKey) uids.push(Number(c.uid));
    for (const uid of uids) await tdb.setAutoTrade(uid, false);
    return uids;
  };
  challengeService.configure({
    clock: now,
    kv: { get: (k) => kvStore.get(k), set: (k, v) => kvStore.set(k, v), itemsWithPrefix: (p) => tdb.kvItemsWithPrefix(p) },
    // challengeService.dbRowsSince on this scenario's DB (same SQL)
    rowsSince: (uid, ts) => db.prepare(
      `SELECT ${challengeService.COLS} FROM signal_trades WHERE user_id=? AND created_at >= ? AND ${challengeService.COUNTABLE_SQL} ORDER BY created_at`,
    ).all(Number(uid), Number(ts)),
    log: { warn: (m) => log.warning(m), warning: (m) => log.warning(m), info: (m) => log.info(m), debug: () => {}, error: (m) => log.error(m) },
  });

  const at = createAutoTrade({
    db, tradeDb: tdb, repo, env: c.env || {}, log, now, sleep: clk.sleep, timers: clk.timers,
    exchanges: ALL_EXCHANGES, bot: null, onConfirmPending: null,
    exchangeKeys, isAdmin, killswitch, planGate, onAuthReset, tasks, idempotency, adminAlerts,
    traderRuntime: {
      transport, sleep: clk.sleep, timers: clk.timers, now, monotonic: clk.mono, log: traderLog, kv: kvStore, random: () => 0.5, env: {},
      metrics: { record: async (name, value = 1.0, tags = null) => { rec('metric', [name, value, tags === undefined ? null : tags]); } },
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
    regime, cache, trend, aiFilter,
    balanceCache: createBalanceCache({ getTrader: () => { throw new Error('no keys in the view'); }, now, log }),
    config: { ...readConfig({}), ...(c.config || {}) },
    emitMutation: async (type, o) => { rec('side', ['mutation', type, o]); return true; },
    userLog: {
      tradeBlocked: (uid, username, sym, dir, reason) => rec('side', ['user_log_blocked', uid, username, sym, dir, reason]),
      tradeOpen: (uid, username, sym, dir, kw) => rec('side', ['user_log_open', uid, username, sym, dir, kw]),
    },
    funnelTrackOnce: async (event, uid, tg) => { rec('side', ['funnel', event, uid, tg]); return true; },
    recordLeverageCap: () => rec('side', ['leverage_cap']),
    d6: opts.d6 || { executedOnReject: true, fixedAmountPercent: false },
    d17: opts.d17 || { recordExchange: false },
    d18: opts.d18,
  });
  const st = c.state || {};
  for (const [uid, ex, until] of st.zb || []) at._parts.cooldowns._zeroBalanceUntil.set(`${uid}|${ex}`, until);
  for (const [uid, ex, tss] of st.auth_log || []) at._parts.cooldowns._authFailLog.set(`${uid}|${ex}`, tss.slice());
  for (const [uid, sym, until] of st.commodity || []) at._parts.cooldowns._commodityBlocklist.set(`${uid}|${sym}`, until);

  async function run() {
    const results = new Array(c.calls.length).fill(null);
    const one = async (i, kw, stagger = 0) => {
      const kw2 = { ...kw, bot: kw.bot === false ? null : bot };
      if (stagger) await clk.sleep(stagger);
      try {
        results[i] = { ok: await asyncio.runAsTask(`call${i}`, () => at.executeAutoTrade(kw2)) };
      } catch (e) {
        results[i] = { raised: [e.pyType || e.name, e.message] };
      }
    };
    const main = async () => {
      if (c.parallel) {
        // signals 1 ms apart, like the Python driver (lock-arrival order = call order)
        await Promise.all(c.calls.map((kw, i) => one(i, kw, i * 0.001)));
      } else {
        for (let i = 0; i < c.calls.length; i++) {
          if (i && c.gap) await clk.sleep(c.gap);
          await one(i, c.calls[i]);
        }
      }
    };
    await clk.run(main());
    await clk.run(at.drain());
    return results;
  }

  function dump() {
    const trades = db.prepare('SELECT trade_id, result, result_rr, state, state_changed_at, placement_attempts, order_id, pos_idx, '
      + 'qty, tp_placed, skip_reason, ai_filter_json, be_set FROM signal_trades ORDER BY trade_id').all();
    const users = db.prepare('SELECT user_id, auto_trade, prop_peak_balance, prop_last_trade_day, prop_trading_days, '
      + 'prop_day_start_balance FROM trader_settings ORDER BY user_id').all();
    const kv = {};
    const hedge = {};
    for (const r of db.prepare('SELECT key, value FROM engine_kv ORDER BY key').all()) {
      if (r.key === 'operational_state') continue;
      if (r.key.startsWith('bybit_mode:')) { hedge[r.key.slice('bybit_mode:'.length)] = r.value === '1'; continue; }
      kv[r.key] = r.value;
    }
    const events = db.prepare('SELECT trade_id, event_type, payload_json FROM trade_events ORDER BY id').all()
      .map((r) => [r.trade_id, r.event_type, r.payload_json]);
    return { trades, users, kv, events, hedge };
  }

  return { run, dump, recs, clk, db, at, queues };
}

function byTask(recs) {
  const out = {};
  for (const [t, kind, data] of recs) (out[t] = out[t] || []).push([kind, data]);
  return out;
}

/** The bot's behaviour for the D18 site guards. */
const BOT_D18 = Object.freeze({ inflightGuard: false, reconcileFailedRetry: false });

module.exports = { BOT_D18, loadFixture, buildWireEnv, byTask, normRequest, sigOk, FIXTURE };
