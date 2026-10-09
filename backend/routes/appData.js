/**
 * /api/app data routes — the bot's Mini App handlers (miniapp_api.py) for the user's signals,
 * one to one after authentication (the site's JWT user instead of the Telegram initData user):
 *
 *   GET  dashboard                 h_dashboard     stats 30 d (fallback zeros + "[MINIAPP] dashboard stats"
 *                                                  warning), market BTC/ETH (60 s cache, 6 s per coin),
 *                                                  recent 6 + live price / R, trend (scanner.get_trend()
 *                                                  words), rating (all users, 15 min cache), market_trend
 *   GET  signals?status&limit&strategy  h_signals  newest first, limit 1..200 (int() of the query, bad → 50),
 *                                                  status open / closed filter over limit×3 rows
 *   GET  signals/{trade_id}/chart  h_signal_chart  bucket "chart" (MINIAPP_CHART_PER_MIN 10 / 60 s → 429,
 *                                                  Retry-After 6), owner only (404 not_found), candles:
 *                                                  the engine's cache when ≥ 60 bars else REST (200, 15 s),
 *                                                  < 30 bars / no picture → no_data. D3: instead of the PNG
 *                                                  the response carries the chart as data (chartPayload.js:
 *                                                  candles, overlays, event, hit_levels); `png` stays null
 *   POST signals/{trade_id}/result h_signal_result [MANUAL-RESULT] {result?, note?}: owner only (404), TP1..3 /
 *                                                  SL / BE / SKIP, exchange_trade, already_set, rr from the
 *                                                  original stop, note ≤ 500 code points
 *   GET  stats?days&strategy&tf    h_stats         signalStats.statsForUser (days int 1..365, bad → 30)
 *   POST analyze {symbol, strategy?}  h_analyze    coinAnalysisShell: 400 bad_symbol, 10 s cooldown + daily
 *                                                  kv quota analyze_count_<uid>_<day> (Free 1), AUTO pick;
 *                                                  the chart as data next to `png: null` (D3)
 *   POST share {days?}             h_share         bucket "share" 3 / 600 s → rate_limited (HTTP 200), days
 *                                                  int 7..365 (TypeError / ValueError → 30; int(inf) is the
 *                                                  bot's OverflowError → 500), no_data; the card is drawn by
 *                                                  the client (D3): {ok, sent: false, days, stats}
 *   POST feedback {type, text}     h_feedback      bug / idea → feature / other → question, 10..2000 chars,
 *                                                  kv miniapp_feedback_<uid>_<day> > 5 → rate_limited; the
 *                                                  bot's feedback row becomes a site support ticket (id)
 *   GET  events                    (site only)     SSE stream (services/sseService.js): handshake, 25 s
 *                                                  heartbeats, the user's own channel; event names `hello`,
 *                                                  `notification`, `signal`, `progress`, `trend`, `report`,
 *                                                  `trade`, `payment` (notifier / signalDelivery / tracker)
 *
 * Mounted from routes/app.js after its auth (401 / 403 envelope), `Cache-Control: no-store` and the
 * generic POST bucket (30 / 60 s → 429). Request targets are read the way aiohttp / yarl read them
 * (yarlUrl.js): the raw path (no dot-segment folding) matched on its decoded form (`%2F` / `%25`
 * stay in the id until the match, `{` / `}` never match an id), the query split on '&' with '+' as
 * space and U+FFFD for bad UTF-8, the first value of a repeated key; a known path with another
 * method → 405 (Allow) like the bot's router, an unknown one falls through to the site's 404.
 * Bodies keep their Python types (pyBody.js). Responses are written with json.dumps semantics
 * (pyjson.pyJsonDumps: NaN / Infinity literals like the bot's web.json_response).
 *
 * Engine memory (WS candle cache, last prices, the LEVELS scanner's trend, the trend monitor) is read
 * through services/engine/engineBridge.js — the worker thread holds it on the site.
 */

'use strict';

const express = require('express');
const db = require('../models/database');
const ts = require('../services/traderSettingsService');
const SS = require('../services/engine/signalStats');
const bridge = require('../services/engine/engineBridge');
const charts = require('../services/engine/chartPayload');
const Y = require('../services/engine/yarlUrl');
const PB = require('../services/engine/pyBody');
const CA = require('../services/engine/coinAnalysisShell');
const { pyJsonDumps } = require('../services/engine/pyjson');
const { pyInt, pyFloat, PyValueError, PyTypeError } = require('../services/engine/pycoerce');
const { pyRound } = require('../strategies/common/pyround');
const { intOrUndefined } = require('../strategies/common/pynum');
const { pyLower, pyStrip, pyUpper } = require('../strategies/common/pyUnicode');
const { pyStr: pyStrValue } = require('../services/exchanges/pyCompat');

const router = express.Router();
// routes/app.js owns the rate buckets (and requires this file) — resolve it at call time.
const app = () => require('./app');

// (int(os.getenv("MINIAPP_CHART_PER_MIN", "10") or 10), 60.0)
const CHART_RATE_LIMIT = [process.env.MINIAPP_CHART_PER_MIN ? (intOrUndefined(process.env.MINIAPP_CHART_PER_MIN) ?? 10) : 10, 60.0];
const SHARE_RATE_LIMIT = [3, 600.0];            // [SHARE-CARD] 3 картинки / 10 мин на юзера
const STRATS = Object.freeze(['LEVELS', 'SMC', 'VOLUME']);
const MANUAL_RESULTS = Object.freeze(['TP1', 'TP2', 'TP3', 'SL', 'BE', 'SKIP']);
const FEEDBACK_PER_DAY = 5;
const FEEDBACK_TYPES = Object.freeze({ bug: 'bug', idea: 'feature', other: 'question' });
const FEEDBACK_LABELS = Object.freeze({
  ru: { bug: '🐛 Баг', feature: '💡 Пожелание', question: '❓ Вопрос' },
  en: { bug: '🐛 Bug', feature: '💡 Feature request', question: '❓ Question' },
});
const TREND_WORD = Object.freeze({ '🟢': 'up', '🔴': 'down', '⚪': 'flat' });
const MARKET_TTL_S = 60;
const MARKET_TIMEOUT_MS = 6000;
const CANDLES_TIMEOUT_MS = 15000;
const PRICE_TIMEOUT_MS = 2000;

// ── injectable dependencies (tests) ──────────────────────────────────────
const D = {
  clock: () => Date.now() / 1000,
  log: null,
  rest: null,          // the bot's scanner.fetcher: get24hChange(sym), getCandles(sym, tf, limit)
  support: null,       // { create(userId, {subject, body}) → {id} }
};
let analyzeShell = null;
let tradesRepo = null;
const marketCache = { ts: 0.0, data: {} };

const log = () => D.log || require('../utils/logger');
const now = () => D.clock();
function fetcher() {
  if (D.rest) return D.rest;
  try { return require('../services/marketData/bingxRest').getRest(); } catch (_e) { return null; }
}
/** signal_trades on the route clock (state_changed_at / trade_events.ts = time.time() in the bot). */
function repo() {
  if (!tradesRepo) tradesRepo = require('../services/engine/signalTradesRepo').createSignalTradesRepo({ now: () => now() });
  return tradesRepo;
}

function shell() {
  if (!analyzeShell) {
    analyzeShell = CA.createAnalyzeShell({
      clock: () => now(),
      log: log(),
      fetch: (symbol, tf, limit) => {
        const f = fetcher();
        if (!f) throw new Error('no fetcher');
        return f.getCandles(symbol, tf, limit);
      },
      price24h: (symbol) => { const f = fetcher(); return f ? f.get24hChange(symbol) : null; },
    });
  }
  return analyzeShell;
}

/** Tests: { clock, log, rest, support } (null → the default). */
function configure(o = {}) {
  for (const k of Object.keys(D)) if (Object.prototype.hasOwnProperty.call(o, k)) D[k] = o[k];
  if (!D.clock) D.clock = () => Date.now() / 1000;
  analyzeShell = null;
}

/** Process-global state of the bot module: _market_cache, _analyze_last, the rating cache. */
function resetState() {
  marketCache.ts = 0.0;
  marketCache.data = {};
  analyzeShell = null;
  SS._resetRatingCache();
}

// ── helpers ──────────────────────────────────────────────────────────────
/** web.json_response(data, status) with json.dumps semantics (NaN / Infinity literals). */
function send(res, status, body) {
  return res.status(status).set('Content-Type', 'application/json; charset=utf-8').send(pyJsonDumps(body));
}

const bad = (res, key) => send(res, 200, { ok: false, error: 'bad_request', message: key });

/** _rate_limited_response(retry_s): HTTPTooManyRequests with the JSON text and Retry-After. */
function rateLimited(res, retryS) {
  res.set('Retry-After', String(retryS));
  return send(res, 429, { ok: false, error: 'rate_limited', message: `Слишком часто. Повторите через ${retryS} с` });
}

function loadUser(req) {
  return ts.getOrCreate(req.userId);
}

/** Python truthiness of a DB / JSON value. */
const truthy = (v) => !(v === null || v === undefined || v === false || v === 0 || v === '');
/** int(x or 0) for a DB value */
const intOr0 = (v) => (truthy(v) ? Math.trunc(Number(v)) : 0);
/** float(x or 0) for a DB value */
const floatOr0 = (v) => (truthy(v) ? pyFloat(v) : 0.0);

function withTimeout(p, ms) {
  let timer = null;
  return Promise.race([
    Promise.resolve(p).finally(() => { if (timer) clearTimeout(timer); }),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), ms); if (timer.unref) timer.unref(); }),
  ]);
}

/** _attach_live(signals): the live ones (≤ 25) get price / r_now from the engine's last closes. */
async function attachLive(signals) {
  const live = signals.filter((s) => ['open', 'tp1', 'tp2'].includes(s.status)).slice(0, 25);
  if (!live.length) return;
  const bases = Array.from(new Set(live.map((s) => s.symbol))).sort();
  const prices = await bridge.currentPrices(bases.map((b) => `${b}-USDT-SWAP`), PRICE_TIMEOUT_MS);
  await SS.attachLive(signals, (b) => {
    const px = prices[`${b}-USDT-SWAP`];
    return px === undefined ? null : px;
  });
}

/** _market(): BTC / ETH 24 h ticker, 60 s cache (an empty answer is not cached). */
async function market() {
  if (now() - marketCache.ts < MARKET_TTL_S && Object.keys(marketCache.data).length) return marketCache.data;
  const out = {};
  const f = fetcher();
  if (f) {
    for (const coin of ['BTC', 'ETH']) {
      try {
        const d = await withTimeout(f.get24hChange(`${coin}-USDT-SWAP`), MARKET_TIMEOUT_MS);
        if (d && typeof d === 'object' && Object.keys(d).length) {
          out[coin] = { price: floatOr0(d.last), change_pct: pyRound(floatOr0(d.change_pct), 2) };
        }
      } catch (e) {
        log().debug(`[MINIAPP] market ${coin}: ${e && e.message}`);
      }
    }
  }
  marketCache.ts = now();
  marketCache.data = out;
  return out;
}

/** _trend(): scanner.get_trend()[coin]["trend_text"] "H1: 🟢 | H4: 🔴 | …" → {BTC: {H1: up, …}, ETH: …}. */
function trendWords(raw) {
  const out = {};
  const r = raw && typeof raw === 'object' ? raw : {};
  for (const coin of ['BTC', 'ETH']) {
    const c = Object.prototype.hasOwnProperty.call(r, coin) && truthy(r[coin]) ? r[coin] : {};
    const tt = c && typeof c === 'object' && Object.prototype.hasOwnProperty.call(c, 'trend_text') ? c.trend_text : null;
    const text = truthy(tt) ? pyStrValue(tt) : '';
    const tfs = {};
    for (const part of text.split('|')) {
      if (!part.includes(':')) continue;
      const k = part.indexOf(':');
      const tf = pyStrip(part.slice(0, k));
      const mark = pyStrip(part.slice(k + 1));
      tfs[tf] = Object.prototype.hasOwnProperty.call(TREND_WORD, mark) ? TREND_WORD[mark] : 'unknown';
    }
    if (Object.keys(tfs).length) out[coin] = tfs;
  }
  return out;
}

/** _candles(symbol, timeframe): the engine cache (≥ 60 bars) else REST 200 bars (15 s). */
async function candles(symbol, timeframe) {
  const tfNorm = ({ '1h': '1H', '4h': '4H', '1d': '1D' })[pyLower(timeframe)] || timeframe;
  try {
    const df = await bridge.cachedCandles(symbol, tfNorm);
    if (df && df.length >= 60) return df;
  } catch (_e) { /* bot: except Exception: pass */ }
  const f = fetcher();
  if (!f) return null;
  try {
    return await withTimeout(f.getCandles(symbol, timeframe, 200), CANDLES_TIMEOUT_MS);
  } catch (e) {
    log().debug(`[MINIAPP] candles ${symbol} ${timeframe}: ${e && e.message}`);
    return null;
  }
}

function query(req) {
  return Y.queryToPairs(Y.rawQuery(req.originalUrl));
}

// ── handlers ─────────────────────────────────────────────────────────────
async function hDashboard(req, res) {
  const user = loadUser(req);
  const t = now();
  let stats = { days: 30, signals: 0, trades: 0, wins: 0, win_rate: 0.0, total_rr: 0.0, rr_7d: 0.0 };
  try {
    stats = SS.signalStats(db, user.user_id, 30, t);
  } catch (e) {
    log().warn(`[MINIAPP] dashboard stats: ${e && e.message}`);
  }
  const recent = SS.userSignals(db, user.user_id, { status: 'all', limit: 6, now: t });
  const mkt = await market();
  await attachLive(recent);
  let rating = null;
  try {
    rating = SS.strategyRating(db, 30, { now: t });   // [STRATEGY-RATING] все юзеры, кэш 15 мин
  } catch (e) {
    log().debug(`[MINIAPP] strategy rating: ${e && e.message}`);
  }
  let marketTrend = {};
  try {
    marketTrend = await bridge.marketTrend();         // [TREND-MONITOR] {"15m": {"trend","since"}, ...}
  } catch (e) {
    log().debug(`[MINIAPP] market trend: ${e && e.message}`);
  }
  const trend = trendWords(await bridge.globalTrend());
  return send(res, 200, { ok: true, stats, market: mkt, recent, trend, rating, market_trend: marketTrend });
}

async function hSignals(req, res) {
  const user = loadUser(req);
  const q = query(req);
  let status = Y.queryGet(q, 'status', 'all');
  if (!['all', 'open', 'closed'].includes(status)) status = 'all';
  let limit;
  try {
    limit = pyInt(Y.queryGet(q, 'limit', '50'));
  } catch (e) {
    if (!(e instanceof PyValueError)) throw e;
    limit = 50;
  }
  let strategy = pyUpper(Y.queryGet(q, 'strategy', '') || '');
  if (!STRATS.includes(strategy)) strategy = '';
  const sigs = SS.userSignals(db, user.user_id, { status, limit, strategy, now: now() });
  await attachLive(sigs);
  return send(res, 200, { ok: true, signals: sigs, strategy: strategy || 'ALL' });
}

async function hSignalChart(req, res, [tradeId]) {
  const user = loadUser(req);
  const t = now();
  if (!app().rateOk(user.user_id, 'chart', ...CHART_RATE_LIMIT, t)) return rateLimited(res, 6);   // [GET-RATE]
  const row = repo().getTrade(tradeId);
  if (!row || intOr0(row.user_id) !== user.user_id) return send(res, 404, { ok: false, error: 'not_found' });
  const sig = SS.signalView(row, t);
  const df = await candles(pyStrValue(row.symbol), sig.timeframe);
  if (!df || df.length < 30) return send(res, 200, { ok: false, error: 'no_data' });
  let payload = null;
  try {
    payload = charts.chartPayload(df, charts.signalChartArgs(row, sig), mdWarn());
  } catch (e) {
    log().warn(`[MINIAPP] chart ${sig.id}: ${e && e.message}`);
    payload = null;
  }
  if (!payload) return send(res, 200, { ok: false, error: 'no_data' });
  return send(res, 200, { ok: true, png: null, ...payload });
}

/** chart_renderer's logger: warning lines ([CHART-PMULT-MISMATCH]). */
function mdWarn() {
  const L = log();
  return { warning: (m) => L.warn(m) };
}

async function hSignalResult(req, res, [tradeId]) {
  const user = loadUser(req);
  const tid = String(tradeId || '');
  const body = req.body;
  const trades = repo();
  const trade = trades.getTrade(tid);
  if (!trade || intOr0(trade.user_id) !== Math.trunc(Number(user.user_id))) return send(res, 404, { ok: false, error: 'not_found' });
  const rNode = PB.field(body, 'result');
  const result = rNode !== undefined && PB.pyTruthy(rNode) ? pyStrip(pyUpper(PB.pyStr(rNode))) : '';
  const noteNode = PB.field(body, 'note');
  const note = noteNode === undefined || noteNode.t === 'none' ? null : noteNode;
  if (!result && note === null) return bad(res, 'result');
  if (result) {
    if (!MANUAL_RESULTS.includes(result)) return bad(res, 'result');
    if (truthy(trade.order_id)) return send(res, 200, { ok: false, error: 'exchange_trade' });
    const cur = truthy(trade.result) ? trade.result : '';
    if (cur !== '' && cur !== 'SKIP') return send(res, 200, { ok: false, error: 'already_set', result: trade.result });
    const entry = floatOr0(trade.entry);
    const osl = floatOr0(trade.original_sl);
    const sl0 = osl !== 0 ? osl : floatOr0(trade.sl);
    const risk = Math.abs(entry - sl0);
    // как signal_rr: R от исходного стопа до цели; stored tp*_rr — запасной
    const rr = (tpKey, rrKey) => {
      const tp = floatOr0(trade[tpKey]);
      if (risk > 0 && tp > 0) return pyRound(Math.abs(tp - entry) / risk, 2);
      const v = floatOr0(trade[rrKey]);
      return v > 0 ? pyRound(v, 2) : 0.0;
    };
    const rrMap = { TP1: rr('tp1', 'tp1_rr'), TP2: rr('tp2', 'tp2_rr'), TP3: rr('tp3', 'tp3_rr'), SL: -1.0, BE: 0.0, SKIP: 0.0 };
    const saved = trades.setTradeResult(tid, result, rrMap[result], { allowOverwriteSkip: true, skipReason: result === 'SKIP' ? 'manual' : null });
    if (!saved || (truthy(saved.result) ? saved.result : '') !== result) {
      return send(res, 200, { ok: false, error: 'already_set', result: saved ? saved.result : null });
    }
    if (result === 'SKIP') trades.setTradeNote(tid, { skipReason: 'manual' });
    log().info(`[MANUAL-RESULT] uid=${user.user_id} tid=${tid} ${result}`);
  }
  if (note !== null) {
    if (note.t !== 'str' || Array.from(note.v).length > 500) return bad(res, 'note');
    trades.setTradeNote(tid, { note: pyStrip(note.v) });
  }
  const row = trades.getTrade(tid);
  const sig = row ? SS.signalView(row, now()) : null;
  if (sig) await attachLive([sig]);
  return send(res, 200, { ok: true, signal: sig });
}

async function hStats(req, res) {
  const user = loadUser(req);
  const q = query(req);
  const out = SS.statsForUser(db, user.user_id, {
    days: Y.queryGet(q, 'days', '30'),
    strategy: Y.queryGet(q, 'strategy', '') || '',
    tf: Y.queryGet(q, 'tf', '') || '',
    now: now(),
  });
  return send(res, 200, out);
}

async function hAnalyze(req, res) {
  const user = loadUser(req);
  // str(body.get("symbol", "")) / str(body.get("strategy", "AUTO")) with the body's Python types
  const b = {};
  for (const k of ['symbol', 'strategy']) {
    const n = PB.field(req.body, k);
    if (n !== undefined) b[k] = PB.pyStr(n);
  }
  const r = await shell().analyze(user, b, now());
  return send(res, r.status, r.body);
}

async function hShare(req, res) {
  const user = loadUser(req);
  const t = now();
  if (!app().rateOk(user.user_id, 'share', ...SHARE_RATE_LIMIT, t)) return send(res, 200, { ok: false, error: 'rate_limited' });
  const n = PB.field(req.body, 'days');
  let days;
  try {
    days = Math.max(7, Math.min(n === undefined ? 30 : PB.pyIntOf(n), 365));
  } catch (e) {
    if (!(e instanceof PyTypeError || e instanceof PyValueError)) throw e;   // int(inf): OverflowError → 500
    days = 30;
  }
  const stats = SS.signalStats(db, user.user_id, days, t);
  if (intOr0(stats.signals) <= 0) return send(res, 200, { ok: false, error: 'no_data' });
  // [SHARE-CARD] D3: the card is drawn by the client from these numbers (no bot chat to send to)
  log().info(`[MINIAPP] share uid=${user.user_id} days=${days} signals=${stats.signals}`);
  return send(res, 200, { ok: true, sent: false, days, stats });
}

/**
 * A str with an unpaired surrogate (json.loads keeps "\ud800") cannot be bound by sqlite3: the bot's
 * db_feedback_create raises UnicodeEncodeError → 'unavailable'. Returns str(e) or null.
 */
function surrogateError(text) {
  const cps = Array.from(text);
  const isSur = (ch) => ch.length === 1 && ch.charCodeAt(0) >= 0xd800 && ch.charCodeAt(0) <= 0xdfff;
  const i = cps.findIndex(isSur);
  if (i === -1) return null;
  let j = i;
  while (j + 1 < cps.length && isSur(cps[j + 1])) j++;
  if (j === i) {
    return `'utf-8' codec can't encode character '\\u${cps[i].charCodeAt(0).toString(16)}' in position ${i}: surrogates not allowed`;
  }
  return `'utf-8' codec can't encode characters in position ${i}-${j}: surrogates not allowed`;
}

function createTicket(user, fbType, text) {
  const enc = surrogateError(text);
  if (enc) throw new Error(enc);
  const support = D.support || require('../services/supportService');
  const lang = user.lang === 'en' ? 'en' : 'ru';
  const label = FEEDBACK_LABELS[lang][fbType] || FEEDBACK_LABELS[lang].bug;
  const ticket = support.create(user.user_id, { subject: `${label} · Mini App`, body: text });
  return Math.trunc(Number(ticket && ticket.id ? ticket.id : 0));
}

async function hFeedback(req, res) {
  const user = loadUser(req);
  const tNode = PB.field(req.body, 'type');
  const key = pyStrip(pyLower(tNode === undefined ? '' : PB.pyStr(tNode)));
  const fbType = Object.prototype.hasOwnProperty.call(FEEDBACK_TYPES, key) ? FEEDBACK_TYPES[key] : null;
  if (!fbType) return bad(res, 'type');
  const xNode = PB.field(req.body, 'text');
  const text = pyStrip(xNode !== undefined && PB.pyTruthy(xNode) ? PB.pyStr(xNode) : '');
  const len = Array.from(text).length;
  if (!(len >= 10 && len <= 2000)) return bad(res, 'text');
  const kv = require('../services/engineKvService');
  if (kv.incrDay('miniapp_feedback', user.user_id, { now: now() }) > FEEDBACK_PER_DAY) {
    return send(res, 200, { ok: false, error: 'rate_limited' });
  }
  let id;
  try {
    id = createTicket(user, fbType, text);
  } catch (e) {
    log().warn(`[MINIAPP] feedback create uid=${user.user_id}: ${e && e.message}`);
    return send(res, 200, { ok: false, error: 'unavailable' });
  }
  log().info(`[MINIAPP] feedback uid=${user.user_id} id=${id} type=${fbType}`);
  return send(res, 200, { ok: true, id });
}

function hEvents(req, res) {
  require('../services/sseService').handler(req, res);
}

// ── dispatch (aiohttp's router on yarl's view of the target) ─────────────
const PLAIN = new Map([
  ['/dashboard', { GET: hDashboard }],
  ['/signals', { GET: hSignals }],
  ['/stats', { GET: hStats }],
  ['/analyze', { POST: hAnalyze }],
  ['/share', { POST: hShare }],
  ['/feedback', { POST: hFeedback }],
  ['/events', { GET: hEvents }],
]);
const DYNAMIC = [
  [/^\/signals\/([^{}/]+)\/chart$/, { GET: hSignalChart }],
  [/^\/signals\/([^{}/]+)\/result$/, { POST: hSignalResult }],
];

function allowHeader(entry) {
  const m = Object.keys(entry);
  if (m.includes('GET')) m.push('HEAD');
  return m.sort().join(',');
}

/** The route of a request target (relative to /api/app): { entry, params } or null (→ the site's 404). */
function resolve(url) {
  const safe = Y.pathSafe(Y.rawPath(url));
  const plain = PLAIN.get(safe);
  if (plain) return { entry: plain, params: [] };
  for (const [re, e] of DYNAMIC) {
    const m = Y.matchDynamic(safe, re);
    if (m) return { entry: e, params: m };
  }
  return null;
}

/** The methods of the route `url` resolves to ([] → not one of these routes); app.js answers 404 / 405 from them. */
function methods(url) {
  const r = resolve(url);
  if (!r) return [];
  const m = Object.keys(r.entry);
  if (m.includes('GET')) m.push('HEAD');
  return m;
}

router.use((req, res, next) => {
  const r = resolve(req.url);
  if (!r) return next();
  const { entry, params } = r;
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const handler = entry[method];
  if (!handler) {
    return res.status(405).set('Allow', allowHeader(entry)).type('text/plain').send('405: Method Not Allowed');
  }
  try {
    const r = handler(req, res, params);
    if (r && typeof r.catch === 'function') r.catch(next);
  } catch (e) {
    next(e);
  }
  return undefined;
});

module.exports = router;
module.exports.configure = configure;
module.exports.resetState = resetState;
module.exports.methods = methods;
module.exports.trendWords = trendWords;
module.exports.CHART_RATE_LIMIT = CHART_RATE_LIMIT;
module.exports.SHARE_RATE_LIMIT = SHARE_RATE_LIMIT;
module.exports.FEEDBACK_PER_DAY = FEEDBACK_PER_DAY;
