/**
 * challengeService — the bot's «челлендж» (challenge.py + the texts of
 * handlers/challenge.py + the Mini App glue of miniapp_api.py), one-to-one
 * (genome-challenge-profiles.md Part 2):
 *
 *   Challenge          the dataclass (19 fields, field order = JSON key order) with the
 *                      derived properties goal_usd / goal_profit_usd / risk_usd / r_needed /
 *                      topups_total / daily_loss_r, to_json / from_json
 *   build              validation of the 10 answers (Python float()/int()/str() coercions,
 *                      the bot's ranges, ValueError(<field>) / the coercion's own message)
 *   plan               R to goal, $ risk, margin at the typical 1.5 % stop, verdict
 *                      ok|tight|unrealistic|negative|no_data, warnings
 *   progress           R and $ from the starting deposit over db/signal_outcome rules,
 *                      top-ups separately, today's counters, pace, discipline
 *   discipline / gate  [CHALLENGE-GATE]: max trades per day, daily loss in R → block until the
 *                      next UTC day; fail-open ONLY when the kv read itself fails
 *   applySettings      risk, leverage, strategies (profiles._enable_strategy), auto-trade only
 *                      with exchange keys, over traderSettingsService
 *   start / addTopup / finish / notifyOnce / tick / startLoop
 *   texts              _T, plan_text, progress_text, block_text (RU/EN verbatim) and the
 *                      questionnaire texts _L / _OPTIONS of handlers/challenge.py
 *   challengeDict / challengeState   miniapp_api._challenge_dict / _challenge_state
 *
 * Storage: engine_kv `challenge_<uid>`, JSON byte-identical to the bot's
 * `json.dumps(asdict(ch), ensure_ascii=False)` (Python float repr for the float fields).
 *
 * I/O is behind `configure(deps)`: clock, kv {get, set, itemsWithPrefix}, rowsSince(uid, ts),
 * signalStats(uid, days, now), hasKeys(user), getUser(uid), saveUser(user), notifier
 * {sendText(uid, html, meta), sendCard(uid, payload)}, log. Defaults are the site services
 * (engine_kv, signal_trades, exchange_keys, trader_settings, notifier.dispatch type
 * `challenge`). The share card is rendered on the client (decision D3): `sendCard` gets the
 * aggregate the bot hands to share_card.render_share_png.
 *
 * TODO(M10a): signal_status / signal_rr / aggregate / signal_rows_since / signal_stats are
 * ported locally below with the exact semantics of db/signal_outcome.py and
 * db/signal_stats.py; switch to services/engine/signalOutcome.js + signalStats.js once that
 * branch is merged (same names, same behaviour).
 *
 * Log markers: [CHALLENGE] uid=… start …, [CHALLENGE] uid=… apply applied=… skipped=…,
 * [CHALLENGE] uid=… finish status=…, [CHALLENGE] tick {…}, [CHALLENGE] tick uid=…: …,
 * [CHALLENGE] loop: …, [CHALLENGE] card uid=…, [CHALLENGE-GATE] uid=…: kv read failed (…) —
 * gate skipped.
 */

'use strict';

const { PyValueError, PyTypeError } = require('./engine/pycoerce');
const { pyRound, pyRoundInt, pyMax, pyMin } = require('../strategies/common/pyround');
const { pyRepr, fmtFixed, fmtComma } = require('../strategies/common/pyfmt');
const { pySum } = require('../strategies/common/series');
const { pyJsonDumps } = require('./engine/pyjson');

// ═══════════════════════════════════════════════════════════════════════
//  constants (challenge.py)
// ═══════════════════════════════════════════════════════════════════════

const KV_PREFIX = 'challenge_';
const STATUS_ACTIVE = 'active';
const STATUS_DONE = 'done';
const STATUS_EXPIRED = 'expired';
const STATUS_CANCELLED = 'cancelled';
const TERMS_DAYS = Object.freeze({ '2w': 14, '1m': 30, '3m': 90, none: 0 });
const STRATEGIES = Object.freeze(['LEVELS', 'SMC', 'VOLUME']);
const TYPICAL_SL_PCT = 1.5;            // typical stop for the margin / liquidation estimate
const MIN_TRADES_FOR_FORECAST = 10;    // fewer — "not enough data", no forecast
const MODES = Object.freeze(['signals', 'auto']);
const EXCHANGES = Object.freeze(['bybit', 'bingx', 'binance', 'okx']);
const CHALLENGE_LINK = '/app/?tab=settings&sec=challenge';

// ═══════════════════════════════════════════════════════════════════════
//  Python semantics helpers
// ═══════════════════════════════════════════════════════════════════════

const isNone = (v) => v === null || v === undefined;

/** Python truthiness of a JSON-shaped value (NaN is truthy like in Python). */
function truthy(v) {
  if (isNone(v) || v === false) return false;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return Boolean(v);
}

/** type(v).__name__ for a JSON-shaped value (a JS integer stands for a Python int). */
function pyTypeName(v) {
  if (isNone(v)) return 'NoneType';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
  if (typeof v === 'string') return 'str';
  if (Array.isArray(v)) return 'list';
  return 'dict';
}

// ── Unicode data of the bot's CPython ────────────────────────────────────
// int() / float() / repr() / re `\d` / str.isspace() follow the interpreter's own Unicode
// database (CPython 3.11: unicodedata 14.0.0), not the one Node ships (Node 22 = Unicode 16:
// new digit scripts, newly assigned characters that CPython still repr()-escapes as
// unassigned). The tables live in strategies/common/pyUnicode.js and the int()/float() parser in
// strategies/common/pynum.js (tests/challenge/gen/gen_unicode_tables.py).
const { isPrintable, ND_CLASS, pyStrRepr, pyStrip, pyLower, pyUpper } = require('./engine/pyUnicode');
const N = require('../strategies/common/pynum');

/** _PyUnicode_TransformDecimalAndSpaceToASCII (the text int() / float() parse). */
const pyNumText = N.numText;

/** float(v) with CPython's exception classes and messages. */
function pyFloat(v) {
  if (typeof v === 'boolean') return v ? 1.0 : 0.0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const x = N.floatFromStr(v);
    if (x === undefined) throw new PyValueError(N.floatErrorText(v));
    return x;
  }
  throw new PyTypeError(`float() argument must be a string or a real number, not '${pyTypeName(v)}'`);
}

/** The exact decimal digits int(v) parses for a str, or null when it is no int literal. */
function intLiteral(s) {
  const lit = N.intLiteral(s);
  if (lit && lit.limit !== undefined) throw new PyValueError(N.intLimitText(lit.limit));
  return lit;
}

/** int(v) with CPython's exception classes and messages. */
function pyInt(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') {
    const t = N.intFromFloat(v);
    if (t === null) {
      if (Number.isNaN(v)) throw new PyValueError(N.floatToIntErrorText(v));
      const e = new Error(N.floatToIntErrorText(v));
      e.pyType = 'OverflowError';
      throw e;
    }
    return t;
  }
  if (typeof v === 'string') {
    const lit = intLiteral(v);
    if (lit === null) throw new PyValueError(N.intErrorText(v));
    return N.intFromLiteral(lit);
  }
  throw new PyTypeError(`int() argument must be a string, a bytes-like object or a real number, not '${pyTypeName(v)}'`);
}

/** str(int(v)) for a str — the exact decimal (Python ints are unbounded). */
function pyIntStr(v) {
  if (typeof v !== 'string') return String(pyInt(v));
  const lit = intLiteral(v);
  if (lit === null) throw new PyValueError(N.intErrorText(v));
  return N.intStrFromLiteral(lit);
}

const floatOr0 = (v) => (truthy(v) ? pyFloat(v) : 0.0);       // float(x or 0)
const intOr0 = (v) => (truthy(v) ? pyInt(v) : 0);             // int(x or 0)
// str(x or default) as compared against a fixed set of strings: a truthy non-string never
// matches (str(5) = "5", str(["usd"]) = "['usd']"), so it collapses to an impossible marker.
const NON_STR = '\u0000<non-str>';
const strOr = (v, dflt) => (truthy(v) ? (typeof v === 'string' ? v : NON_STR) : dflt);

/** `for s in (x or [])` over a JSON-shaped value. */
function iterOrEmpty(v) {
  if (!truthy(v)) return [];
  if (typeof v === 'string') return Array.from(v);
  if (Array.isArray(v)) return v;
  if (typeof v === 'object') return Object.keys(v);
  throw new PyTypeError(`'${pyTypeName(v)}' object is not iterable`);
}

const getOr = (o, k, dflt) => (o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k)
  && o[k] !== undefined ? o[k] : dflt);

/** repr() of a list of str / a flat dict, for the log lines. */
function pyListRepr(list) {
  return `[${list.map((x) => (typeof x === 'string' ? pyStrRepr(x) : String(x))).join(', ')}]`;
}

function pyDictRepr(d) {
  return `{${Object.entries(d).map(([k, v]) => `${pyStrRepr(k)}: ${Array.isArray(v) ? pyListRepr(v) : String(v)}`).join(', ')}}`;
}

/** str(float) for a value the bot holds as a Python float. */
const fstr = (x) => pyRepr(x);

// ── UTC calendar (datetime.fromtimestamp(ts, tz=utc), ROUND_HALF_EVEN microseconds: common/pytime.js) ──
const { wholeSeconds } = require('../strategies/common/pytime');

/** _day_start(ts): UTC midnight of ts as a float timestamp. */
function dayStart(ts) {
  return Math.floor(wholeSeconds(ts) / 86400) * 86400;
}

/** _day_key(ts): "YYYY-MM-DD" (UTC). */
function dayKey(ts) {
  return new Date(dayStart(ts) * 1000).toISOString().slice(0, 10);
}

/** datetime.fromtimestamp(ts, tz=utc).hour */
function utcHour(ts) {
  const s = wholeSeconds(ts);
  return Math.floor((s - Math.floor(s / 86400) * 86400) / 3600);
}

// ═══════════════════════════════════════════════════════════════════════
//  env (LOOP_INTERVAL_S / DAILY_HOUR_UTC)
// ═══════════════════════════════════════════════════════════════════════

/** float(os.getenv(name, dflt) or dflt) */
function envFloat(env, name, dflt) {
  const raw = env[name] === undefined ? String(dflt) : env[name];
  return raw === '' ? dflt : pyFloat(raw);
}

function envInt(env, name, dflt) {
  const raw = env[name] === undefined ? String(dflt) : env[name];
  return raw === '' ? dflt : pyInt(raw);
}

function readConfig(env = process.env) {
  return {
    LOOP_INTERVAL_S: pyMax(60.0, envFloat(env, 'CHALLENGE_LOOP_INTERVAL_S', 600)),
    DAILY_HOUR_UTC: pyMax(0, pyMin(23, envInt(env, 'CHALLENGE_DAILY_HOUR_UTC', 20))),
  };
}

const CONFIG = readConfig(process.env);

// ═══════════════════════════════════════════════════════════════════════
//  dependencies
// ═══════════════════════════════════════════════════════════════════════

const COLS = 'result, result_rr, progress_stage, entry, sl, original_sl, tp1, tp2, tp3, '
  + 'created_at, strategy, order_id, signal_msg_id, symbol, direction, expire_rr';
// db/signal_outcome.COUNTABLE_SQL — ORPHAN and SKIP without card and without order are garbage.
const COUNTABLE_SQL = "COALESCE(result, '') != 'ORPHAN' "
  + "AND NOT (COALESCE(result, '') = 'SKIP' "
  + '         AND COALESCE(signal_msg_id, 0) = 0 '
  + "         AND COALESCE(order_id, '') = '')";

const lazyDb = () => require('../models/database');

/** db/signal_stats.signal_rows_since on signal_trades (TODO(M10a): signalStats.signalRowsSince). */
function dbRowsSince(userId, sinceTs) {
  return lazyDb().prepare(
    `SELECT ${COLS} FROM signal_trades WHERE user_id=? AND created_at >= ? AND ${COUNTABLE_SQL} ORDER BY created_at`,
  ).all(Number(userId), pyFloat(sinceTs));
}

/** db/signal_stats.signal_stats(uid, days) (TODO(M10a): signalStats.signalStats). */
function dbSignalStats(userId, days = 30, now = null) {
  const t = isNone(now) ? _deps.clock() : now;
  const rows = lazyDb().prepare(
    `SELECT ${COLS} FROM signal_trades WHERE user_id=? AND created_at > ? AND ${COUNTABLE_SQL} ORDER BY created_at`,
  ).all(Number(userId), t - days * 86400);
  return aggregate(rows, days, t);
}

/** db_kv_items_with_prefix: `key LIKE prefix%` (SQLite LIKE: `_` matches any char, ASCII case-insensitive). */
function dbKvItemsWithPrefix(prefix) {
  if (!prefix) return [];
  const rows = lazyDb().prepare('SELECT key, value FROM engine_kv WHERE key LIKE ?').all(`${prefix}%`);
  return rows.filter((r) => r && r.key).map((r) => [r.key, r.value]);
}

/** challenge._has_keys(user): any of bybit/bingx/binance/okx with both key and secret. */
function dbHasKeys(user) {
  const app = require('./appSettingsService');
  for (const ex of EXCHANGES) {
    const [key, secret] = app.exchangeKeys(user.user_id, ex);
    if (key && secret) return true;
  }
  return false;
}

function titleOf(text) {
  return String(text).split('\n')[0].replace(/<[^>]+>/g, '').slice(0, 200) || 'CHM';
}

/** notifier.dispatch type `challenge`: the bot's HTML text verbatim (Telegram mirror = the same HTML). */
function defaultNotifier() {
  const n = () => require('./notifier');
  return {
    sendText: (uid, text) => n().dispatch(uid, {
      type: 'challenge', title: titleOf(text), body: text, tgText: text, link: CHALLENGE_LINK, data: { text },
    }),
    // D3: the share card is drawn by the client from the same aggregate the bot renders.
    sendCard: (uid, payload) => n().dispatch(uid, {
      type: 'challenge', title: payload.filename, body: null, link: `${CHALLENGE_LINK}&card=1`, data: { share_card: payload },
    }),
  };
}

function defaultDeps() {
  return {
    clock: () => Date.now() / 1000,
    kv: {
      get: (k) => require('./engineKvService').get(k),
      set: (k, v) => require('./engineKvService').set(k, v),
      itemsWithPrefix: dbKvItemsWithPrefix,
    },
    rowsSince: dbRowsSince,
    signalStats: dbSignalStats,
    hasKeys: dbHasKeys,
    getUser: (uid) => require('./traderSettingsService').getOrCreate(uid),
    saveUser: (user) => require('./traderSettingsService').save(user),
    notifier: null,               // resolved lazily (defaultNotifier)
    log: null,                    // resolved lazily (utils/logger)
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
  };
}

let _deps = defaultDeps();

/** Override any dependency (tests, workers). `kv` may be given partially. */
function configure(over = {}) {
  const kv = over.kv ? { ..._deps.kv, ...over.kv } : _deps.kv;
  _deps = { ..._deps, ...over, kv };
  return _deps;
}

function resetDeps() {
  _deps = defaultDeps();
}

const log = () => _deps.log || require('../utils/logger');
const notifier = () => _deps.notifier || defaultNotifier();
const now0 = (now) => (isNone(now) ? _deps.clock() : now);
const debug = (m) => { const l = log(); if (l.debug) l.debug(m); };

// ═══════════════════════════════════════════════════════════════════════
//  db/signal_outcome.py (TODO(M10a): services/engine/signalOutcome.js)
// ═══════════════════════════════════════════════════════════════════════

const FINAL = Object.freeze(['TP1', 'TP2', 'TP3', 'SL', 'BE']);

/** Python `except (TypeError, ValueError)`: swallow those two, re-raise anything else (OverflowError …). */
function pyCatch(e, fallback) {
  if (e instanceof PyValueError || e instanceof PyTypeError) return fallback;
  throw e;
}

/** _env_hours: max(1.0, float(os.getenv(name, "") or default)), default on a bad value. */
function envHours(name, dflt, env = process.env) {
  const raw = env[name];
  try {
    return pyMax(1.0, isNone(raw) || raw === '' ? dflt : pyFloat(raw));
  } catch (e) {
    return pyCatch(e, dflt);
  }
}

/** SIGNAL_TRACKER_MAX_AGE_H (72 h): that long a signal is "in progress", afterwards "no outcome". */
const MAX_AGE_S = envHours('SIGNAL_TRACKER_MAX_AGE_H', 72.0) * 3600.0;

const pyFalsy = (v) => isNone(v) || v === false || v === 0 || v === '';

/** _g(row, key, default): missing / None → default. */
function _g(row, key, dflt = null) {
  if (isNone(row) || typeof row !== 'object') return dflt;
  const v = row[key];
  return isNone(v) ? dflt : v;
}

function hasCard(row) {
  try {
    const v = _g(row, 'signal_msg_id', 0);
    return pyInt(pyFalsy(v) ? 0 : v) > 0;
  } catch (e) {
    return pyCatch(e, false);
  }
}

function isExchangeTrade(row) {
  const v = _g(row, 'order_id', '');
  return Boolean(pyStrip(String(pyFalsy(v) ? '' : v)));
}

/** signal_status(row, now) → tp1|tp2|tp3|sl|be|closed|open|expired|missed|skip (the 10 rules in order). */
function signalStatus(row, now = null) {
  const resRaw = _g(row, 'result', '');
  const res = pyUpper(String(pyFalsy(resRaw) ? '' : resRaw));
  const stageRaw = _g(row, 'progress_stage', '');
  const stage = pyUpper(String(pyFalsy(stageRaw) ? '' : stageRaw));
  if (FINAL.includes(res)) return pyLower(res);
  if (res === 'MANUAL' || res === 'TRAIL') return 'closed';
  const skipReason = _g(row, 'skip_reason', '');
  if (res === 'SKIP' && String(pyFalsy(skipReason) ? '' : skipReason) === 'manual') return 'skip';
  if (FINAL.includes(stage)) return pyLower(stage);
  if (stage === 'EXPIRED') return 'expired';
  if (stage === 'MISSED') return 'missed';
  if (res === 'ORPHAN') return 'skip';
  if (res === 'SKIP' && !hasCard(row) && !isExchangeTrade(row)) return 'skip';
  if (res && res !== 'SKIP') return 'closed';
  const t = isNone(now) ? Date.now() / 1000 : now;
  let age;
  try {
    const c = _g(row, 'created_at', 0);
    age = t - pyFloat(pyFalsy(c) ? 0 : c);
  } catch (e) {
    age = pyCatch(e, 0.0);
  }
  return age > MAX_AGE_S ? 'expired' : 'open';
}

/** signal_rr(row, status): real result_rr, else TPn → planned R from the ORIGINAL stop, SL −1, BE 0. */
function signalRr(row, status) {
  const resRaw = _g(row, 'result', '');
  const res = pyUpper(String(pyFalsy(resRaw) ? '' : resRaw));
  const rrRaw = _g(row, 'result_rr', null);
  if (res && res !== 'SKIP' && res !== 'ORPHAN' && rrRaw !== null && rrRaw !== '') {
    try { return pyFloat(rrRaw); } catch (e) { pyCatch(e); /* fall through like the bot */ }
  }
  if (status === 'sl') return -1.0;
  if (status === 'be') return 0.0;
  if (status === 'missed') return null;
  if (status === 'expired') {
    const v = _g(row, 'expire_rr', null);
    try { return v !== null && v !== '' ? pyRound(pyFloat(v), 2) : null; } catch (e) { return pyCatch(e, null); }
  }
  if (status === 'tp1' || status === 'tp2' || status === 'tp3') {
    let entry; let sl0; let tp;
    try {
      const e = _g(row, 'entry', 0); entry = pyFloat(pyFalsy(e) ? 0 : e);
      const o = _g(row, 'original_sl', 0); const s = _g(row, 'sl', 0);
      sl0 = pyFloat(pyFalsy(o) ? 0 : o) || pyFloat(pyFalsy(s) ? 0 : s);
      const x = _g(row, status, 0); tp = pyFloat(pyFalsy(x) ? 0 : x);
    } catch (err) {
      return pyCatch(err, null);
    }
    const risk = Math.abs(entry - sl0);
    return risk > 0 && tp > 0 ? pyRound(Math.abs(tp - entry) / risk, 2) : null;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════
//  db/signal_stats.aggregate (TODO(M10a): services/engine/signalStats.js)
// ═══════════════════════════════════════════════════════════════════════

const fOr0 = (v) => (pyFalsy(v) ? 0.0 : pyFloat(v));
const sOr = (v, dflt = '') => (pyFalsy(v) ? dflt : String(v));

function blank() {
  return { signals: 0, trades: 0, wins: 0, losses: 0, be: 0, win_rate: 0.0, total_rr: 0.0, rr_7d: 0.0 };
}

/** aggregate(rows, days=30, now): one user's rows → the summary. */
function aggregate(rows, days = 30, now = null) {
  const t = isNone(now) ? Date.now() / 1000 : now;
  const cutoff7 = t - 7 * 86400;
  const perStrategy = {};
  for (const s of STRATEGIES) perStrategy[s] = blank();
  const out = {
    days, ...blank(), open: 0, expired: 0, missed: 0, best_rr: null,
    best_symbol: '', best_direction: '', best_strategy: '',
    equity: [], per_strategy: perStrategy,
  };
  let cum = 0.0;
  const sorted = rows.slice().sort((a, b) => fOr0(a.created_at) - fOr0(b.created_at));     // stable like sorted()
  for (const r of sorted) {
    const strat = pyUpper(sOr(r.strategy));
    const buckets = [out].concat(Object.prototype.hasOwnProperty.call(perStrategy, strat) ? [perStrategy[strat]] : []);
    for (const b of buckets) b.signals += 1;
    const st = signalStatus(r, t);
    if (st === 'open' || st === 'tp1' || st === 'tp2') out.open += 1;
    else if (st === 'expired') out.expired += 1;
    else if (st === 'missed') out.missed += 1;
    const rr = signalRr(r, st);
    if (rr === null) continue;
    const recent = fOr0(r.created_at) >= cutoff7;
    for (const b of buckets) {
      b.trades += 1;
      b.wins += rr > 0 ? 1 : 0;
      b.losses += rr < 0 ? 1 : 0;
      b.be += rr === 0 ? 1 : 0;
      b.total_rr += rr;
      if (recent) b.rr_7d += rr;
    }
    if (out.best_rr === null || rr > out.best_rr) {
      out.best_rr = pyRound(rr, 2);
      out.best_symbol = sOr(r.symbol).split('-USDT-SWAP').join('');
      out.best_direction = pyUpper(sOr(r.direction));
      out.best_strategy = strat;
    }
    cum += rr;
    out.equity.push({ t: Math.trunc(fOr0(r.created_at)), r: pyRound(cum, 2) });
  }
  for (const b of [out].concat(Object.values(perStrategy))) {
    if (b.trades) b.win_rate = pyRound(b.wins / b.trades * 100, 1);
    b.total_rr = pyRound(b.total_rr, 2);
    b.rr_7d = pyRound(b.rr_7d, 2);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
//  the dataclass
// ═══════════════════════════════════════════════════════════════════════

const REQUIRED = Symbol('required');
// [name, python type, default] in dataclass order (= asdict / JSON key order)
const FIELDS = Object.freeze([
  ['user_id', 'int', REQUIRED],
  ['started_at', 'float', REQUIRED],
  ['deposit', 'float', REQUIRED],          // starting deposit, $
  ['goal_kind', 'str', REQUIRED],          // "usd" (target deposit) | "pct" (growth in %)
  ['goal_value', 'float', REQUIRED],
  ['deadline_ts', 'float', 0.0],           // 0 — no deadline
  ['risk_pct', 'float', 1.0],              // risk per trade, % of deposit
  ['leverage', 'int', 5],
  ['max_trades_day', 'int', 3],            // 0 — unlimited
  ['daily_loss_pct', 'float', 3.0],        // 0 — unlimited
  ['topup_monthly', 'float', 0.0],         // planned top-ups, $/month
  ['strategies', 'list', () => ['LEVELS']],
  ['mode', 'str', 'signals'],              // "signals" | "auto"
  ['status', 'str', STATUS_ACTIVE],
  ['finished_at', 'float', 0.0],
  ['topups', 'list', () => []],            // [{"ts", "amount"}]
  ['daily_stop', 'dict', () => ({})],      // {"day": "YYYY-MM-DD", "reason": str} — unused
  ['notified', 'dict', () => ({})],        // one-off notification flags
  ['term', 'str', 'none'],
]);
const FIELD_NAMES = Object.freeze(FIELDS.map((f) => f[0]));

function missingArgsMessage(missing) {
  const q = missing.map((m) => `'${m}'`);
  let list;
  if (q.length === 1) list = q[0];
  else if (q.length === 2) list = `${q[0]} and ${q[1]}`;
  else list = `${q.slice(0, -1).join(', ')}, and ${q[q.length - 1]}`;
  const noun = q.length === 1 ? 'argument' : 'arguments';
  return `Challenge.__init__() missing ${q.length} required positional ${noun}: ${list}`;
}

class Challenge {
  /** Challenge(**kwargs): unknown keys are the caller's business (from_json drops them). */
  constructor(fields = {}) {
    const missing = FIELDS.filter(([n, , d]) => d === REQUIRED && !Object.prototype.hasOwnProperty.call(fields, n)).map((f) => f[0]);
    if (missing.length) throw new PyTypeError(missingArgsMessage(missing));
    for (const [n, , d] of FIELDS) {
      if (Object.prototype.hasOwnProperty.call(fields, n)) this[n] = fields[n];
      else this[n] = typeof d === 'function' ? d() : d;
    }
  }

  // ── derived ──
  get goal_usd() {
    if (this.goal_kind === 'pct') return pyRound(this.deposit * (1.0 + pyFloat(this.goal_value) / 100.0), 2);
    return pyFloat(this.goal_value);
  }

  get goal_profit_usd() {
    return pyMax(0.0, this.goal_usd - this.deposit);
  }

  get risk_usd() {
    return pyRound(this.deposit * this.risk_pct / 100.0, 2);
  }

  get r_needed() {
    const r = this.risk_usd;
    return r > 0 ? pyRound(this.goal_profit_usd / r, 1) : 0.0;
  }

  get topups_total() {
    return pyRound(pySum(this.topups.map((t) => floatOr0(getOr(t, 'amount', null)))), 2);
  }

  /** daily loss limit in R (0 — none). */
  get daily_loss_r() {
    if (this.daily_loss_pct <= 0 || this.risk_pct <= 0) return 0.0;
    return pyRound(this.daily_loss_pct / this.risk_pct, 2);
  }

  /** asdict(self) — a deep copy of the 19 fields in order. */
  asdict() {
    const out = {};
    for (const n of FIELD_NAMES) out[n] = deepCopy(this[n]);
    return out;
  }

  /** json.dumps(asdict(self), ensure_ascii=False) */
  toJson() {
    return dumpChallenge(this);
  }

  static fromJson(raw) {
    return fromJson(raw);
  }
}

function deepCopy(v) {
  if (Array.isArray(v)) return v.map(deepCopy);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = deepCopy(v[k]);
    return o;
  }
  return v;
}

/** Challenge.from_json: not JSON / not a dict / no user_id → null; unknown keys dropped. */
function fromJson(raw) {
  let d;
  try {
    if (typeof raw !== 'string') throw new Error('not a str');
    d = JSON.parse(raw || '');
  } catch (_e) {
    return null;
  }
  if (!d || typeof d !== 'object' || Array.isArray(d) || !Object.prototype.hasOwnProperty.call(d, 'user_id')) return null;
  const known = {};
  for (const k of Object.keys(d)) if (FIELD_NAMES.includes(k)) known[k] = d[k];
  return new Challenge(known);           // missing required fields → TypeError like the dataclass
}

// ── json.dumps(asdict(ch), ensure_ascii=False) ───────────────────────────
// services/engine/pyjson.js is the bot's json.dumps (separators, insertion order, Python float
// repr for the named float keys) with ensure_ascii=True; the challenge is written with
// ensure_ascii=False, so the \uXXXX escapes of non-ASCII characters (≥ 0x7f — DEL included,
// surrogate halves re-join) are turned back into the characters. Control characters keep
// their escapes, an escaped backslash is never the start of an escape.
const FLOAT_KEYS = Object.freeze([...FIELDS.filter(([, t]) => t === 'float').map(([n]) => n), 'ts', 'amount']);

function unescapeNonAscii(s) {
  return s.replace(/\\\\|\\u([0-9a-f]{4})/g, (m, hex) => {
    if (hex === undefined) return m;
    const code = parseInt(hex, 16);
    return code >= 0x7f ? String.fromCharCode(code) : m;
  });
}

function dumpChallenge(ch) {
  return unescapeNonAscii(pyJsonDumps(ch.asdict(), FLOAT_KEYS));
}

// ═══════════════════════════════════════════════════════════════════════
//  storage
// ═══════════════════════════════════════════════════════════════════════

const key = (uid) => `${KV_PREFIX}${pyInt(uid)}`;

/** load(uid) → Challenge | null (kv errors propagate). */
function load(uid) {
  const raw = _deps.kv.get(key(uid));
  return truthy(raw) ? fromJson(raw) : null;
}

function save(ch) {
  _deps.kv.set(key(ch.user_id), ch.toJson());
}

function loadAllActive() {
  const out = [];
  for (const [, raw] of _deps.kv.itemsWithPrefix(KV_PREFIX)) {
    const ch = fromJson(raw);
    if (ch !== null && ch.status === STATUS_ACTIVE) out.push(ch);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
//  build (validation of the answers)
// ═══════════════════════════════════════════════════════════════════════

/**
 * build(uid, answers, now): answers deposit, goal_kind, goal_value, term (2w|1m|3m|none),
 * risk_pct, leverage, max_trades_day, daily_loss_pct, topup_monthly, strategies, mode.
 * Throws PyValueError(<field>) for an out-of-range value; a failed float()/int() throws
 * PyValueError / PyTypeError with CPython's message (the Mini App answers it as `field`).
 */
function build(uid, answers, now = null) {
  const t = now0(now);
  const a = answers && typeof answers === 'object' ? answers : {};
  const g = (k) => getOr(a, k, null);
  const deposit = floatOr0(g('deposit'));
  if (!(deposit >= 10 && deposit <= 10_000_000)) throw new PyValueError('deposit');
  const goalKind = strOr(g('goal_kind'), 'pct');
  if (goalKind !== 'usd' && goalKind !== 'pct') throw new PyValueError('goal_kind');
  const goalValue = floatOr0(g('goal_value'));
  if (goalKind === 'pct' && !(goalValue >= 1 && goalValue <= 1000)) throw new PyValueError('goal_value');
  if (goalKind === 'usd' && !(deposit < goalValue && goalValue <= deposit * 100)) throw new PyValueError('goal_value');
  const term = strOr(g('term'), 'none');
  if (!Object.prototype.hasOwnProperty.call(TERMS_DAYS, term)) throw new PyValueError('term');
  const risk = floatOr0(g('risk_pct'));
  if (!(risk >= 0.1 && risk <= 10)) throw new PyValueError('risk_pct');
  const lev = intOr0(g('leverage'));
  if (!(lev >= 1 && lev <= 125)) throw new PyValueError('leverage');
  const mtd = intOr0(g('max_trades_day'));
  if (!(mtd >= 0 && mtd <= 100)) throw new PyValueError('max_trades_day');
  const dlp = floatOr0(g('daily_loss_pct'));
  if (!(dlp >= 0 && dlp <= 50)) throw new PyValueError('daily_loss_pct');
  const topup = floatOr0(g('topup_monthly'));
  if (!(topup >= 0 && topup <= 10_000_000)) throw new PyValueError('topup_monthly');
  const strategies = iterOrEmpty(g('strategies')).filter((s) => typeof s === 'string' && STRATEGIES.includes(s));
  if (!strategies.length) throw new PyValueError('strategies');
  const mode = strOr(g('mode'), 'signals');
  if (mode !== 'signals' && mode !== 'auto') throw new PyValueError('mode');
  const days = TERMS_DAYS[term];
  return new Challenge({
    user_id: pyInt(uid), started_at: t, deposit: pyRound(deposit, 2), goal_kind: goalKind,
    goal_value: pyRound(goalValue, 2), deadline_ts: days ? t + days * 86400 : 0.0,
    risk_pct: pyRound(risk, 2), leverage: lev, max_trades_day: mtd, daily_loss_pct: pyRound(dlp, 2),
    topup_monthly: pyRound(topup, 2), strategies, mode, term,
  });
}

/** Python `isinstance(e, (ValueError, TypeError))` for the errors build / addTopup throw. */
function isValueOrTypeError(e) {
  return e instanceof PyValueError || e instanceof PyTypeError;
}

// ═══════════════════════════════════════════════════════════════════════
//  plan and feasibility
// ═══════════════════════════════════════════════════════════════════════

/** plan(ch, stats30, now): the plan numbers + the verdict by the 30-day stats (aggregate). */
function plan(ch, stats30, now = null) {
  const t = now0(now);
  const st = stats30 || {};
  const trades30 = intOr0(getOr(st, 'trades', 0));
  const rr30 = floatOr0(getOr(st, 'total_rr', 0.0));
  const rPerDay = rr30 / 30.0;
  const daysLeft = truthy(ch.deadline_ts) ? (ch.deadline_ts - t) / 86400.0 : null;
  const rNeeded = ch.r_needed;
  const out = {
    goal_usd: ch.goal_usd, profit_usd: pyRound(ch.goal_profit_usd, 2),
    risk_usd: ch.risk_usd, r_needed: rNeeded,
    days_total: getOr(TERMS_DAYS, ch.term, 0), days_left: daysLeft !== null ? pyRound(daysLeft, 1) : null,
    hist_trades: trades30, hist_rr: pyRound(rr30, 2), hist_r_per_day: pyRound(rPerDay, 2),
    r_per_day_needed: truthy(daysLeft) ? pyRound(rNeeded / pyMax(daysLeft, 1.0), 2) : null,
    days_forecast: null, verdict: 'no_data', warnings: [], margin_pct: null,
  };
  // forecast
  if (trades30 >= MIN_TRADES_FOR_FORECAST && rPerDay > 0) {
    out.days_forecast = pyRound(rNeeded / rPerDay, 0);
    if (daysLeft === null) out.verdict = 'ok';
    else if (out.days_forecast <= daysLeft) out.verdict = 'ok';
    else if (out.days_forecast <= daysLeft * 2) out.verdict = 'tight';
    else out.verdict = 'unrealistic';
  } else if (trades30 >= MIN_TRADES_FOR_FORECAST) {
    out.verdict = 'negative';              // 30 days in the red — no forecast for the goal
  }
  // risk / leverage warnings
  const sl = TYPICAL_SL_PCT / 100.0;
  const positionX = (ch.risk_pct / 100.0) / sl;                 // position size in deposits
  const lev1 = pyMax(ch.leverage, 1);
  out.margin_pct = pyRound(positionX / lev1 * 100.0, 1);
  const liqMovePct = 100.0 / lev1;
  if (ch.risk_pct >= 3) out.warnings.push('risk_high');                         // 5 stops in a row = −15 %+
  if (liqMovePct < 2 * TYPICAL_SL_PCT) out.warnings.push('liquidation_near');   // liquidation closer than 2 stops
  if (truthy(out.margin_pct) && out.margin_pct > 100) out.warnings.push('margin_over_deposit');
  if (truthy(ch.daily_loss_pct) && truthy(ch.risk_pct) && ch.daily_loss_pct < ch.risk_pct) {
    out.warnings.push('daily_limit_below_risk');                                // daily limit below one stop
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
//  progress and discipline
// ═══════════════════════════════════════════════════════════════════════

/** progress(ch, rows, now): rows = signal_trades rows since the start (signal_rows_since). */
function progress(ch, rows, now = null) {
  const t = now0(now);
  const daysElapsed = pyMax(0.0, (t - ch.started_at) / 86400.0);
  const agg = aggregate(rows, pyMax(1, Math.trunc(daysElapsed) + 1), t);
  const rTotal = floatOr0(getOr(agg, 'total_rr', 0.0));
  const riskUsd = ch.risk_usd;
  const rNeeded = ch.r_needed;
  const topupsTotal = ch.topups_total;
  const pnlUsd = pyRound(rTotal * riskUsd, 2);
  const pctGoal = rNeeded > 0 ? pyRound(100.0 * rTotal / rNeeded, 1) : 0.0;
  // today (UTC): the countable rows created since midnight
  const t0 = dayStart(t);
  const todayRows = rows.filter((r) => floatOr0(getOr(r, 'created_at', null)) >= t0);
  const today = aggregate(todayRows, 1, t);
  const todayR = floatOr0(getOr(today, 'total_rr', 0.0));
  const todaySignals = intOr0(getOr(today, 'signals', 0));
  // pace: the R expected by today on an even plan
  const daysTotal = getOr(TERMS_DAYS, ch.term, 0);
  const expectedR = daysTotal ? pyRound(rNeeded * pyMin(1.0, daysElapsed / daysTotal), 1) : null;
  const daysLeft = truthy(ch.deadline_ts) ? pyRound((ch.deadline_ts - t) / 86400.0, 1) : null;
  const [blocked, reason] = discipline(ch, todaySignals, todayR);
  return {
    r_total: pyRound(rTotal, 2), pnl_usd: pnlUsd, pct_goal: pyMax(0.0, pctGoal),
    goal_reached: rTotal >= rNeeded && rNeeded > 0,
    deposit_now: pyRound(ch.deposit + pnlUsd + topupsTotal, 2),
    topups_total: topupsTotal,
    days_elapsed: pyRound(daysElapsed, 1), days_left: daysLeft,
    deadline_passed: Boolean(truthy(ch.deadline_ts) && t >= ch.deadline_ts),
    expected_r: expectedR, pace_r: expectedR !== null ? pyRound(rTotal - expectedR, 1) : null,
    signals: intOr0(getOr(agg, 'signals', 0)), trades: intOr0(getOr(agg, 'trades', 0)),
    win_rate: floatOr0(getOr(agg, 'win_rate', 0.0)), best_rr: getOr(agg, 'best_rr', null),
    today_signals: todaySignals, today_r: pyRound(todayR, 2),
    today_left: truthy(ch.max_trades_day) ? pyMax(0, ch.max_trades_day - todaySignals) : null,
    blocked, block_reason: reason, day: dayKey(t),
    equity: getOr(agg, 'equity', []),
  };
}

/** discipline(ch, today_signals, today_r) → [block new entries until tomorrow?, reason]. */
function discipline(ch, todaySignals, todayR) {
  if (ch.status !== STATUS_ACTIVE) return [false, ''];
  if (truthy(ch.max_trades_day) && todaySignals >= ch.max_trades_day) return [true, 'max_trades'];
  const lim = ch.daily_loss_r;
  if (truthy(lim) && todayR <= -lim) return [true, 'daily_loss'];
  return [false, ''];
}

/**
 * [CHALLENGE-GATE] gate(uid, now) → block reason for auto-trade or null. No active challenge →
 * always null. A failed kv read is fail-OPEN (the user may have no challenge at all — a kv
 * outage must not block everybody); errors of the discipline calculation propagate (the
 * auto-trade caller closes the trade fail-closed).
 */
function gate(uid, now = null) {
  let ch;
  try {
    ch = load(uid);
  } catch (e) {
    log().warn(`[CHALLENGE-GATE] uid=${uid}: kv read failed (${e && e.message}) — gate skipped`);
    return null;
  }
  if (ch === null || ch.status !== STATUS_ACTIVE) return null;
  const t = now0(now);
  const rows = _deps.rowsSince(uid, pyMax(ch.started_at, dayStart(t)));
  const aggToday = progress(ch, rows, t);
  return aggToday.block_reason || null;
}

// ═══════════════════════════════════════════════════════════════════════
//  settings + lifecycle
// ═══════════════════════════════════════════════════════════════════════

/**
 * apply_settings(user, ch, um): risk, leverage, strategies, mode → the user's settings.
 * `opts.admin` is the bot's ADMIN_IDS bypass (undefined → users.is_admin); `opts.save=false`
 * is the bot's `um=None`.
 */
function applySettings(user, ch, { admin, save: doSave = true } = {}) {
  const ts = require('./traderSettingsService');
  const profiles = require('./profilesService');
  const applied = [];
  const skipped = [];
  user.trade_risk_pct = pyFloat(ch.risk_pct); applied.push('trade_risk_pct');
  user.trade_leverage = pyInt(ch.leverage); applied.push('trade_leverage');
  for (const s of ch.strategies) {
    (profiles.enableStrategy(user, s, { admin }) ? applied : skipped).push(`strategy.${s}`);
  }
  if (ch.mode === 'auto') {
    if (ts.can(user, 'auto_trade', { admin }) && _deps.hasKeys(user)) {
      user.auto_trade = true; applied.push('auto_trade');
    } else {
      skipped.push('auto_trade');           // no exchange keys / plan
    }
  }
  if (doSave) _deps.saveUser(user);
  log().info(`[CHALLENGE] uid=${user.user_id} apply applied=${pyListRepr(applied)} skipped=${pyListRepr(skipped)}`);
  return { applied, skipped };
}

/** start(user, answers, um, now) → [ch, {applied, skipped}] */
function start(user, answers, { now = null, admin, save: doSave = true } = {}) {
  const ch = build(user.user_id, answers, now);
  const res = applySettings(user, ch, { admin, save: doSave });
  save(ch);
  log().info(`[CHALLENGE] uid=${ch.user_id} start deposit=${fmtFixed(ch.deposit, 0)} goal=${fmtFixed(ch.goal_usd, 0)} `
    + `r_needed=${fmtFixed(ch.r_needed, 1)} term=${ch.term} mode=${ch.mode}`);
  return [ch, res];
}

function addTopup(ch, amount, now = null) {
  const a = pyFloat(amount);
  if (!(a >= 1 && a <= 10_000_000)) throw new PyValueError('amount');
  ch.topups.push({ ts: now0(now), amount: pyRound(a, 2) });
  save(ch);
  return ch;
}

function finish(ch, status, now = null) {
  ch.status = status;
  ch.finished_at = now0(now);
  save(ch);
  log().info(`[CHALLENGE] uid=${ch.user_id} finish status=${status}`);
  return ch;
}

/**
 * notify_once(ch, key): true — the flag was not set yet (set + save); false — already notified.
 * QUIRK kept: the stamp is the wall clock (`int(time.time())`), not the tick's `now`.
 */
function notifyOnce(ch, flag) {
  if (truthy(getOr(ch.notified, flag, null))) return false;
  ch.notified[flag] = Math.trunc(_deps.clock());
  // do not keep past days' flags forever
  const keys = Object.keys(ch.notified);
  if (keys.length > 60) {
    const sorted = keys.slice().sort((x, y) => ch.notified[x] - ch.notified[y]);     // stable
    for (const k of sorted.slice(0, 30)) delete ch.notified[k];
  }
  save(ch);
  return true;
}

// ═══════════════════════════════════════════════════════════════════════
//  background tick
// ═══════════════════════════════════════════════════════════════════════

async function send(uid, text, kind) {
  await notifier().sendText(uid, text, { kind });
}

/** _send_card: the final results card over the challenge period (skipped without signals). */
async function sendCard(ch, rows, lang) {
  try {
    const t = _deps.clock();
    const days = pyMax(1, Math.trunc((t - ch.started_at) / 86400) + 1);
    const st = aggregate(rows, days, t);
    if (intOr0(getOr(st, 'signals', 0)) <= 0) return;
    await notifier().sendCard(ch.user_id, { stats: st, period: '', days, lang, filename: 'chm_challenge.png' });
  } catch (e) {
    debug(`[CHALLENGE] card uid=${ch.user_id}: ${e && e.message}`);
  }
}

const GOAL_HEAD = { ru: '🏆 <b>Цель челленджа достигнута!</b>', en: '🏆 <b>Challenge goal reached!</b>' };
const DEADLINE_HEAD = { ru: '⏱ <b>Срок челленджа вышел.</b>', en: '⏱ <b>Challenge deadline passed.</b>' };

/**
 * tick(now): one pass over the active challenges — goal / deadline / daily stop / daily
 * progress. Returns the counters {active, done, expired, blocked, daily}. A broken kv record
 * (from_json TypeError) aborts the pass like the bot; per-user errors are logged and skipped.
 */
async function tick({ now = null } = {}) {
  const t = now0(now);
  const stats = { active: 0, done: 0, expired: 0, blocked: 0, daily: 0 };
  for (const ch of loadAllActive()) {
    stats.active += 1;
    try {
      const user = await _deps.getUser(ch.user_id);
      const lang = ((user && user.lang) || 'ru') === 'en' ? 'en' : 'ru';
      const rows = await _deps.rowsSince(ch.user_id, ch.started_at);
      const pr = progress(ch, rows, t);
      const day = pr.day;
      if (pr.goal_reached) {
        finish(ch, STATUS_DONE, t);
        stats.done += 1;
        await send(ch.user_id, `${GOAL_HEAD[lang]}\n${progressText(ch, pr, lang)}`, 'done');
        await sendCard(ch, rows, lang);
        continue;
      }
      if (pr.deadline_passed) {
        finish(ch, STATUS_EXPIRED, t);
        stats.expired += 1;
        await send(ch.user_id, `${DEADLINE_HEAD[lang]}\n${progressText(ch, pr, lang)}`, 'expired');
        await sendCard(ch, rows, lang);
        continue;
      }
      if (pr.blocked && notifyOnce(ch, `block:${day}`)) {
        stats.blocked += 1;
        await send(ch.user_id, blockText(pr.block_reason, lang), 'block');
      }
      const hour = utcHour(t);
      if (hour >= CONFIG.DAILY_HOUR_UTC && (truthy(pr.signals) || pr.days_elapsed >= 1)
          && notifyOnce(ch, `daily:${day}`)) {
        stats.daily += 1;
        await send(ch.user_id, progressText(ch, pr, lang), 'daily');
      }
    } catch (e) {
      log().warn(`[CHALLENGE] tick uid=${ch.user_id}: ${e && e.message}`);
    }
  }
  return stats;
}

/**
 * challenge_loop: after a 90 s start delay, tick() every LOOP_INTERVAL_S. Returns stop().
 */
function startLoop({ initialDelayS = 90, intervalS = CONFIG.LOOP_INTERVAL_S } = {}) {
  let timer = null;
  let stopped = false;
  const run = async () => {
    if (stopped) return;
    try {
      const st = await tick();
      if (st.active) log().info(`[CHALLENGE] tick ${pyDictRepr(st)}`);
    } catch (e) {
      log().warn(`[CHALLENGE] loop: ${e && e.message}`);
    }
    if (!stopped) timer = setTimeout(run, intervalS * 1000);
  };
  timer = setTimeout(run, initialDelayS * 1000);
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}

/** daily_summary hook: the short progress line of an active challenge, else null. */
function dailySummaryLine(user, now = null) {
  const ch = load(user.user_id);
  if (ch === null || ch.status !== STATUS_ACTIVE) return null;
  const t = now0(now);
  const pr = progress(ch, _deps.rowsSince(user.user_id, ch.started_at), t);
  const lang = user.lang === 'en' ? 'en' : 'ru';
  return progressText(ch, pr, lang, true);
}

// ═══════════════════════════════════════════════════════════════════════
//  texts (challenge.py _T + plan_text / progress_text / block_text)
// ═══════════════════════════════════════════════════════════════════════

const T = Object.freeze({
  ru: {
    verdict: {
      ok: '✅ По вашей статистике цель достижима',
      tight: '⚠️ По статистике цель на грани — нужен темп вдвое выше обычного',
      unrealistic: '❌ По статистике за 30 дней в этот срок цель не достижима',
      negative: '⚠️ За 30 дней итог в минусе — прогноза по сроку нет',
      no_data: 'ℹ️ Мало данных за 30 дней — прогноз появится после 10 сделок',
    },
    warn: {
      risk_high: 'риск ≥ 3 %: пять стопов подряд = −15 % депозита',
      liquidation_near: 'при таком плече ликвидация ближе двух стопов',
      margin_over_deposit: 'позиция по плану не влезает в депозит при типичном стопе 1,5 %',
      daily_limit_below_risk: 'дневной лимит убытка меньше одного стопа',
    },
    mode: { signals: 'сигналы вручную', auto: 'автотрейд' },
    block: { max_trades: 'лимит сделок на сегодня исчерпан', daily_loss: 'дневной лимит убытка достигнут' },
    strat: { LEVELS: 'Уровни', SMC: 'SMC', VOLUME: 'Объём' },
  },
  en: {
    verdict: {
      ok: '✅ By your stats the goal is reachable',
      tight: '⚠️ Tight: needs about twice your usual pace',
      unrealistic: '❌ By your 30-day stats this goal is not reachable in time',
      negative: '⚠️ Last 30 days are negative — no forecast',
      no_data: 'ℹ️ Not enough data — forecast after 10 trades',
    },
    warn: {
      risk_high: 'risk ≥ 3%: five stops in a row = −15% of deposit',
      liquidation_near: 'with this leverage liquidation is closer than two stops',
      margin_over_deposit: 'planned position does not fit the deposit at a typical 1.5% stop',
      daily_limit_below_risk: 'daily loss limit is below one stop',
    },
    mode: { signals: 'manual signals', auto: 'auto-trade' },
    block: { max_trades: 'daily trade limit reached', daily_loss: 'daily loss limit reached' },
    strat: { LEVELS: 'Levels', SMC: 'SMC', VOLUME: 'Volume' },
  },
});

const langT = (lang) => T[lang === 'en' ? 'en' : 'ru'];

/** dict[key] with KeyError semantics. */
function pick(d, k) {
  if (!Object.prototype.hasOwnProperty.call(d, k)) {
    const e = new Error(typeof k === 'string' ? pyStrRepr(k) : String(k));
    e.pyType = 'KeyError';
    throw e;
  }
  return d[k];
}

/** _usd(x) = f"${x:,.0f}" with the comma → a regular space. */
function usd(x) {
  return `$${fmtComma(x, 0).split(',').join(' ')}`;
}

/** `{x or '∞'}` of an int field / a float field. */
const intOrInf = (x) => (truthy(x) ? String(x) : '∞');
const floatOrInf = (x) => (truthy(x) ? fstr(x) : '∞');

function planText(ch, pl, lang = 'ru') {
  const t = langT(lang);
  const strat = ch.strategies.map((s) => getOr(t.strat, s, s)).join(' + ');
  let lines;
  if (lang === 'en') {
    lines = [
      `🎯 <b>Challenge: ${usd(ch.deposit)} → ${usd(ch.goal_usd)}</b>`,
      `Profit to make: ${usd(pl.profit_usd)} = <b>${fstr(pl.r_needed)}R</b> at ${fstr(ch.risk_pct)}% (${usd(pl.risk_usd)}) per trade`,
      `Leverage ${ch.leverage}× · margin ≈ ${fstr(pl.margin_pct)}% of deposit per trade (1.5% stop)`,
      `Term: ${!truthy(ch.deadline_ts) ? 'no deadline' : `${pl.days_total} days`}`
        + (truthy(pl.r_per_day_needed) ? ` · need ${fstr(pl.r_per_day_needed)}R/day` : ''),
      `Limits: ${intOrInf(ch.max_trades_day)} trades/day · daily loss ${floatOrInf(ch.daily_loss_pct)}%`,
      `Strategies: ${strat} · ${pick(t.mode, ch.mode)}`,
    ];
    if (truthy(ch.topup_monthly)) lines.push(`Top-ups: ${usd(ch.topup_monthly)}/month (tracked separately, not counted as profit)`);
    lines.push('');
    lines.push(pick(t.verdict, pl.verdict) + (truthy(pl.days_forecast)
      ? ` (≈${Math.trunc(pl.days_forecast)} days at your ${fstr(pl.hist_r_per_day)}R/day)` : ''));
  } else {
    lines = [
      `🎯 <b>Челлендж: ${usd(ch.deposit)} → ${usd(ch.goal_usd)}</b>`,
      `Заработать: ${usd(pl.profit_usd)} = <b>${fstr(pl.r_needed)}R</b> при риске ${fstr(ch.risk_pct)} % (${usd(pl.risk_usd)}) на сделку`,
      `Плечо ${ch.leverage}× · маржа ≈ ${fstr(pl.margin_pct)} % депозита на сделку (стоп 1,5 %)`,
      `Срок: ${!truthy(ch.deadline_ts) ? 'без срока' : `${pl.days_total} дн.`}`
        + (truthy(pl.r_per_day_needed) ? ` · нужно ${fstr(pl.r_per_day_needed)}R в день` : ''),
      `Лимиты: ${intOrInf(ch.max_trades_day)} сделок в день · убыток за день ${floatOrInf(ch.daily_loss_pct)} %`,
      `Стратегии: ${strat} · ${pick(t.mode, ch.mode)}`,
    ];
    if (truthy(ch.topup_monthly)) lines.push(`Пополнения: ${usd(ch.topup_monthly)}/мес (отдельной строкой, в прибыль не идут)`);
    lines.push('');
    lines.push(pick(t.verdict, pl.verdict) + (truthy(pl.days_forecast)
      ? ` (≈${Math.trunc(pl.days_forecast)} дн. при вашем темпе ${fstr(pl.hist_r_per_day)}R/день)` : ''));
  }
  for (const w of pl.warnings || []) lines.push(`⚠️ ${pick(t.warn, w)}`);
  return lines.join('\n');
}

/** _bar(pct, width=10) */
function bar(pct, width = 10) {
  const n = pyMax(0, pyMin(width, pyRoundInt(pct / 100.0 * width)));
  return '█'.repeat(n) + '░'.repeat(width - n);
}

function progressText(ch, pr, lang = 'ru', short = false) {
  const t = langT(lang);
  const sign = pr.r_total >= 0 ? '+' : '';
  const paceOk = !isNone(pr.pace_r);
  let head;
  let body;
  if (lang === 'en') {
    head = `🎯 <b>Challenge</b> ${bar(pr.pct_goal)} ${fmtFixed(pr.pct_goal, 0)}%`;
    body = [`${sign}${fstr(pr.r_total)}R of ${fstr(ch.r_needed)}R · ${sign}${usd(pr.pnl_usd)} of ${usd(ch.goal_profit_usd)}`];
    if (!isNone(pr.days_left)) {
      body.push(`Day ${Math.trunc(pr.days_elapsed) + 1} · ${pyMax(0, Math.trunc(pr.days_left))} days left`
        + (paceOk ? ` · pace ${pr.pace_r >= 0 ? '+' : ''}${fstr(pr.pace_r)}R` : ''));
    }
    if (!short) {
      body.push(`Today: ${pr.today_signals}${truthy(ch.max_trades_day) ? `/${ch.max_trades_day}` : ''} trades · `
        + `${pr.today_r >= 0 ? sign : ''}${fstr(pr.today_r)}R`);
      body.push(`Deposit now ≈ ${usd(pr.deposit_now)}` + (truthy(pr.topups_total) ? ` (incl. top-ups ${usd(pr.topups_total)})` : ''));
      body.push(`Win rate ${fmtFixed(pr.win_rate, 0)}% · ${pr.trades} trades with outcome`);
    }
    if (pr.blocked) body.push(`⛔ ${pick(t.block, pr.block_reason)} — no new entries until tomorrow (UTC)`);
  } else {
    head = `🎯 <b>Челлендж</b> ${bar(pr.pct_goal)} ${fmtFixed(pr.pct_goal, 0)} %`;
    body = [`${sign}${fstr(pr.r_total)}R из ${fstr(ch.r_needed)}R · ${sign}${usd(pr.pnl_usd)} из ${usd(ch.goal_profit_usd)}`];
    if (!isNone(pr.days_left)) {
      body.push(`День ${Math.trunc(pr.days_elapsed) + 1} · осталось ${pyMax(0, Math.trunc(pr.days_left))} дн.`
        + (paceOk ? ` · темп ${pr.pace_r >= 0 ? '+' : ''}${fstr(pr.pace_r)}R к плану` : ''));
    }
    if (!short) {
      body.push(`Сегодня: ${pr.today_signals}${truthy(ch.max_trades_day) ? `/${ch.max_trades_day}` : ''} сделок · `
        + `${pr.today_r > 0 ? '+' : ''}${fstr(pr.today_r)}R`);
      body.push(`Депозит сейчас ≈ ${usd(pr.deposit_now)}` + (truthy(pr.topups_total) ? ` (с пополнениями ${usd(pr.topups_total)})` : ''));
      body.push(`Win rate ${fmtFixed(pr.win_rate, 0)} % · сделок с итогом ${pr.trades}`);
    }
    if (pr.blocked) body.push(`⛔ ${pick(t.block, pr.block_reason)} — новых входов до завтра (UTC) не будет`);
  }
  return `${head}\n${body.join('\n')}`;
}

function blockText(reason, lang = 'ru') {
  const t = langT(lang);
  if (lang === 'en') {
    return `⛔ <b>Challenge: ${pick(t.block, reason)}</b>\nPer your plan no new entries until tomorrow (UTC). Auto-trade pauses, signals are still delivered.`;
  }
  return `⛔ <b>Челлендж: ${pick(t.block, reason)}</b>\nПо вашему плану новых входов до завтра (UTC) не будет. Автотрейд на паузе, сигналы приходят.`;
}

// ═══════════════════════════════════════════════════════════════════════
//  handlers/challenge.py — questionnaire texts and pure helpers
// ═══════════════════════════════════════════════════════════════════════

const STEPS = Object.freeze(['deposit', 'goal', 'term', 'risk', 'leverage', 'trades', 'loss', 'topup', 'strat', 'mode']);
const CUSTOM_STEPS = Object.freeze(['deposit', 'goal', 'risk', 'leverage', 'trades', 'loss', 'topup']);

const L = Object.freeze({
  ru: {
    intro: '🎯 <b>Челлендж</b>\n\nЛичный торговый план: бот задаст 10 вопросов (депозит, цель, срок, риск, '
      + 'плечо, лимиты, пополнения, стратегии, режим), посчитает план в R и $, честно скажет, '
      + 'достижима ли цель по вашей статистике, применит настройки и будет вести прогресс.\n\n'
      + 'Дисциплина: при лимите сделок или убытка за день бот не откроет новых входов до завтра.',
    start: '🚀 Начать', back: '←  Настройки', cancel: '✖ Отмена', custom: '✏️ Свой вариант',
    next: 'Далее →', done: '✅ Готово', restart: '✏️ Заново', go: '🚀 Стартовать',
    topup: '➕ Пополнение', stop: '🏁 Завершить', refresh: '🔄 Обновить',
    q: {
      deposit: '1/10 · Какой депозит сейчас, $?', goal: '2/10 · Цель: на сколько вырастить депозит?',
      term: '3/10 · За какой срок?', risk: '4/10 · Риск на одну сделку, % депозита',
      leverage: '5/10 · Рабочее плечо', trades: '6/10 · Максимум сделок в день',
      loss: '7/10 · Дневной лимит убытка, % депозита (после него — стоп до завтра)',
      topup: '8/10 · Планируете пополнять депозит? Сколько в месяц, $',
      strat: '9/10 · Какими стратегиями идёте к цели? (можно несколько)',
      mode: '10/10 · Режим: сигналы вручную или автотрейд по ним?',
    },
    ask_num: 'Напишите число сообщением (например 2500) или /cancel.',
    bad_num: 'Не понял число. Напишите, например, 2500.', bad: 'Недопустимое значение для поля: ',
    cancelled: 'Анкета отменена.', strat_names: { LEVELS: 'Уровни', SMC: 'SMC', VOLUME: 'Объём + MA' },
    mode_names: { signals: '📨 Сигналы вручную', auto: '🤖 Автотрейд' },
    term_names: { '2w': '2 недели', '1m': '1 месяц', '3m': '3 месяца', none: 'Без срока' },
    applied: 'Применено: ', skipped: 'Пропущено: ', no_keys: 'автотрейд (нет ключей биржи — подключите в настройках)',
    started: '🎯 <b>Челлендж запущен.</b> Прогресс — в настройках и в вечернем отчёте.',
    ask_topup: 'Сумма пополнения, $ (числом) или /cancel:', topup_ok: 'Пополнение учтено: ',
    stop_confirm: 'Завершить челлендж? Статистика сохранится, настройки не меняются.',
    stop_yes: '🏁 Да, завершить', stopped: 'Челлендж завершён. Новый — кнопкой ниже.',
    locked: '🔒 Челлендж доступен на тарифе Pro.',
  },
  en: {
    intro: '🎯 <b>Challenge</b>\n\nA personal trading plan: 10 questions (deposit, goal, term, risk, leverage, '
      + 'limits, top-ups, strategies, mode), the plan in R and $, an honest feasibility check against your '
      + 'stats, settings applied automatically, progress tracked.\n\n'
      + 'Discipline: once the daily trade or loss limit is hit, no new entries until tomorrow.',
    start: '🚀 Start', back: '←  Settings', cancel: '✖ Cancel', custom: '✏️ Custom',
    next: 'Next →', done: '✅ Done', restart: '✏️ Restart', go: '🚀 Launch',
    topup: '➕ Top-up', stop: '🏁 Finish', refresh: '🔄 Refresh',
    q: {
      deposit: '1/10 · Current deposit, $?', goal: '2/10 · Goal: grow the deposit by how much?',
      term: '3/10 · Over what term?', risk: '4/10 · Risk per trade, % of deposit',
      leverage: '5/10 · Working leverage', trades: '6/10 · Max trades per day',
      loss: '7/10 · Daily loss limit, % of deposit (then stop until tomorrow)',
      topup: '8/10 · Planning top-ups? How much per month, $',
      strat: '9/10 · Strategies for this challenge (multi-select)',
      mode: '10/10 · Mode: manual signals or auto-trade?',
    },
    ask_num: 'Send a number as a message (e.g. 2500) or /cancel.',
    bad_num: 'Not a number. Example: 2500.', bad: 'Invalid value for: ',
    cancelled: 'Questionnaire cancelled.', strat_names: { LEVELS: 'Levels', SMC: 'SMC', VOLUME: 'Volume + MA' },
    mode_names: { signals: '📨 Manual signals', auto: '🤖 Auto-trade' },
    term_names: { '2w': '2 weeks', '1m': '1 month', '3m': '3 months', none: 'No deadline' },
    applied: 'Applied: ', skipped: 'Skipped: ', no_keys: 'auto-trade (no exchange keys — connect one in settings)',
    started: '🎯 <b>Challenge started.</b> Progress is in settings and in the daily summary.',
    ask_topup: 'Top-up amount, $ (number) or /cancel:', topup_ok: 'Top-up recorded: ',
    stop_confirm: 'Finish the challenge? Stats are kept, settings stay as they are.',
    stop_yes: '🏁 Yes, finish', stopped: 'Challenge finished. Start a new one below.',
    locked: '🔒 The challenge is available on Pro.',
  },
});

/** _OPTIONS: button label → value per step. */
const OPTIONS = Object.freeze({
  deposit: [['$500', 500], ['$1 000', 1000], ['$3 000', 3000], ['$5 000', 5000], ['$10 000', 10000]],
  goal: [['+10 %', 'pct:10'], ['+25 %', 'pct:25'], ['+50 %', 'pct:50'], ['+100 %', 'pct:100']],
  term: [['2w', '2w'], ['1m', '1m'], ['3m', '3m'], ['none', 'none']],
  risk: [['0.5 %', 0.5], ['1 %', 1.0], ['2 %', 2.0], ['3 %', 3.0]],
  leverage: [['3×', 3], ['5×', 5], ['10×', 10], ['20×', 20]],
  trades: [['2', 2], ['3', 3], ['5', 5], ['10', 10], ['∞', 0]],
  loss: [['2 %', 2.0], ['3 %', 3.0], ['5 %', 5.0], ['∞', 0.0]],
  topup: [['0', 0], ['$100', 100], ['$300', 300], ['$1 000', 1000]],
});

const handlerTexts = (lang) => L[lang === 'en' ? 'en' : 'ru'];

/** `_L[lang]["bad"] + str(e)` — the alert for a build error. */
function badText(field, lang = 'ru') {
  return handlerTexts(lang).bad + field;
}

/** handlers/challenge._answers(ans): questionnaire state → build() answers. */
function answersFromState(ans) {
  const s = ans || {};
  const goalRaw = getOr(s, 'goal', null);
  const goal = truthy(goalRaw) ? String(goalRaw) : 'pct:25';
  const i = goal.indexOf(':');
  if (i < 0) throw new PyValueError('not enough values to unpack (expected 2, got 1)');
  const has = (k) => Object.prototype.hasOwnProperty.call(s, k) && s[k] !== undefined;
  return {
    deposit: getOr(s, 'deposit', null), goal_kind: goal.slice(0, i), goal_value: pyFloat(goal.slice(i + 1)),
    term: has('term') ? s.term : '1m', risk_pct: getOr(s, 'risk', null), leverage: getOr(s, 'leverage', null),
    max_trades_day: has('trades') ? s.trades : 0, daily_loss_pct: has('loss') ? s.loss : 0.0,
    topup_monthly: has('topup') ? s.topup : 0.0, strategies: truthy(getOr(s, 'strategies', null)) ? s.strategies : [],
    mode: has('mode') ? s.mode : 'signals',
  };
}

/** _NUM_RE = re.compile(r"[-+]?\d+(?:[.,]\d+)?") — `\d` = CPython's Nd digits (ND_CLASS). */
const NUM_RE = new RegExp(`[-+]?[${ND_CLASS}]+(?:[.,][${ND_CLASS}]+)?`, 'u');

/** _parse_num(text): the first number after removing spaces, comma → dot; null when none. */
function parseNum(text) {
  const m = NUM_RE.exec(String(truthy(text) ? text : '').split(' ').join(''));
  return m ? pyFloat(m[0].replace(',', '.')) : null;
}

/** cb_go: started + applied list + skipped list (auto_trade → the no-keys text). */
function startedText(res, lang = 'ru') {
  const l = handlerTexts(lang);
  const parts = [l.started];
  if (res && res.applied && res.applied.length) parts.push(l.applied + res.applied.join(', '));
  const sk = ((res && res.skipped) || []).map((x) => (x === 'auto_trade' ? l.no_keys : x));
  if (sk.length) parts.push(l.skipped + sk.join(', '));
  return parts.join('\n');
}

/** msg_topup: topup_ok + f"${num:,.0f}" (comma → space). */
function topupOkText(num, lang = 'ru') {
  return handlerTexts(lang).topup_ok + usd(num);
}

// ═══════════════════════════════════════════════════════════════════════
//  Mini App glue (miniapp_api._challenge_dict / _challenge_state)
// ═══════════════════════════════════════════════════════════════════════

const ANSWER_KEYS = Object.freeze(['deposit', 'goal_kind', 'goal_value', 'term', 'risk_pct', 'leverage',
  'max_trades_day', 'daily_loss_pct', 'topup_monthly', 'strategies', 'mode']);

function challengeDict(ch) {
  const d = ch.asdict();
  Object.assign(d, {
    goal_usd: ch.goal_usd, goal_profit_usd: pyRound(ch.goal_profit_usd, 2),
    risk_usd: ch.risk_usd, r_needed: ch.r_needed, topups_total: ch.topups_total,
    daily_loss_r: ch.daily_loss_r,
  });
  delete d.notified;
  return d;
}

/** signal_stats(uid, 30) through the configured dependency (the plan's 30-day statistics). */
function stats30(userId) {
  return _deps.signalStats(userId, 30, _deps.clock());
}

function options() {
  return { terms: Object.keys(TERMS_DAYS), strategies: STRATEGIES.slice(), modes: MODES.slice() };
}

/** _challenge_state(user): {ok, available, active, challenge, plan, progress, options}. */
function challengeState(user, { admin } = {}) {
  const ts = require('./traderSettingsService');
  const ch = load(user.user_id);
  const out = {
    ok: true, available: Boolean(ts.can(user, 'challenge', { admin })), active: false, challenge: null,
    plan: null, progress: null, options: options(),
  };
  if (ch === null) return out;
  out.challenge = challengeDict(ch);
  out.active = ch.status === STATUS_ACTIVE;
  try {
    out.plan = plan(ch, stats30(user.user_id));
  } catch (e) {
    debug(`[MINIAPP] challenge plan uid=${user.user_id}: ${e && e.message}`);
  }
  try {
    out.progress = progress(ch, _deps.rowsSince(user.user_id, ch.started_at));
  } catch (e) {
    debug(`[MINIAPP] challenge progress uid=${user.user_id}: ${e && e.message}`);
  }
  return out;
}

module.exports = {
  // constants
  KV_PREFIX, STATUS_ACTIVE, STATUS_DONE, STATUS_EXPIRED, STATUS_CANCELLED, TERMS_DAYS, STRATEGIES,
  TYPICAL_SL_PCT, MIN_TRADES_FOR_FORECAST, MODES, CONFIG, readConfig, FIELDS: FIELD_NAMES, ANSWER_KEYS,
  COLS, COUNTABLE_SQL, MAX_AGE_S, envHours,
  // deps
  configure, resetDeps,
  // model
  Challenge, fromJson, dumpChallenge, key,
  // outcome / aggregate (local port, TODO(M10a))
  signalStatus, signalRr, aggregate, dbRowsSince, dbSignalStats, dbKvItemsWithPrefix, dbHasKeys,
  // core
  build, isValueOrTypeError, plan, progress, discipline, gate,
  load, save, loadAllActive, applySettings, start, addTopup, finish, notifyOnce,
  tick, sendCard, startLoop, dailySummaryLine,
  // texts
  T, usd, planText, bar, progressText, blockText, GOAL_HEAD, DEADLINE_HEAD,
  STEPS, CUSTOM_STEPS, L, OPTIONS, badText, answersFromState, parseNum, startedText, topupOkText,
  // mini app
  challengeDict, challengeState, options, stats30,
  // helpers (tests)
  dayStart, dayKey, utcHour, pyFloat, pyInt, pyIntStr, pyNumText, pyStrip, isPrintable, truthy, pyStrRepr, pyListRepr,
  pyDictRepr,
};
