'use strict';
/**
 * signalDelivery — the main-thread side of every Telegram call the engine makes
 * (PLAN M9: "feed row + notifier + commit callbacks"; signal-pipeline.md §8).
 *
 * The scanners, the trend monitor, the tracker and the background loops run in the engine
 * worker (workers/engineWorker.js); the notifications table, the SSE client registry and the
 * Telegram mirror live in the main thread. The worker talks to this module through the RPC
 * client `createRemoteDelivery(post)` (same interface, message protocol below); tests and an
 * in-process engine use `createSignalDelivery()` directly.
 *
 * Bot call                                       → site (this module)
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * safe_send_message(card, reply_markup=kb,        deliver({kind:'card', userId, tradeId, strategy,
 *   protect_content=True,                           symbol, direction, text, keyboard, lang, silent})
 *   disable_notification=quiet,                   → notifier.dispatch(type 'signal'): the feed row
 *   on_sent=remember_signal_message(trade_id))      (notifications), SSE `notification` + `signal`
 *                                                   {kind:'card', trade_id, html, actions, …}, the
 *                                                   Telegram mirror when not silent; then the on_sent
 *                                                   callback: signal_trades.signal_msg_id = the
 *                                                   notification id, signal_card_json =
 *                                                   cardSnapshot({html, actions, lang}). → true.
 *                                                   'user_not_found' (deleted / inactive user) → false
 *                                                   (the bot's "chat not found / blocked" → False).
 * free "Pro preview" (no row, no keyboard)        deliver({kind:'preview'}) → type 'signal', SSE
 *                                                   {kind:'preview'}, link to the plan page; never silent.
 * counter-trend / limit notices (auto-trade)      deliver({kind:'notice', type:'trade'}) → type 'trade'.
 * send_signal_chart_bg (photo reply)              deliverChart({...}) → SSE `signal` {kind:'chart',
 *                                                   trade_id, chart}; the picture is drawn by the client
 *                                                   from GET /api/app/signals/:id/chart (D3) — no DB write.
 * bot.send_message(uid, text) (trend change,      sendText(uid, text, {type, silent, keyboard, lang})
 *   evening report, …)                              → notifier.dispatch(type) → true / false.
 * bot.send_message(ADMIN_ID, alert) (_guarded,    alertAdmins(text) → type 'security' to every active
 *   _guarded_restart, HealthMonitor)                admin (users.is_admin = 1) → number sent.
 * tracker progress notices / card edits           dispatch(uid, opts) / broadcast(uid, event, data)
 *                                                   pass-throughs (signalTracker's notifier / sse).
 * bot.send_message(uid, text, parse_mode=…,       sendMessage(uid, text, {parseMode, replyMarkup, protectContent,
 *   reply_markup=…, …) inside telegram_safe         disableNotification, disableWebPagePreview, site}) — the aiogram
 *   (the LEVELS / VOLUME scanners call it through   contract of scanner_mid / volume_scanner: the delivered Message
 *   their safe_send_message port)                   {message_id (= notifications.id), html, actions, lang}, or an
 *                                                   Error named like aiogram's (TelegramForbiddenError for a
 *                                                   deleted / inactive user, TelegramBadRequest for an empty text
 *                                                   or a failed dispatch, TelegramNetworkError when the main
 *                                                   thread did not answer). `site` = how the site files it:
 *                                                   {tradeId} → a card (deliver kind 'card': strategy / symbol /
 *                                                   direction from the signal_trades row, signal_msg_id + snapshot),
 *                                                   else a notice of type site.type ('trade' | 'report', default
 *                                                   'report'). The scheduler sets it (scheduler.siteSafeSend).
 *
 * Commit callbacks: deliver() answers the bot's `safe_send_message` boolean, and that answer
 * drives the scanner-side commits exactly like the bot — the signal registry lives in the worker,
 * so `_send_smc_card_bg` (and the LEVELS / VOLUME senders) call commit_send / commit_send_multi
 * after a delivered card (or an executed trade) and mark an undelivered, untraded row SKIP
 * (`not_delivered`); the on_sent part (signal_msg_id + card snapshot) is done here, before the
 * answer goes back, so a committed slot always has its feed row.
 *
 * Telegram-only parameters: `reply_markup` → action descriptors (in-app buttons; the Telegram
 * mirror has no keyboard — telegramService.send takes text only); `protect_content` has no
 * site equivalent; `disable_notification` (quiet hours) → `silent`: in-app + SSE only, no
 * e-mail / Telegram mirror / web push (notifier, M10a).
 *
 * Trade buttons (the bot's callback_data on a card / trade notice) → the site route the client calls
 * (`actionRoute`; every client-facing `actions` row carries `api: {method, path}` for them, the
 * stored card snapshot keeps the bot's descriptors):
 *   exec_trade_<id>      POST trades/<id>/exec       (handlers/trading.exec_trade — confirm mode)
 *   qc_half_<id>         POST trades/<id>/qc/half    qc_full_<id>        POST trades/<id>/qc/full
 *   qc_full_force_<id>   POST trades/<id>/qc/force   qc_be_<id>          POST trades/<id>/qc/be
 *   qc_refresh_<id>      GET  trades/<id>/progress   qc_holdlock_wait    POST trades/<trade>/qc/wait
 * (routes/appTrade.js: D16 owner + "the button is on the delivered card" checks before any work).
 *
 * Worker ↔ main RPC (structured-clone payloads):
 *   worker → main  { type: 'rpc', id, method, args }        answered by
 *   main → worker  { type: 'rpc-result', id, ok: true, result } | { …, ok: false, error }
 *   worker → main  { type: 'call', method, args }            fire-and-forget (no answer)
 *   methods: deliver, deliverChart, sendText, sendMessage, alertAdmins, dispatch, broadcast, broadcastAll.
 */

const { noticeTitle, signalLink } = require('./signalTracker');

const ACTION_ROUTES = Object.freeze([
  [/^exec_trade_(.+)$/, 'POST', 'exec'],
  [/^qc_half_(.+)$/, 'POST', 'qc/half'],
  [/^qc_full_force_(.+)$/, 'POST', 'qc/force'],
  [/^qc_full_(.+)$/, 'POST', 'qc/full'],
  [/^qc_be_(.+)$/, 'POST', 'qc/be'],
  [/^qc_refresh_(.+)$/, 'GET', 'progress'],
]);

/** A trade button's callback_data → {method, path} of its /api/app route (path relative to /api/app/), else null. */
function actionRoute(action, tradeId = null) {
  const a = String(action === null || action === undefined ? '' : action);
  if (a === 'qc_holdlock_wait') {
    return tradeId ? { method: 'POST', path: `trades/${encodeURIComponent(String(tradeId))}/qc/wait` } : null;
  }
  for (const [re, method, tail] of ACTION_ROUTES) {
    const m = re.exec(a);
    if (m) return { method, path: `trades/${encodeURIComponent(m[1])}/${tail}` };
  }
  return null;
}

/** keyboard rows → a copy whose trade buttons carry `api` (the rows the client gets); other buttons as they are. */
function withActionRoutes(rows, tradeId = null) {
  if (!Array.isArray(rows)) return rows === undefined ? null : rows;
  return rows.map((row) => (Array.isArray(row) ? row.map((b) => {
    if (!b || typeof b !== 'object' || b.kind === 'url') return b;
    const api = actionRoute(b.action, tradeId);
    return api ? { ...b, api } : b;
  }) : row));
}

const RPC_METHODS = Object.freeze(['deliver', 'deliverChart', 'sendText', 'sendMessage', 'alertAdmins', 'dispatch', 'broadcast', 'broadcastAll']);
const PLAN_LINK = '/app/?tab=settings&sec=plan';
const ADMIN_LINK = '/ops.html';
const ENGINE_TYPES = Object.freeze(['signal', 'progress', 'trend', 'report', 'trade']);
/** sendMessage failure answers: the aiogram exception names telegram_safe.safe_send_message classifies. */
const TG_ERRORS = Object.freeze({
  forbidden: Object.freeze({ name: 'TelegramForbiddenError', message: 'Telegram server says - Forbidden: user is deactivated' }),
  empty: Object.freeze({ name: 'TelegramBadRequest', message: 'Telegram server says - Bad Request: message text is empty' }),
  failed: Object.freeze({ name: 'TelegramBadRequest', message: 'Telegram server says - Bad Request: notification not stored' }),
  timeout: Object.freeze({ name: 'TelegramNetworkError', message: 'HTTP Client says - Request timeout error' }),
});

/** An Error carrying an aiogram exception name (what safe_send_message branches on). */
function telegramError(err) {
  const e = new Error(String((err && err.message) || 'Telegram error'));
  e.name = String((err && err.name) || 'TelegramBadRequest');
  if (err && err.retry_after !== undefined) e.retry_after = err.retry_after;
  return e;
}

/** {ok, message} | {ok: false, error} → the Message, or throw the named error (aiogram's bot.send_message). */
function unwrapSent(res) {
  if (res && res.ok) return res.message;
  throw telegramError(res && res.error ? res.error : TG_ERRORS.failed);
}

function fallbackLog() {
  return require('../marketData/mdLog').log;
}

/**
 * createSignalDelivery({ notifier, sse, repo, db, log }) — the main-thread implementation.
 *   notifier  { dispatch(userId, opts) }          (services/notifier)
 *   sse       { broadcast, broadcastAll } | null   (services/sseService)
 *   repo      { setSignalMsgId, cardSnapshot }     (signalTradesRepo.defaultRepo)
 *   db        better-sqlite3 handle (admin list)   (models/database)
 */
function createSignalDelivery(deps = {}) {
  const notifierOf = () => deps.notifier || require('../notifier');
  const sseOf = () => (deps.sse === undefined ? require('../sseService') : deps.sse);
  const repoOf = () => deps.repo || require('./signalTradesRepo').defaultRepo;
  const dbOf = () => deps.db || require('../../models/database');
  const log = deps.log || fallbackLog();
  const tgLog = deps.tgLog || log;   // telegram_safe's logger ("CHM.TgSafe")

  /**
   * telegram_safe.safe_send_message's line for a delivery that did not go out (deliver() and
   * sendText({safe: true}) stand for safe_send_message): a deleted / inactive user is the bot's
   * TelegramForbiddenError → INFO "blocked bot — notification lost"; an empty text is Telegram's
   * BadRequest "message text is empty"; a notification that was not stored is the BadRequest the
   * sendMessage contract answers (TG_ERRORS.failed). No user id → False without a line (`not user_id`).
   */
  function logNotSent(uid, reason) {
    if (!uid) return;
    if (reason === 'user_not_found') {
      tgLog.info(`[TG-SAFE] uid=${uid} blocked bot — notification lost`);
    } else {
      const err = reason === 'empty' ? TG_ERRORS.empty : TG_ERRORS.failed;
      tgLog.warning(`[TG-SAFE] uid=${uid} BadRequest: ${Array.from(err.message).slice(0, 150).join('')} — message dropped`);
    }
  }

  function sse(event, userId, data) {
    const s = sseOf();
    if (!s || typeof s.broadcast !== 'function') return 0;
    try { return s.broadcast(userId, event, data); } catch (e) { log.debug(`[DELIVERY] sse ${event}: ${e && e.message}`); return 0; }
  }

  /** trader_settings.lang of a user ('ru' when unknown) — the lang of a card the scanner did not name. */
  function langOf(uid) {
    try {
      const row = dbOf().prepare('SELECT lang FROM trader_settings WHERE user_id = ?').get(uid);
      return row && row.lang === 'en' ? 'en' : 'ru';
    } catch (_e) {
      return 'ru';
    }
  }

  /** One delivery → {ok, notificationId, reason}: the notifier answer behind deliver() and sendMessage(). */
  async function send(msg = {}) {
    const uid = Number(msg.userId);
    const text = String(msg.text || '');
    if (!uid || !text) return { ok: false, notificationId: null, reason: 'empty' };
    const kind = msg.kind || 'card';
    const lang = msg.lang || 'ru';
    const tradeId = msg.tradeId || null;
    let opts;
    if (kind === 'card') {
      opts = {
        type: 'signal', title: noticeTitle(text), body: text, tgText: text, link: signalLink(tradeId),
        silent: Boolean(msg.silent),
        data: {
          kind: 'card', trade_id: tradeId, strategy: msg.strategy || null, symbol: msg.symbol || null,
          direction: msg.direction || null, html: text, actions: withActionRoutes(msg.keyboard || null, tradeId), lang, silent: Boolean(msg.silent),
        },
      };
    } else if (kind === 'preview') {
      opts = {
        type: 'signal', title: noticeTitle(text), body: text, tgText: text, link: PLAN_LINK, silent: false,
        data: { kind: 'preview', strategy: msg.strategy || null, symbol: msg.symbol || null, direction: msg.direction || null, html: text, lang },
      };
    } else {
      const type = ENGINE_TYPES.includes(msg.type) ? msg.type : 'trade';
      opts = {
        type, title: noticeTitle(text), body: text, tgText: text, link: tradeId ? signalLink(tradeId) : null,
        silent: Boolean(msg.silent),
        data: { kind: 'notice', trade_id: tradeId, strategy: msg.strategy || null, html: text, actions: withActionRoutes(msg.keyboard || null, tradeId), lang },
      };
    }
    let res;
    try {
      res = await notifierOf().dispatch(uid, opts);
    } catch (e) {
      log.warning(`[DELIVERY] ${kind} uid=${uid}: ${e && e.message}`);
      return { ok: false, notificationId: null, reason: 'error' };
    }
    if (!res || !res.dispatched) return { ok: false, notificationId: null, reason: (res && res.error) || 'error' };
    if (kind === 'card' && tradeId && res.notificationId) {
      // on_sent=remember_signal_message(trade_id): the delivered card is now trackable
      try {
        const repo = repoOf();
        repo.setSignalMsgId(tradeId, res.notificationId, repo.cardSnapshot({ html: text, actions: msg.keyboard || null, lang }));
      } catch (e) {
        log.debug(`[SIGNAL-PROGRESS] remember msg tid=${tradeId}: ${e && e.message}`);
      }
    }
    return { ok: true, notificationId: res.notificationId === undefined ? null : res.notificationId, reason: null };
  }

  const d = {
    /** safe_send_message(...) of a card / preview / notice → Promise<bool> */
    async deliver(msg = {}) {
      const r = await send(msg);
      if (!r.ok) logNotSent(Number(msg.userId), r.reason);
      return r.ok;
    },

    /**
     * aiogram `bot.send_message(uid, text, **kwargs)` for the scanners' safe_send_message port →
     * {ok: true, message: {message_id, html, actions, lang}} | {ok: false, error: {name, message}}
     * (the remote / local facades turn the latter into the thrown error). `kw.site.tradeId` → the
     * signal card of that signal_trades row; otherwise a notice of type `kw.site.type`.
     */
    async sendMessage(userId, text, kw = {}) {
      const uid = Number(userId);
      const body = String(text || '');
      if (!uid || !body) return { ok: false, error: { ...TG_ERRORS.empty } };
      const site = (kw && kw.site) || {};
      const keyboard = (kw && kw.replyMarkup) || null;
      const silent = Boolean(kw && kw.disableNotification);
      const lang = site.lang || langOf(uid);
      let msg;
      if (site.tradeId) {
        let row = null;
        try { row = repoOf().getTrade(String(site.tradeId)); } catch (e) { log.debug(`[DELIVERY] card row ${site.tradeId}: ${e && e.message}`); }
        msg = {
          kind: 'card', type: 'signal', userId: uid, tradeId: String(site.tradeId),
          strategy: (row && row.strategy) || site.strategy || null, symbol: (row && row.symbol) || null,
          direction: (row && row.direction) || null, text: body, keyboard, lang, silent,
        };
      } else {
        msg = { kind: 'notice', type: ENGINE_TYPES.includes(site.type) ? site.type : 'report', userId: uid, text: body, keyboard, lang, silent };
      }
      const r = await send(msg);
      if (!r.ok) return { ok: false, error: { ...(r.reason === 'user_not_found' ? TG_ERRORS.forbidden : TG_ERRORS.failed) } };
      return { ok: true, message: { message_id: r.notificationId, html: body, actions: keyboard, lang } };
    },

    /** send_signal_chart_bg → the chart descriptor over SSE (the client draws it, D3). */
    deliverChart(msg = {}) {
      const uid = Number(msg.userId);
      if (!uid) return false;
      const chart = {
        symbol: msg.symbol || null, timeframe: msg.timeframe || null, strategy: msg.strategy || null,
        bars: msg.bars === undefined ? null : msg.bars, last_ts: msg.lastTs === undefined ? null : msg.lastTs,
        extra: msg.extra || null, lang: msg.lang || 'ru',
      };
      sse('signal', uid, { kind: 'chart', trade_id: msg.tradeId || null, chart });
      return true;
    },

    /** bot.send_message(uid, text, ...) for plain engine notices → Promise<bool> */
    async sendText(userId, text, opts = {}) {
      const uid = Number(userId);
      const body = String(text || '');
      if (!uid || !body) {
        if (opts.safe) logNotSent(uid, 'empty');
        return false;
      }
      const type = ENGINE_TYPES.includes(opts.type) ? opts.type : (ENGINE_TYPES.includes(opts.kind) ? opts.kind : 'report');
      try {
        const res = await notifierOf().dispatch(uid, {
          type, title: noticeTitle(body), body, tgText: body, link: opts.link || null, silent: Boolean(opts.silent),
          data: { kind: opts.kind || type, html: body, actions: withActionRoutes(opts.keyboard || null, opts.tradeId || null), lang: opts.lang || 'ru' },
        });
        const ok = Boolean(res && res.dispatched);
        if (!ok && opts.safe) logNotSent(uid, (res && res.error) || 'error');
        return ok;
      } catch (e) {
        log.warning(`[DELIVERY] ${type} uid=${uid}: ${e && e.message}`);
        if (opts.safe) logNotSent(uid, 'error');
        return false;
      }
    },

    /** for admin_id in config.ADMIN_IDS: bot.send_message(admin_id, text, parse_mode="HTML") */
    async alertAdmins(text) {
      const body = String(text || '');
      if (!body) return 0;
      let admins = [];
      try {
        admins = dbOf().prepare('SELECT id FROM users WHERE is_admin = 1 AND is_active = 1 ORDER BY id').all();
      } catch (e) {
        log.debug(`[DELIVERY] admin list: ${e && e.message}`);
        return 0;
      }
      let n = 0;
      for (const a of admins) {
        try {
          const res = await notifierOf().dispatch(a.id, { type: 'security', title: noticeTitle(body), body, tgText: body, link: ADMIN_LINK });
          if (res && res.dispatched) n += 1;
        } catch (e) {
          log.debug(`[DELIVERY] admin alert uid=${a.id}: ${e && e.message}`);
        }
      }
      return n;
    },

    /** notifier.dispatch pass-through (signalTracker progress notices). */
    async dispatch(userId, opts) {
      return notifierOf().dispatch(userId, opts);
    },

    broadcast(userId, event, data) {
      return sse(event, userId, data);
    },

    broadcastAll(event, data) {
      const s = sseOf();
      if (!s || typeof s.broadcastAll !== 'function') return 0;
      try { return s.broadcastAll(event, data); } catch (e) { log.debug(`[DELIVERY] sse all ${event}: ${e && e.message}`); return 0; }
    },

    /** One worker request → the method's result (whitelisted). */
    async handleRpc(method, args = []) {
      if (!RPC_METHODS.includes(method)) throw new Error(`unknown delivery method: ${method}`);
      return d[method](...(Array.isArray(args) ? args : []));
    },

    /**
     * Route one worker message: 'rpc' → `reply({type:'rpc-result', id, ok, result|error})`,
     * 'call' → run without an answer. Returns true when the message was a delivery message.
     */
    handleWorkerMessage(msg, reply) {
      if (!msg || (msg.type !== 'rpc' && msg.type !== 'call')) return false;
      const p = Promise.resolve().then(() => d.handleRpc(msg.method, msg.args));
      if (msg.type === 'rpc') {
        p.then((result) => reply({ type: 'rpc-result', id: msg.id, ok: true, result: result === undefined ? null : result }),
          (e) => reply({ type: 'rpc-result', id: msg.id, ok: false, error: String(e && e.message ? e.message : e) }));
      } else {
        p.catch((e) => log.debug(`[DELIVERY] call ${msg.method}: ${e && e.message}`));
      }
      return true;
    },
  };
  return d;
}

/**
 * createRemoteDelivery(post, {timeoutMs}) — the worker-side client: the same methods, each
 * one message to the main thread. `handleMessage(msg)` must be fed every main→worker message
 * (it settles 'rpc-result'). An unanswered request resolves to the method's failure value
 * (false / 0 / {error:'timeout'}) after timeoutMs — a stalled main thread never wedges a scan.
 */
function createRemoteDelivery(post, {
  timeoutMs = 60_000, setTimer = setTimeout, clearTimer = clearTimeout, defer = (fn) => setImmediate(fn),
} = {}) {
  let nextId = 1;
  const pending = new Map();   // id → {resolve, timer, fail}

  function rpc(method, args, failValue) {
    const id = nextId++;
    return new Promise((resolve) => {
      const timer = setTimer(() => {
        // After a stall of this thread (a long synchronous analysis, a frozen process) the answer
        // can already sit in the port's queue behind this timer — the timers phase runs before the
        // port's messages. Settle after them: a delivered card must not read as "not delivered"
        // (safe_send_message would resend it, SMC would mark the row SKIP).
        defer(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          resolve(failValue);
        });
      }, timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
      pending.set(id, { resolve, timer, failValue });
      try {
        post({ type: 'rpc', id, method, args });
      } catch (_e) {
        clearTimer(timer);
        pending.delete(id);
        resolve(failValue);
      }
    });
  }

  function call(method, args) {
    try { post({ type: 'call', method, args }); } catch (_e) { /* port closed */ }
  }

  const facade = {
    deliver: (msg) => rpc('deliver', [msg], false).then(Boolean),
    deliverChart: (msg) => { call('deliverChart', [msg]); return true; },
    sendText: (uid, text, opts = {}) => rpc('sendText', [uid, text, opts], false).then(Boolean),
    /** aiogram bot.send_message: the Message, or throws the named error (an unanswered request = network error). */
    sendMessage: (uid, text, kw = {}) => rpc('sendMessage', [uid, text, kw], { ok: false, error: { ...TG_ERRORS.timeout } }).then(unwrapSent),
    alertAdmins: (text) => rpc('alertAdmins', [text], 0),
    notifier: { dispatch: (uid, opts) => rpc('dispatch', [uid, opts], { error: 'timeout' }) },
    sse: {
      broadcast: (uid, event, data) => { call('broadcast', [uid, event, data]); return 0; },
      broadcastAll: (event, data) => { call('broadcastAll', [event, data]); return 0; },
    },
    /** Settle an answer from the main thread; true when it was one. */
    handleMessage(msg) {
      if (!msg || msg.type !== 'rpc-result') return false;
      const p = pending.get(msg.id);
      if (!p) return true;
      pending.delete(msg.id);
      clearTimer(p.timer);
      p.resolve(msg.ok ? msg.result : p.failValue);
      return true;
    },
    /** Resolve every open request with its failure value (port closed / shutdown). */
    failAll() {
      for (const [id, p] of pending) {
        clearTimer(p.timer);
        pending.delete(id);
        p.resolve(p.failValue);
      }
    },
    get pendingCount() { return pending.size; },
  };
  return facade;
}

/** The in-process facade (no worker): the local implementation with the worker-facade shape. */
function localFacade(delivery) {
  return {
    deliver: (msg) => delivery.deliver(msg),
    deliverChart: (msg) => delivery.deliverChart(msg),
    sendText: (uid, text, opts) => delivery.sendText(uid, text, opts),
    sendMessage: async (uid, text, kw) => unwrapSent(await delivery.sendMessage(uid, text, kw)),
    alertAdmins: (text) => delivery.alertAdmins(text),
    notifier: { dispatch: (uid, opts) => delivery.dispatch(uid, opts) },
    sse: { broadcast: (uid, e, data) => delivery.broadcast(uid, e, data), broadcastAll: (e, data) => delivery.broadcastAll(e, data) },
    handleMessage: () => false,
    failAll() {},
  };
}

module.exports = {
  RPC_METHODS, PLAN_LINK, ADMIN_LINK, TG_ERRORS, telegramError, createSignalDelivery, createRemoteDelivery, localFacade,
  actionRoute, withActionRoutes,
};
