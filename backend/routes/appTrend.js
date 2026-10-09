/**
 * /api/app/trend, /api/app/trend/notify — the bot's Telegram-only trend commands as app routes
 * (decision D10; handlers/trend.py, signal-pipeline.md §15):
 *
 *   GET  trend          the /trend command: { ok, trend: trend_monitor.get_all(), text, parse_mode, notify }
 *                       — `text` is the bot's reply verbatim («📊 <b>Тренд BTC</b>», one line per TF with
 *                       «· сила N%» when measured and the EMA pair, «✅ В приоритете лонги|шорты» when 15m
 *                       is directional; «Тренд ещё считается — подождите пару минут.» without state);
 *                       `notify` = no `trend_notify_off_<uid>` opt-out in engine_kv
 *   POST trend/notify   {on}: on=false is the «🔕 Не присылать смену тренда» button (cb_trend_notify_off:
 *                       kv `trend_notify_off_<uid>` = "1", the alert text by lang), on=true is /trend_on
 *                       (key deleted, its reply) → { ok, notify, message }; a failed write → { ok: false,
 *                       error: 'unavailable', message } and the bot's warning line; no `on` → bad_request
 *
 * get_all() is the engine worker's trend monitor, read through the engine bridge (marketTrend) while the
 * worker runs; without a worker in this process the state it persisted (engine_kv trend_state_v1) is
 * loaded into a read-only monitor (load_state, no strength — the bot's state right after a restart).
 * Mounted from routes/app.js after its auth, `Cache-Control: no-store` and the generic POST bucket.
 */

'use strict';

const express = require('express');
const ts = require('../services/traderSettingsService');
const tm = require('../services/engine/trendMonitor');
const { pyBool } = require('../services/engine/pycoerce');
const logger = require('../utils/logger');

const router = express.Router();
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const WORD = Object.freeze({ LONG: '📈 ЛОНГ', SHORT: '📉 ШОРТ', RANGE: '↔️ боковик' });
const WAIT = 'Тренд ещё считается — подождите пару минут.';
const TEXTS = Object.freeze({
  off: { ru: '🔕 Смена тренда больше не присылается. Включить: /trend_on', en: '🔕 Trend alerts are off. Turn on: /trend_on' },
  error: { ru: 'Ошибка, попробуйте позже', en: 'Error, try later' },
  on: '🔔 Уведомления о смене тренда включены.',
});
const quiet = { debug() {}, info() {}, warn() {}, warning() {}, error() {} };

const D = { log: null, all: null };
const log = () => D.log || logger;

/** Tests: { log, all: async () => get_all() } (null → the defaults). */
function configure(o = {}) {
  for (const k of Object.keys(D)) if (has(o, k)) D[k] = o[k];
}

/** trend_monitor.get_all() of the engine: the worker's (bridge) or the persisted state (read-only). */
async function trendAll() {
  if (D.all) return D.all();
  const bridge = require('../services/engine/engineBridge');
  if (bridge.hasRemote()) return bridge.marketTrend();
  const kv = require('../services/engineKvService');
  const mon = tm.createTrendMonitor({
    kv: { get: (k) => kv.get(k), set() {}, del() {}, has() { return false; } },
    cache: { getCandles: () => null, setCandles() {} },
    fetcher: null, send: null, log: quiet, env: {},
  });
  mon.loadState();
  return mon.getAll();
}

/** handlers/trend.cmd_trend: the reply text and its parse_mode. */
function trendText(all) {
  if (!all || typeof all !== 'object' || !Object.keys(all).length) return { text: WAIT, parse_mode: null };
  const lines = ['📊 <b>Тренд BTC</b>'];
  for (const tf of tm.TFS) {
    const s = all[tf];
    if (!s || typeof s !== 'object' || !Object.keys(s).length) continue;
    const st = s.strength !== undefined && s.strength !== null ? ` · сила ${s.strength}%` : '';
    const word = has(WORD, s.trend) ? WORD[s.trend] : s.trend;
    lines.push(`${tm.tfLabel(tf)}: <b>${word}</b>${st} <i>(EMA ${s.ema === undefined ? '' : s.ema})</i>`);
  }
  const t15 = all['15m'] && typeof all['15m'] === 'object' ? all['15m'].trend : null;
  if (t15 === 'LONG' || t15 === 'SHORT') lines.push('', `✅ В приоритете ${t15 === 'LONG' ? 'лонги' : 'шорты'}`);
  return { text: lines.join('\n'), parse_mode: 'HTML' };
}

function wrap(fn) {
  return (req, res, next) => {
    try {
      const r = fn(req, res);
      if (r && typeof r.catch === 'function') r.catch(next);
    } catch (e) {
      next(e);
    }
  };
}

router.get('/trend', wrap(async (req, res) => {
  const user = ts.getOrCreate(req.userId);
  let all = {};
  try { all = (await trendAll()) || {}; } catch (e) { log().debug(`[TREND-MONITOR] app trend: ${e && e.message}`); all = {}; }
  const { text, parse_mode: parseMode } = trendText(all);
  let notify = true;
  try { notify = !tm.isOptedOut(user.user_id); } catch (_e) { notify = true; }
  res.json({ ok: true, trend: all, text, parse_mode: parseMode, notify });
}));

router.post('/trend/notify', wrap((req, res) => {
  const user = ts.getOrCreate(req.userId);
  const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  if (!has(b, 'on')) return res.json({ ok: false, error: 'bad_request', message: 'on' });
  const on = pyBool(b.on);
  const uid = user.user_id;
  if (!on) {
    // cb_trend_notify_off: lang = getattr(user, "lang", "ru") or "ru"; the alert is EN only for "en"
    const en = (user.lang || 'ru') === 'en';
    try {
      tm.setOptedOut(uid, true);
    } catch (e) {
      log().warn(`trend_notify_off uid=${uid}: ${e && e.message}`);
      return res.json({ ok: false, error: 'unavailable', message: en ? TEXTS.error.en : TEXTS.error.ru });
    }
    return res.json({ ok: true, notify: false, message: en ? TEXTS.off.en : TEXTS.off.ru });
  }
  try {
    tm.setOptedOut(uid, false);                     // cmd_trend_on: RU replies only
  } catch (e) {
    log().warn(`trend_on uid=${uid}: ${e && e.message}`);
    return res.json({ ok: false, error: 'unavailable', message: TEXTS.error.ru });
  }
  return res.json({ ok: true, notify: true, message: TEXTS.on });
}));

module.exports = router;
module.exports.configure = configure;
module.exports.trendText = trendText;
module.exports.TEXTS = TEXTS;
