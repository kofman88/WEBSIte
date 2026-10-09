/**
 * /api/app trade routes — the bot's exchange-key and position handlers of the Mini App
 * (miniapp_api.py) and its Telegram trade buttons (handlers/trading.py exec_trade,
 * handlers/quick_close.py) for the site's JWT user:
 *
 *   POST exchange/keys {exchange, api_key, api_secret, passphrase?}      h_exchange_keys
 *        !can(auto_trade) → pro_required · bucket "keys" 1 / 30 s → rate_limited (HTTP 200, message)
 *        · exchange ∉ (bybit, bingx, binance, okx) → bad_request "exchange" · len(api_key) < 10 →
 *        "api_key" · len(api_secret) < 10 → "api_secret" · OKX len(passphrase) < 4 → "passphrase" ·
 *        test_connection (Bybit with demo = user.bybit_demo, OKX with the passphrase) under 20 s:
 *        timeout → invalid_keys "timeout", exception → invalid_keys str(e)[:200], not ok →
 *        invalid_keys result.error[:200] · D15: a key that can withdraw → withdraw_permission, an
 *        unreadable permission set → permission_unknown (ru / en message, nothing stored) · saved
 *        encrypted, Bybit demo auto-switch (+ pybit session invalidated), trade_exchange = ex, the
 *        auth breaker reset → {ok, exchange, key_hint, balance_usdt?}
 *   POST exchange/keys/remove {exchange}                                 h_exchange_keys_remove
 *        bad exchange → bad_request "exchange"; keys gone; auto_trade off when it was the trade
 *        exchange (trade_exchange itself unchanged — quirk) → {ok: true}
 *   GET  positions                                                       h_positions
 *        bucket "positions" (MINIAPP_POSITIONS_PER_MIN 6 / 60 s → 429 Retry-After 10) · exchange =
 *        trade_exchange (anything else → bybit) · no keys (OKX: or no passphrase) → empty list ·
 *        get_dashboard under 8 s: timeout → unavailable "timeout", exception → unavailable
 *        str(e)[:200] (QUIRK: OKX get_dashboard returns (summary, positions), so the bot's
 *        three-way unpack always fails there: "not enough values to unpack (expected 3, got 2)") ·
 *        each position normalised like _build_positions_text → {ok, exchange, positions, orders_count}
 *   POST trades/{trade_id}/exec                                          exec_trade_<id>
 *   POST trades/{trade_id}/qc/half | full | force | be | wait            qc_half_ / qc_full_ /
 *                                                                        qc_full_force_ / qc_be_ /
 *                                                                        qc_holdlock_wait
 *   GET  trades/{trade_id}/progress                                      qc_refresh_<id>
 *
 * The button routes answer what the bot's callback did to the chat: {ok, outcome, error?,
 * message, alert, card, effects} — `effects` the ordered list (answer / edit / send / delete),
 * `message` the last message that stayed (else the alert / card text), `alert` the callback
 * answer, `card` the card's new text. exec / qc run in the trade-ops queue
 * (workers/tradeOpsWorker.js: per-trade lock for exec, per-user lock for both); the card edit
 * and the messages also reach the user as the card snapshot + `trade` notifications. A
 * placement that outlives EXEC_WAIT_S answers {ok: true, pending: true} and goes on; its result
 * arrives as the notification. progress = {ok, text, pnl} or no_data.
 *
 * D16 (docs/PORT_DECISIONS.md): a trade id that is not the JWT user's → 404 not_found before any
 * handler work (the bot's exec_trade never checks the owner; its quick-close handlers do); exec
 * and the money quick-close actions also need their button on the delivered card
 * (signal_card_json actions) — the only way the bot reaches those handlers.
 *
 * Request / response mechanics as the other /api/app routers: mounted from routes/app.js after
 * its auth, Cache-Control and generic POST bucket; the raw target matched like aiohttp / yarl
 * (Y.pathSafe + dynamic segments decoded after the match, `{` / `}` / `/` never part of an id);
 * a known path with another method → 405 + Allow; bodies with their Python types (pyBody.js);
 * the answer bytes are json.dumps with the Python float types (aioResponse / pyjson).
 */

'use strict';

const express = require('express');
const ts = require('../services/traderSettingsService');
const keysSvc = require('../services/exchangeKeysService');
const exchanges = require('../services/exchanges');
const CM = require('../services/autotrade/confirmMode');
const QC = require('../services/autotrade/quickClose');
const Y = require('../services/engine/yarlUrl');
const PB = require('../services/engine/pyBody');
const { pyJsonDumpsTyped, FLOAT } = require('../services/engine/pyjson');
const { writeResponse, JSON_UTF8, TEXT_UTF8 } = require('../services/engine/aioResponse');
const { intOrUndefined } = require('../strategies/common/pynum');
const { pyLower, pyStrip } = require('../strategies/common/pyUnicode');
const { pyRound } = require('../strategies/common/pyround');
const {
  PyError, ValueError, pyFloat, pyInt, pyGet, pyTruthy, pyStr, pyLen, pyIter, isDict, errStr, pySlice,
} = require('../services/exchanges/pyCompat');

const router = express.Router();
const app = () => require('./app');                 // routes/app.js owns the rate buckets

const KEYS_RATE_LIMIT = [1, 30.0];                   // [AUDIT A-3]
// (int(os.getenv("MINIAPP_POSITIONS_PER_MIN", "6") or 6), 60.0)
const POSITIONS_RATE_LIMIT = [process.env.MINIAPP_POSITIONS_PER_MIN ? (intOrUndefined(process.env.MINIAPP_POSITIONS_PER_MIN) ?? 6) : 6, 60.0];
const DASHBOARD_TIMEOUT_S = 8;
const EXEC_WAIT_S = 25;                              // the app's request timeout is 30 s for trade calls
const EXCHANGES = keysSvc.EXCHANGES;
const QC_BUTTON = Object.freeze({ half: 'qc_half_', full: 'qc_full_', force: 'qc_full_', be: 'qc_be_' });
const QC_OK = Object.freeze(['closed_half', 'closed', 'be_set', 'wait']);

const D = {
  clock: () => Date.now() / 1000, log: null, registry: null, candles: null, tradeOps: null, execWaitS: EXEC_WAIT_S,
  testTimeoutS: null, permissionTimeoutS: null, dashboardTimeoutS: null,
};
let _winston = null;
/** The route / service logger: D.log, else the site's winston logger with the engine's `warning` name. */
function log() {
  if (D.log) return D.log;
  if (!_winston) {
    const w = require('../utils/logger');
    _winston = { debug: (m) => w.debug(m), info: (m) => w.info(m), warn: (m) => w.warn(m), warning: (m) => w.warn(m), error: (m) => w.error(m) };
  }
  return _winston;
}
const now = () => D.clock();

/** Tests: { clock, log, registry, candles, tradeOps, execWaitS, testTimeoutS, permissionTimeoutS, dashboardTimeoutS } (null → the default). */
function configure(o = {}) {
  for (const k of Object.keys(D)) if (Object.prototype.hasOwnProperty.call(o, k)) D[k] = o[k];
  if (!D.clock) D.clock = () => Date.now() / 1000;
  if (D.execWaitS === null || D.execWaitS === undefined) D.execWaitS = EXEC_WAIT_S;
}

const tradeOps = () => D.tradeOps || require('../workers/tradeOpsWorker').client();
const deps = () => ({
  registry: D.registry || undefined, log: log(), testTimeoutS: D.testTimeoutS, permissionTimeoutS: D.permissionTimeoutS,
});

const F = FLOAT;
const TYPES = Object.freeze({
  keys: { balance_usdt: F },
  positions: { positions: [{ size: F, entry: F, mark: F, pnl_usd: F, pnl_pct: F }] },
  progress: { pnl: { price: F, pnl_pct: F, pnl_r: F, dist_to_tp1_pct: F, dist_to_sl_pct: F } },
});

function send(res, status, body, types = null) {
  return writeResponse(res, status, JSON_UTF8, pyJsonDumpsTyped(body, types));
}
const bad = (res, key) => send(res, 200, { ok: false, error: 'bad_request', message: key });
const notFound = (res) => send(res, 404, { ok: false, error: 'not_found' });

/** _rate_limited_response(retry_s): HTTPTooManyRequests (no Cache-Control) with Retry-After. */
function rateLimited(res, retryS) {
  res.removeHeader('Cache-Control');
  res.set('Retry-After', String(retryS));
  return send(res, 429, { ok: false, error: 'rate_limited', message: `Слишком часто. Повторите через ${retryS} с` });
}

function loadUser(req) {
  return ts.getOrCreate(req.userId);
}
const opts = (req) => ({ admin: Boolean(req.isAdmin) });

/** str(body.get(k, "")) */
function strField(body, k) {
  const n = PB.field(body, k);
  return n === undefined ? '' : PB.pyStr(n);
}
/** str(body.get(k, "") or "") */
function strOrEmpty(body, k) {
  const n = PB.field(body, k);
  return n !== undefined && PB.pyTruthy(n) ? PB.pyStr(n) : '';
}
const cpLen = (s) => Array.from(s).length;

// ── exchange keys ────────────────────────────────────────────────────────
async function hExchangeKeys(req, res) {
  const user = loadUser(req);
  if (!ts.can(user, 'auto_trade', opts(req))) return send(res, 200, { ok: false, error: 'pro_required' });   // [UX-2]
  if (!app().rateOk(user.user_id, 'keys', ...KEYS_RATE_LIMIT, now())) {
    return send(res, 200, { ok: false, error: 'rate_limited', message: 'Проверка ключей — не чаще раза в 30 секунд' });
  }
  const body = req.body;
  const ex = pyStrip(pyLower(strField(body, 'exchange')));
  if (!EXCHANGES.includes(ex)) return bad(res, 'exchange');
  const key = pyStrip(strOrEmpty(body, 'api_key'));
  const secret = pyStrip(strOrEmpty(body, 'api_secret'));
  const passphrase = pyStrip(strOrEmpty(body, 'passphrase'));
  if (cpLen(key) < 10) return bad(res, 'api_key');
  if (cpLen(secret) < 10) return bad(res, 'api_secret');
  if (ex === 'okx' && cpLen(passphrase) < 4) return bad(res, 'passphrase');
  const r = await keysSvc.connectKeys(user, ex, key, secret, passphrase, deps());
  return send(res, 200, r.body, TYPES.keys);
}

async function hExchangeKeysRemove(req, res) {
  const user = loadUser(req);
  const ex = pyStrip(pyLower(strField(req.body, 'exchange')));
  if (!EXCHANGES.includes(ex)) return bad(res, 'exchange');
  return send(res, 200, keysSvc.removeKeys(user, ex, deps()).body);
}

// ── positions ────────────────────────────────────────────────────────────
/** `a, b, c = value` of a tuple / list — ValueError with CPython's text otherwise. */
function unpack3(v) {
  if (!Array.isArray(v)) {
    if (v === null || v === undefined) throw new PyError('TypeError', 'cannot unpack non-iterable NoneType object');
    if (isDict(v) || typeof v === 'string') v = pyIter(v);
    else throw new PyError('TypeError', `cannot unpack non-iterable ${typeof v === 'number' ? (Number.isInteger(v) ? 'int' : 'float') : typeof v} object`);
  }
  if (v.length < 3) throw ValueError(`not enough values to unpack (expected 3, got ${v.length})`);
  if (v.length > 3) throw ValueError('too many values to unpack (expected 3)');
  return v;
}

const orOf = (...vals) => {
  for (let i = 0; i < vals.length - 1; i++) if (pyTruthy(vals[i])) return vals[i];
  return vals[vals.length - 1];
};

/** _position(p, ex): the normalisation of handlers/trading.py _build_positions_text. */
function position(p, ex) {
  const g = (k) => pyGet(p, k);
  const sym = pyStr(orOf(g('symbol'), ''));
  const side = pyStr(orOf(g('side'), ''));
  const ep = pyFloat(orOf(g('avgPrice'), g('entryPrice'), 0));
  const mp = pyFloat(orOf(g('markPrice'), 0));
  const pnl = pyFloat(orOf(g('unrealisedPnl'), 0));
  let lev;
  try {
    lev = pyInt(pyFloat(orOf(g('leverage'), 1)));
  } catch (e) {
    if (!(e instanceof PyError) || !['TypeError', 'ValueError'].includes(e.pyType)) throw e;   // inf → OverflowError escapes
    lev = 1;
  }
  let pnlPct = ep > 0 ? (mp - ep) / ep * 100 * lev : 0.0;
  if (['SHORT', 'Sell', 'short'].includes(side)) pnlPct = -pnlPct;
  let size;
  try {
    size = Math.abs(pyFloat(orOf(g('size'), g('positionAmt'), 0)));
  } catch (e) {
    if (!(e instanceof PyError) || !['TypeError', 'ValueError'].includes(e.pyType)) throw e;
    size = 0.0;
  }
  const symbol = sym.endsWith('USDT') || sym.endsWith('-USDT-SWAP')
    ? sym.split('-USDT-SWAP').join('').split('-USDT').join('').split('USDT').join('')
    : sym;
  return {
    exchange: ex,
    symbol,
    side: ['LONG', 'Buy', 'long'].includes(side) ? 'LONG' : 'SHORT',
    size, entry: ep, mark: mp, pnl_usd: pyRound(pnl, 2), pnl_pct: pyRound(pnlPct, 2), leverage: lev,
  };
}

async function hPositions(req, res) {
  const user = loadUser(req);
  // [GET-RATE 2026-10] (SEC-3) 3 signed exchange requests per call
  if (!app().rateOk(user.user_id, 'positions', ...POSITIONS_RATE_LIMIT, now())) return rateLimited(res, 10);
  let ex = pyTruthy(user.trade_exchange) ? user.trade_exchange : 'bybit';
  if (!EXCHANGES.includes(ex)) ex = 'bybit';
  const [key, secret, pp] = keysSvc.exchangeKeys(user.user_id, ex);
  if (!key || !secret || (ex === 'okx' && !pp)) return send(res, 200, { ok: true, exchange: ex, positions: [], orders_count: 0 });
  const t = exchanges.getTrader(ex, { registry: D.registry || undefined }).instance({ demo: false });
  const dash = () => {
    if (ex === 'bingx' || ex === 'binance') return t.getDashboard(key, secret);
    if (ex === 'okx') return t.getDashboard(key, secret, pp);
    return t.getDashboard(key, secret, Boolean(user.bybit_demo));
  };
  let positions;
  let orders;
  try {
    [positions, orders] = unpack3(await keysSvc.waitFor(dash, D.dashboardTimeoutS === null || D.dashboardTimeoutS === undefined ? DASHBOARD_TIMEOUT_S : D.dashboardTimeoutS));
  } catch (e) {
    if (e && e.isTimeout) return send(res, 200, { ok: false, error: 'unavailable', message: 'timeout' });
    log().info(`[MINIAPP] positions uid=${user.user_id} ${ex}: ${(e && (e.pyType || e.name)) || 'Exception'}`);
    return send(res, 200, { ok: false, error: 'unavailable', message: pySlice(errStr(e), 200) });
  }
  const out = [];
  for (const p of pyTruthy(positions) ? pyIter(positions) : []) {
    try {
      if (!isDict(p)) throw new PyError('TypeError', 'cannot convert dictionary update sequence element #0 to a sequence');
      out.push(position({ ...p }, ex));
    } catch (e) {
      log().debug(`[MINIAPP] position parse: ${errStr(e)}`);
    }
  }
  return send(res, 200, { ok: true, exchange: ex, positions: out, orders_count: pyLen(pyTruthy(orders) ? orders : []) }, TYPES.positions);
}

// ── trade buttons ────────────────────────────────────────────────────────
function tradeRow(tradeId) {
  return CM.getTrade({}, tradeId);
}
const owned = (row, req) => Boolean(row) && row.user_id !== null && Number(row.user_id) === Number(req.userId);

/** The summary body of a button handler's effects. */
function buttonBody(r, okOutcomes) {
  const ok = okOutcomes.includes(r.outcome);
  const s = CM.summarize(r.effects);
  const out = { ok, outcome: r.outcome };
  if (!ok) out.error = r.outcome;
  out.message = s.message;
  out.alert = s.alert;
  out.card = s.card;
  out.effects = r.effects;
  return out;
}

/** Waits up to `waitS` for a trade-ops job; past it → {pending: true} (the job goes on). */
function awaitJob(job, waitS) {
  return new Promise((resolve, reject) => {
    let done = false;
    const h = setTimeout(() => { if (!done) { done = true; resolve({ pending: true }); } }, Math.max(0, waitS * 1000));
    if (h && h.unref) h.unref();
    job.then((v) => { if (!done) { done = true; clearTimeout(h); resolve({ value: v }); } },
      (e) => { if (!done) { done = true; clearTimeout(h); reject(e); } else log().error(`[TRADE-OPS] job failed after the answer: ${errStr(e)}`); });
  });
}

async function runButton(req, res, kind, payload, okOutcomes) {
  let w;
  try {
    w = await awaitJob(tradeOps().submit(kind, payload), D.execWaitS);
  } catch (e) {
    if (e && (e.code === 'worker_lost' || e.code === 'unavailable')) {
      log().error(`[TRADE-OPS] ${kind} uid=${payload.userId} tid=${payload.tradeId}: ${e.code}`);
      return send(res, 200, { ok: false, error: 'unavailable' });
    }
    throw e;
  }
  if (w.pending) return send(res, 200, { ok: true, pending: true });
  return send(res, 200, buttonBody(w.value, okOutcomes));
}

async function hExec(req, res, [tradeId]) {
  loadUser(req);                                          // _load_user: the row exists for the job
  const row = tradeRow(tradeId);
  if (!owned(row, req) || !CM.cardOffers(row, `exec_trade_${tradeId}`)) return notFound(res);    // D16
  return runButton(req, res, 'exec', { userId: req.userId, admin: Boolean(req.isAdmin), tradeId }, ['opened']);
}

function hQc(action) {
  return async (req, res, [tradeId]) => {
    loadUser(req);
    if (action !== 'wait') {
      const row = tradeRow(tradeId);
      if (!owned(row, req) || !CM.cardOffers(row, `${QC_BUTTON[action]}${tradeId}`)) return notFound(res);   // D16
    }
    return runButton(req, res, 'qc', { userId: req.userId, admin: Boolean(req.isAdmin), tradeId, action }, QC_OK);
  };
}

async function hProgress(req, res, [tradeId]) {
  const user = loadUser(req);
  const row = tradeRow(tradeId);
  if (!owned(row, req)) return notFound(res);              // D16 (cb_qc_refresh checks the owner itself)
  const bridge = require('../services/engine/engineBridge');
  const r = await QC.cbQcRefresh(user, String(tradeId), {
    log: log(), now, candles: D.candles || ((symbol, tf) => bridge.cachedCandles(symbol, tf)),
  });
  if (r.outcome !== 'progress') return send(res, 200, buttonBody(r, []));
  return send(res, 200, { ok: true, outcome: r.outcome, text: r.text, pnl: r.pnl, effects: r.effects }, TYPES.progress);
}

// ── dispatch (aiohttp's router on yarl's view of the target) ─────────────
const PLAIN = new Map([
  ['/exchange/keys', { POST: hExchangeKeys }],
  ['/exchange/keys/remove', { POST: hExchangeKeysRemove }],
  ['/positions', { GET: hPositions }],
]);
const DYNAMIC = [
  [/^\/trades\/([^{}/]+)\/exec$/, { POST: hExec }],
  [/^\/trades\/([^{}/]+)\/qc\/half$/, { POST: hQc('half') }],
  [/^\/trades\/([^{}/]+)\/qc\/full$/, { POST: hQc('full') }],
  [/^\/trades\/([^{}/]+)\/qc\/force$/, { POST: hQc('force') }],
  [/^\/trades\/([^{}/]+)\/qc\/be$/, { POST: hQc('be') }],
  [/^\/trades\/([^{}/]+)\/qc\/wait$/, { POST: hQc('wait') }],
  [/^\/trades\/([^{}/]+)\/progress$/, { GET: hProgress }],
];

function allowHeader(entry) {
  const m = Object.keys(entry);
  if (m.includes('GET')) m.push('HEAD');
  return m.sort().join(',');
}

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
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const handler = r.entry[method];
  if (!handler) return writeResponse(res, 405, TEXT_UTF8, '405: Method Not Allowed', { Allow: allowHeader(r.entry) });
  try {
    const p = handler(req, res, r.params);
    if (p && typeof p.catch === 'function') p.catch(next);
  } catch (e) {
    next(e);
  }
  return undefined;
});

module.exports = router;
module.exports.configure = configure;
module.exports.methods = methods;
module.exports.position = position;
module.exports.unpack3 = unpack3;
module.exports.buttonBody = buttonBody;
module.exports.TYPES = TYPES;
module.exports.KEYS_RATE_LIMIT = KEYS_RATE_LIMIT;
module.exports.POSITIONS_RATE_LIMIT = POSITIONS_RATE_LIMIT;
module.exports.DASHBOARD_TIMEOUT_S = DASHBOARD_TIMEOUT_S;
module.exports.EXEC_WAIT_S = EXEC_WAIT_S;
