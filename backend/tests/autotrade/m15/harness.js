'use strict';
/**
 * harness.js — the JS side of the M15 trade-ops loop replays (PLAN_M15 §3), twin of py/m15_harness.py.
 * Generic: the U1 tests use it, the U3-U10 replays build their drivers on it.
 *
 *   loadFixture(name)                 a fixtures/<name>.json.gz of a py/ driver (pyJsonParse + the
 *                                     `_jsonable` tags: {"__float__": "nan"|"inf"|"-inf"}, {"__bytes__"})
 *   setupSiteDb(name)                 BEFORE the first require of models/database: a temp site DB
 *                                     (all migrations) → { db, path, cleanup() }
 *   seedSite(db, seed)                the bot's seeded rows in the site tables: users (telegram_username,
 *                                     is_admin), trader_settings (the bot's raw users columns), exchange_keys
 *                                     (encrypted with WALLET_ENCRYPTION_KEY; '@undecryptable' → a ciphertext
 *                                     that fails), signal_trades (given columns only, insertion order), engine_kv
 *   dumpSiteDb(db, opts)              m15_harness.dump_db on the site tables (same shape)
 *   makeFakeTraders({calls, sigs, clock, labels, byTask})
 *                                     a `traderFor(ex, demo)` whose handles answer the bot's RECORDED calls in
 *                                     order per (ex, fn) (per (task, ex, fn) with byTask): every site call is
 *                                     bound to the bot function's signature (the bot→site positional map:
 *                                     positional args in the bot's parameter order, a trailing options object
 *                                     = the keyword-only parameters, camelCase → snake_case), compared with
 *                                     the bot's bound arguments and answered the same way (value / err_out /
 *                                     raise / latency / hang on the virtual clock, cancellable by waitFor and
 *                                     runInScope — vclockSleep: a cancelled latency / hang leaves no timer).
 *                                     Mismatches, extra and missing calls are collected:
 *                                     `problems()` (empty = the call sequences agree), `jsCalls`
 *   bindToSig(sig, args, labels)      that binding, alone
 *   makeDeliveryRecorder({clock, failOn, safeResults})
 *                                     the delivery facade: runtime `sendMessage(bot, uid, text, opts)` (safe
 *                                     send), `bot.sendMessage(chatId, text, opts)` (raw / admin alerts),
 *                                     `alertAdmins(text)`, `sendText(uid, text, opts)`; records in the Python
 *                                     shape {via, uid, text, parse_mode, kw}
 *   makeLogCapture(clock)             a logger (debug … critical, exception) → lines {t, task, level, msg, exc}
 *   createVClock (tests/autotrade/core/vclock.js, with runUntil(limitMono) for loop shells)
 *   vclockSleep(clock)                asyncio.sleep on the virtual clock that honours the cancel scope AND
 *                                     removes its timer when cancelled (asyncio's cancelled sleep handle):
 *                                     the sleep every driver passes as the site runtime's sleep (ctx.sleep,
 *                                     the trader runtime) — never cancellableSleep(clk.sleep), whose timer
 *                                     stays behind and moves the clock of the next clk.run step
 *   sameSet(a, b) / firstDiff(a, b)   order-insensitive comparison (emit_bg / create_task side effects of a
 *                                     pass, BE2-O10) / the first differing path of two JSON values
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const asyncio = require('../../../services/autotrade/asyncio');
const { createVClock } = require('../core/vclock');

const FIXTURES = path.join(__dirname, 'fixtures');
const SECRET_PARAMS = new Set(['api_key', 'api_secret', 'secret', 'passphrase', 'key']);
const DEFAULT_TRADE_DUMP_COLS = ['trade_id', 'result', 'result_rr', 'closed_pnl_usd', 'skip_reason', 'state', 'state_changed_at',
  'tp_placed', 'tp_retry_count', 'trail_level', 'be_set'];
const UNDECRYPTABLE = '@undecryptable';
const BAD_CIPHERTEXT = 'AAAAAAAAAAAAAAAA:AAAA:AAAAAAAAAAAAAAAAAAAAAA==';   // iv:ct:tag that never authenticates

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const snake = (k) => String(k).replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const camel = (k) => String(k).replace(/_([a-z0-9])/g, (_m, c) => c.toUpperCase());

/** The `_jsonable` tags of the Python side → JS values (NaN / ±Infinity, Buffers). */
function untag(v) {
  if (Array.isArray(v)) return v.map(untag);
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === '__float__') {
      if (v.__float__ === 'nan') return NaN;
      return v.__float__ === 'inf' ? Infinity : -Infinity;
    }
    if (keys.length === 1 && keys[0] === '__bytes__') return Buffer.from(v.__bytes__, 'hex');
    const out = {};
    for (const k of keys) out[k] = untag(v[k]);
    return out;
  }
  return v;
}

function loadFixture(name) {
  const { pyJsonParse } = require('../../../services/engine/pyjson');
  const file = name.endsWith('.gz') ? name : path.join(FIXTURES, `${name}.json.gz`);
  return untag(pyJsonParse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')));
}

/** JSON-shaped clone (undefined → null) for records. */
const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v, (_k, x) => (x === undefined ? null : x))));

// ── site DB ─────────────────────────────────────────────────────────────

/**
 * A temp site DB with every migration. Call BEFORE anything requires models/database (vitest runs each
 * test file in its own worker, so the env change is per file). Keeps the CI secrets when they are set.
 */
function setupSiteDb(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `m15-${name}-`));
  if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';
  if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'm15-test-jwt-secret-0123456789abcdef';
  if (!process.env.JWT_REFRESH_SECRET) process.env.JWT_REFRESH_SECRET = 'm15-test-refresh-secret-0123456789ab';
  if (!process.env.WALLET_ENCRYPTION_KEY) process.env.WALLET_ENCRYPTION_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  process.env.DATABASE_PATH = path.join(dir, 'site.db');
  process.env.DB_QUIET = '1';
  process.env.LOG_LEVEL = 'error';
  process.env.VITEST = 'true';
  const db = require('../../../models/database');
  return {
    db,
    path: process.env.DATABASE_PATH,
    cleanup() {
      try { db.close(); } catch (_e) { /* closed */ }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function bind(v) {
  const { bindValue } = require('../../../services/engine/signalTradesRepo');
  return bindValue(v);
}

function insertSiteUser(db, uid, { username = null, isAdmin = 0, locale = 'ru' } = {}) {
  db.prepare(`INSERT OR IGNORE INTO users (id, email, password_hash, referral_code, telegram_username, is_admin, locale)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(Number(uid), `m15u${uid}@x.test`, 'x', `M15R${uid}`, username, isAdmin ? 1 : 0, locale);
}

/** One exchange_keys row ('default'); '@undecryptable' fields get a ciphertext that fails to decrypt. */
function insertSiteKey(db, uid, ex, key, secret, passphrase = '', { label = 'default', createdAt = null } = {}) {
  const { encrypt } = require('../../../utils/crypto');
  const cfg = require('../../../config');
  const enc = (v) => (v === UNDECRYPTABLE ? BAD_CIPHERTEXT : encrypt(String(v === null || v === undefined ? '' : v), cfg.walletEncryptionKey));
  const pp = ex === 'okx' && passphrase !== '' && passphrase !== null && passphrase !== undefined ? enc(passphrase) : null;
  if (createdAt === null) {
    db.prepare(`INSERT INTO exchange_keys (user_id, exchange, api_key_encrypted, api_secret_encrypted, passphrase_encrypted, is_testnet, label)
                VALUES (?, ?, ?, ?, ?, 0, ?)`).run(Number(uid), ex, enc(key), enc(secret), pp, label);
  } else {
    db.prepare(`INSERT INTO exchange_keys (user_id, exchange, api_key_encrypted, api_secret_encrypted, passphrase_encrypted, is_testnet, label, created_at)
                VALUES (?, ?, ?, ?, ?, 0, ?, ?)`).run(Number(uid), ex, enc(key), enc(secret), pp, label, createdAt);
  }
}

/**
 * The bot's seeded state in the site tables:
 *   seed.usersRaw  bot `users` rows (SELECT *, key columns removed) → users + trader_settings
 *                  (trader_settings columns only; a NULL in a NOT NULL column keeps the column default)
 *   seed.users     the driver's user specs → exchange_keys from `keys` ({ex: [key, secret, pp]}; an
 *                  all-empty pair = no row, the bot's '' columns); seed.sitePlain[uid][ex] overrides
 *   seed.admins    user ids with users.is_admin = 1
 *   seed.trades    trade rows (given columns only, in order → the same rowids)
 *   seed.kv        [[key, value]] → engine_kv
 */
function seedSite(db, seed) {
  const schema = require('../../../models/engineSchema');
  const tsCols = new Map(schema.TRADER_SETTINGS_COLUMNS.map((c) => [c[0], c]));
  const admins = new Set((seed.admins || []).map(Number));
  const raw = seed.usersRaw || (seed.users || []).map((u) => ({ user_id: u.user_id, username: u.username === undefined ? null : u.username }));
  const tx = db.transaction(() => {
    for (const r of raw) {
      const uid = Number(r.user_id);
      insertSiteUser(db, uid, { username: r.username === undefined ? null : r.username, isAdmin: admins.has(uid) });
      const cols = Object.keys(r).filter((c) => tsCols.has(c) && r[c] !== null && r[c] !== undefined);
      db.prepare(`INSERT INTO trader_settings (user_id${cols.map((c) => `, ${c}`).join('')}) VALUES (?${cols.map(() => ', ?').join('')})`)
        .run(uid, ...cols.map((c) => bind(r[c])));
    }
    for (const u of seed.users || []) {
      const plain = ((seed.sitePlain || {})[String(u.user_id)]) || {};
      for (const [ex, kv0] of Object.entries(u.keys || {})) {
        const kv = plain[ex] || kv0;
        const [key, secret, pp = ''] = kv;
        if (!key && !secret) continue;
        insertSiteKey(db, u.user_id, ex, key, secret, pp);
      }
    }
    for (const t of seed.trades || []) {
      const cols = Object.keys(t);
      db.prepare(`INSERT INTO signal_trades (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => bind(t[c])));
    }
    for (const [k, v] of seed.kv || []) {
      db.prepare('INSERT OR REPLACE INTO engine_kv (key, value, updated_at) VALUES (?, ?, 0)').run(String(k), String(v));
    }
  });
  tx();
}

/** m15_harness.dump_db on the site tables. */
function dumpSiteDb(db, { tRef = null, tradeCols = DEFAULT_TRADE_DUMP_COLS, tradeIds = null, kvPrefix = null } = {}) {
  let where = '';
  let params = [];
  if (tradeIds) {
    where = ` WHERE trade_id IN (${tradeIds.map(() => '?').join(', ')})`;
    params = tradeIds.map(String);
  }
  const trades = db.prepare(`SELECT ${tradeCols.join(', ')} FROM signal_trades${where} ORDER BY rowid`).all(...params);
  if (tRef !== null) for (const r of trades) if (r.state_changed_at !== null && r.state_changed_at !== undefined) r.state_changed_at -= tRef;
  let kv = db.prepare('SELECT key, value FROM engine_kv ORDER BY key').all();
  if (kvPrefix !== null) kv = kv.filter((r) => r.key.startsWith(kvPrefix));
  const events = db.prepare(`SELECT trade_id, ts, event_type, payload_json FROM trade_events${where} ORDER BY id`).all(...params);
  let fb = [];
  try {
    fb = db.prepare(`SELECT * FROM trade_feedback${where} ORDER BY id`).all(...params).map((r) => {
      const o = { ...r };
      delete o.id;
      return o;
    });
  } catch (_e) { fb = []; }
  return { trades, kv, trade_events: events, trade_feedback: fb };
}

// ── virtual sleep ───────────────────────────────────────────────────────

/**
 * asyncio.sleep(s) on the virtual clock: CancelledError at once in a cancelled scope; cancelled while it
 * waits (waitFor timeout, runInScope abort) it rejects AND clears its vclock timer — like asyncio.sleep's
 * `finally: h.cancel()` — so clk.run(step) leaves the clock where the step ended (m15_harness.run does:
 * a cancelled TimerHandle never moves the virtual clock). The cleanup hangs on a side branch: the caller
 * sees exactly cancellableSleep's promise (same microtask hops).
 */
function vclockSleep(clock) {
  return (s) => {
    asyncio.checkCancelled();
    let h;
    const p = new Promise((resolve) => { h = clock.timers.setTimeout(resolve, Number(s) * 1000); });
    const g = asyncio.guardCancel(p);
    g.catch(() => clock.timers.clearTimeout(h));
    return g;
  };
}

// ── fake traders (the bot's recorded calls) ─────────────────────────────

/** A Python exception of the vectors as the site's error shape. */
function mkErr(spec) {
  const type = spec.type || 'Exception';
  if (type === 'TimeoutError') return new asyncio.TimeoutError(spec.msg || '');
  const { PyError } = require('../../../services/exchanges/pyCompat');
  return new PyError(type, spec.msg === undefined ? '' : String(spec.msg));
}

function maskValue(name, v, labels) {
  if (typeof v === 'string' && labels.has(v)) return labels.get(v);
  if (SECRET_PARAMS.has(name) && typeof v === 'string' && v) return '<secret>';
  return clone(v);
}

/**
 * A site call bound to the bot function's signature (sig = m15_harness.sig_json):
 * positional args → the POSITIONAL parameters in order; a trailing plain object → the KEYWORD_ONLY
 * parameters (camelCase keys accepted); defaults filled in. → { bound: [[name, value]], error, refs }
 * `refs` keeps the live argument objects (err_out list) for the answer.
 */
function bindToSig(sig, args, labels = new Map()) {
  const pos = args.slice();
  let kw = {};
  const kwOnly = sig.filter((p) => p[1] === 'KEYWORD_ONLY');
  if (kwOnly.length && pos.length && isPlain(pos[pos.length - 1])) kw = pos.pop();
  while (pos.length && pos[pos.length - 1] === undefined) pos.pop();
  const positional = sig.filter((p) => p[1] === 'POSITIONAL_ONLY' || p[1] === 'POSITIONAL_OR_KEYWORD');
  const refs = {};
  let error = null;
  if (pos.length > positional.length) error = `too many positional arguments (${pos.length} > ${positional.length})`;
  const kwSnake = {};
  for (const [k, v] of Object.entries(kw)) if (v !== undefined) kwSnake[snake(k)] = v;
  const bound = [];
  let pi = 0;
  for (const p of sig) {
    const [name, kind, dflt] = p;
    let v;
    if (kind === 'POSITIONAL_ONLY' || kind === 'POSITIONAL_OR_KEYWORD') {
      if (pi < pos.length) v = pos[pi];
      pi += 1;
    } else if (kind === 'KEYWORD_ONLY') {
      if (Object.prototype.hasOwnProperty.call(kwSnake, name)) {
        v = kwSnake[name];
        delete kwSnake[name];
      }
    } else if (kind === 'VAR_POSITIONAL') {
      v = [];
    } else if (kind === 'VAR_KEYWORD') {
      v = {};
    }
    if (v === undefined) {
      if (dflt && dflt.__nodefault__) {
        error = error || `missing a required argument: '${name}'`;
        v = null;
      } else {
        v = dflt;
      }
    }
    refs[name] = v;
    bound.push([name, maskValue(name, v, labels)]);
  }
  if (Object.keys(kwSnake).length && !error) error = `unexpected keyword argument '${Object.keys(kwSnake)[0]}'`;
  return { bound, error, refs };
}

/**
 * calls: the Python Fakes.calls ({i, t, mono, task, ex, fn, bound, answer}); sigs: Fakes.sigs
 * ({ex: {fn: {sig, async}}}); clock: createVClock; labels: {name: value} of the test credentials.
 */
function makeFakeTraders({ calls = [], sigs = {}, clock, labels = {}, byTask = false, pmult = null } = {}) {
  const labelMap = new Map(Object.entries(labels).map(([name, value]) => [value, name]));
  const queues = new Map();
  const qkey = (task, ex, fn) => (byTask ? `${task}|${ex}.${fn}` : `${ex}.${fn}`);
  for (const c of calls) {
    const k = qkey(c.task, c.ex, c.fn);
    if (!queues.has(k)) queues.set(k, []);
    queues.get(k).push(c);
  }
  const jsCalls = [];
  const mismatches = [];
  const extra = [];
  const sleep = vclockSleep(clock);
  const { PMULT, MODULES } = require('../../../services/autotrade/traders');

  function answer(ans, refs) {
    if (ans.err_out && Array.isArray(refs.err_out)) refs.err_out.push(...ans.err_out);
    if (ans.raise) throw mkErr(ans.raise);
    return clone(ans.value === undefined ? null : ans.value);
  }

  function method(ex, fn, spec) {
    return (...args) => {
      const task = asyncio.currentTaskName();
      const b = bindToSig(spec.sig, args, labelMap);
      const k = qkey(task, ex, fn);
      const q = queues.get(k) || [];
      const bot = q.shift();
      const rec = { t: clock.now(), mono: clock.mono(), task, ex, fn, bound: b.bound, error: b.error };
      jsCalls.push(rec);
      if (!bot) {
        extra.push(rec);
        const e = new Error(`m15 harness: the bot made no further ${ex}.${fn} call${byTask ? ` in task ${task}` : ''}`);
        e.pyType = 'HarnessError';
        if (!spec.async) throw e;
        return Promise.reject(e);
      }
      const same = JSON.stringify(b.bound) === JSON.stringify(bot.bound) && !b.error;
      if (!same) mismatches.push({ ex, fn, task, js: b.bound, bot: bot.bound, error: b.error, i: bot.i });
      const ans = bot.answer || {};
      if (!spec.async) {
        if (ans.latency !== undefined || ans.hang !== undefined) throw new Error('m15 harness: latency on a sync function');
        return answer(ans, b.refs);
      }
      return (async () => {
        if (ans.latency !== undefined) await sleep(ans.latency);
        if (ans.hang !== undefined) {
          await sleep(ans.hang === null ? 1e9 : ans.hang);
          throw new asyncio.TimeoutError();
        }
        return answer(ans, b.refs);
      })();
    };
  }

  const handles = new Map();
  function traderFor(exchange, demo = false) {
    const { resolveExchange } = require('../../../services/exchanges');
    const ex = resolveExchange(exchange);
    const hk = `${ex}:${demo ? 1 : 0}`;
    if (handles.has(hk)) return handles.get(hk);
    const h = { exchange: ex, inst: null, mod: MODULES[ex], fake: true };
    for (const [fn, spec] of Object.entries(sigs[ex] || {})) h[camel(fn)] = method(ex, fn, spec);
    h.priceMultiplier = (sym) => (pmult ? pmult(ex, sym) : PMULT[ex](sym));
    h.formatTradeResult = (...a) => MODULES[ex].formatTradeResult(...a);
    handles.set(hk, h);
    return h;
  }

  function missing() {
    const out = [];
    for (const [k, q] of queues) for (const c of q) out.push({ key: k, i: c.i, ex: c.ex, fn: c.fn, task: c.task, bound: c.bound });
    return out;
  }

  return {
    traderFor,
    jsCalls,
    mismatches,
    extra,
    missing,
    /** Every disagreement with the bot's call sequence (empty = identical calls). */
    problems: () => [
      ...mismatches.map((m) => ({ kind: 'args', ...m })),
      ...extra.map((m) => ({ kind: 'extra', ...m })),
      ...missing().map((m) => ({ kind: 'missing', ...m })),
    ],
  };
}

// ── delivery + logs ─────────────────────────────────────────────────────

const PY_KW = { parseMode: 'parse_mode', replyMarkup: 'reply_markup', disableWebPagePreview: 'disable_web_page_preview',
  disableNotification: 'disable_notification', protectContent: 'protect_content' };
const kbRows = (kb) => (kb ? kb.map((row) => row.map((b) => [b.label === undefined ? b.text : b.label, b.action === undefined ? b.callback_data : b.action])) : null);

/**
 * The delivery facade of the loops. `failOn`: substrings that make bot.sendMessage throw (the RecBot);
 * `safeResults`: [[substring, result]] — the safe send's return (default true) or {raise: {type, msg}}.
 */
function makeDeliveryRecorder({ clock = null, failOn = [], safeResults = [] } = {}) {
  const sent = [];
  const t = () => (clock ? clock.now() : null);
  const task = () => asyncio.currentTaskName();
  const pyKw = (opts) => {
    const kw = {};
    for (const [k, v] of Object.entries(opts || {})) {
      if (k === 'site' || v === undefined) continue;
      kw[PY_KW[k] || snake(k)] = k === 'replyMarkup' ? kbRows(v) : clone(v);
    }
    return kw;
  };
  const bot = {
    async sendMessage(chatId, text, opts = {}) {
      sent.push({ via: 'bot', t: t(), task: task(), uid: chatId, text, kw: pyKw(opts) });
      if (failOn.some((s) => String(text).includes(s))) throw new Error('Telegram send failed (scripted)');
      return { message_id: sent.length };
    },
  };
  async function sendMessage(_bot, uid, text, opts = {}) {
    const parseMode = opts.parseMode === undefined ? 'HTML' : opts.parseMode;
    const extra = pyKw(opts);
    if (opts.parseMode === undefined || opts.parseMode === 'HTML') delete extra.parse_mode;
    let res = true;
    for (const [s, r] of safeResults) {
      if (String(text).includes(s)) { res = r; break; }
    }
    sent.push({ via: 'safe', t: t(), task: task(), uid, text, parse_mode: parseMode, kw: extra, bot: _bot !== null && _bot !== undefined,
      result: isPlain(res) ? null : res });
    if (isPlain(res) && res.raise) throw mkErr(res.raise);
    return res;
  }
  return {
    sent,
    bot,
    sendMessage,
    async sendText(uid, text, opts = {}) { sent.push({ via: 'text', t: t(), task: task(), uid, text, kw: pyKw(opts) }); return true; },
    async alertAdmins(text) { sent.push({ via: 'alert', t: t(), task: task(), uid: null, text, kw: {} }); return 1; },
    take() { return sent.splice(0, sent.length); },
  };
}

/** A logger with the engine's level names; lines {t, task, level, msg, exc}. */
function makeLogCapture(clock = null) {
  const lines = [];
  const mk = (level) => (msg, err) => {
    lines.push({ t: clock ? clock.now() : null, task: asyncio.currentTaskName(), level, msg: String(msg),
      exc: err && level === 'ERROR' && err instanceof Error ? `${err.pyType || err.name}: ${err.message}` : null });
  };
  return {
    lines,
    debug: mk('DEBUG'), info: mk('INFO'), warning: mk('WARNING'), warn: mk('WARNING'), error: mk('ERROR'), exception: mk('ERROR'),
    critical: mk('CRITICAL'),
    take() { return lines.splice(0, lines.length); },
    at(minLevel = 'DEBUG') {
      const order = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'];
      return lines.filter((l) => order.indexOf(l.level) >= order.indexOf(minLevel)).map((l) => [l.level, l.msg]);
    },
  };
}

// ── comparisons ─────────────────────────────────────────────────────────

/** Order-insensitive equality of two lists of JSON values (a multiset). */
function sameSet(a, b) {
  const key = (v) => JSON.stringify(v);
  const ka = a.map(key).sort();
  const kb = b.map(key).sort();
  return ka.length === kb.length && ka.every((v, i) => v === kb[i]);
}

/** The first path where two JSON values differ (null when equal). NaN equals NaN. */
function firstDiff(a, b, p = '$') {
  if (typeof a === 'number' && typeof b === 'number') return Object.is(a, b) || a === b ? null : `${p}: ${a} != ${b}`;
  if (a === b) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${p}: length ${a.length} != ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${p}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    const kd = firstDiff(ka, kb, `${p}.keys`);
    if (kd) return kd;
    for (const k of ka) {
      const d = firstDiff(a[k], b[k], `${p}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return `${p}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
}

module.exports = {
  FIXTURES, DEFAULT_TRADE_DUMP_COLS, UNDECRYPTABLE, BAD_CIPHERTEXT, SECRET_PARAMS,
  loadFixture, untag, clone, setupSiteDb, seedSite, insertSiteUser, insertSiteKey, dumpSiteDb,
  mkErr, bindToSig, makeFakeTraders, makeDeliveryRecorder, makeLogCapture, sameSet, firstDiff, snake, camel,
  createVClock, vclockSleep,
};
