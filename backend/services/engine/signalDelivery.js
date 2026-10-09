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
 * Worker ↔ main RPC (structured-clone payloads):
 *   worker → main  { type: 'rpc', id, method, args }        answered by
 *   main → worker  { type: 'rpc-result', id, ok: true, result } | { …, ok: false, error }
 *   worker → main  { type: 'call', method, args }            fire-and-forget (no answer)
 *   methods: deliver, deliverChart, sendText, alertAdmins, dispatch, broadcast, broadcastAll.
 */

const { noticeTitle, signalLink } = require('./signalTracker');

const RPC_METHODS = Object.freeze(['deliver', 'deliverChart', 'sendText', 'alertAdmins', 'dispatch', 'broadcast', 'broadcastAll']);
const PLAN_LINK = '/app/?tab=settings&sec=plan';
const ADMIN_LINK = '/ops.html';
const ENGINE_TYPES = Object.freeze(['signal', 'progress', 'trend', 'report', 'trade']);

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

  function sse(event, userId, data) {
    const s = sseOf();
    if (!s || typeof s.broadcast !== 'function') return 0;
    try { return s.broadcast(userId, event, data); } catch (e) { log.debug(`[DELIVERY] sse ${event}: ${e && e.message}`); return 0; }
  }

  const d = {
    /** safe_send_message(...) of a card / preview / notice → Promise<bool> */
    async deliver(msg = {}) {
      const uid = Number(msg.userId);
      const text = String(msg.text || '');
      if (!uid || !text) return false;
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
            direction: msg.direction || null, html: text, actions: msg.keyboard || null, lang, silent: Boolean(msg.silent),
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
          data: { kind: 'notice', trade_id: tradeId, strategy: msg.strategy || null, html: text, actions: msg.keyboard || null, lang },
        };
      }
      let res;
      try {
        res = await notifierOf().dispatch(uid, opts);
      } catch (e) {
        log.warning(`[DELIVERY] ${kind} uid=${uid}: ${e && e.message}`);
        return false;
      }
      if (!res || !res.dispatched) return false;
      if (kind === 'card' && tradeId && res.notificationId) {
        // on_sent=remember_signal_message(trade_id): the delivered card is now trackable
        try {
          const repo = repoOf();
          repo.setSignalMsgId(tradeId, res.notificationId, repo.cardSnapshot({ html: text, actions: msg.keyboard || null, lang }));
        } catch (e) {
          log.debug(`[SIGNAL-PROGRESS] remember msg tid=${tradeId}: ${e && e.message}`);
        }
      }
      return true;
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
      if (!uid || !body) return false;
      const type = ENGINE_TYPES.includes(opts.type) ? opts.type : (ENGINE_TYPES.includes(opts.kind) ? opts.kind : 'report');
      try {
        const res = await notifierOf().dispatch(uid, {
          type, title: noticeTitle(body), body, tgText: body, link: opts.link || null, silent: Boolean(opts.silent),
          data: { kind: opts.kind || type, html: body, actions: opts.keyboard || null, lang: opts.lang || 'ru' },
        });
        return Boolean(res && res.dispatched);
      } catch (e) {
        log.warning(`[DELIVERY] ${type} uid=${uid}: ${e && e.message}`);
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
function createRemoteDelivery(post, { timeoutMs = 60_000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let nextId = 1;
  const pending = new Map();   // id → {resolve, timer, fail}

  function rpc(method, args, failValue) {
    const id = nextId++;
    return new Promise((resolve) => {
      const timer = setTimer(() => {
        pending.delete(id);
        resolve(failValue);
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
    alertAdmins: (text) => delivery.alertAdmins(text),
    notifier: { dispatch: (uid, opts) => delivery.dispatch(uid, opts) },
    sse: { broadcast: (uid, e, data) => delivery.broadcast(uid, e, data), broadcastAll: (e, data) => delivery.broadcastAll(e, data) },
    handleMessage: () => false,
    failAll() {},
  };
}

module.exports = { RPC_METHODS, PLAN_LINK, ADMIN_LINK, createSignalDelivery, createRemoteDelivery, localFacade };
