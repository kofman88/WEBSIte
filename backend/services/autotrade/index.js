'use strict';
/**
 * services/autotrade — the production wiring of the execute_auto_trade port (M13b): one executor
 * per engine-worker thread with the bot's module-level state (trade locks, idempotency registry,
 * cooldowns, dedup maps) and the site's sources for everything the bot reads from its own tables.
 *
 *   createAutoTrade(deps) → {
 *     executeAutoTrade(kwargs)   auto_trade.execute_auto_trade — the scanners' kwargs (snake_case);
 *                                `bot` defaults to deps.bot (the SMC scanner does not pass it),
 *                                extra keys (`user`) are dropped. An exchange outside the D5 set →
 *                                the "no keys" outcome (nothing placed, signal row untouched).
 *     getApiKeys(user, exchange) the scanners' `user.<exchange>_api_key / _api_secret` read (sync):
 *                                {apiKey, apiSecret, passphrase} from exchange_keys (decrypted in
 *                                memory only, never logged), null when missing / undecryptable /
 *                                the exchange is not enabled (D5).
 *     getBalance(user, exchange) balance_cache.get_cached_balance over the same keys (the shared
 *                                60 s cache the executor's risk preview reads).
 *     restore()                  bot.py start-up: restore_idempotency_registry +
 *                                load_zero_balance_cooldowns_from_db (same log lines).
 *     gc                         cache_gc._cleanup_once's auto-trade entries (scheduler.cacheGcOnce).
 *     resetAuthFailures(uid, ex) auto_trade.reset_auth_failures (keys saved / auto-trade switched on in
 *                                the app: the main thread sends it to the engine worker, which owns
 *                                this module state — workers/engineWorker.js 'autotrade' message).
 *     drain()                    wait for the executor's background tasks (shutdown / tests).
 *     beginShutdown() / inflight() / waitIdle(ms)
 *                                D18: from beginShutdown on no new auto placement starts (the row is
 *                                SKIPped 'd18_shutting_down'); waitIdle waits for the placements in
 *                                flight (per-user locks held) — the engine worker's graceful stop.
 *   }
 *
 * Site sources of the bot's reads:
 *   users row (db_get_user)   trader_settings + users.telegram_username (username) + the OKX
 *                             passphrase of exchange_keys (okx_passphrase, '' without a key)
 *   kv / trades / events      engine_kv / signal_trades / trade_events (tradeDb.js)
 *   ADMIN_IDS                 users.is_admin (traderSettingsService.isAdmin); admin alerts go to
 *                             every active admin through the delivery facade (bot.alertAdmins)
 *   safe_send_message         scheduler.siteSafeSend, filed as type 'trade'
 *   challenge gate            services/challengeService.gate (fail-closed in the executor)
 *   regime / trend ctx        regimeLoop (the thread's BTC regime) + marketRegime / trendMonitor
 *   mutation_log              audit_log rows (as services/genome/apply.js does)
 *   notification_queue        not ported: a lost safe-send stays lost (the site notifier already
 *                             persists every dispatched notice) — enqueueCritical = null
 *
 * Confirm mode (auto_trade_mode != 'auto'): exactly the bot — the executor returns
 * show_trade_btn=true and the card carries the `exec_trade_<trade_id>` action, which
 * services/autotrade/confirmMode.js serves (handlers/trading.exec_trade). The optional
 * `onConfirmPending({userId, tradeId, symbol, direction, strategy, exchange})` hook is taken from
 * deps or, once that module exports it, from confirmMode.js; without either nothing else happens.
 *
 * Rollout switches (docs/PORT_DECISIONS.md D5): AUTOTRADE_EXCHANGES — comma list of the exchanges
 * auto-trade may touch (default "bybit,bingx"); the engine worker wires this module only with
 * AUTOTRADE_ENABLED=1 (workers/engineWorker.js), so a deploy never starts trading by itself.
 */

const asyncio = require('./asyncio');
const { pf } = require('./pyfmt');
const { createTradeDb } = require('./tradeDb');
const { createKillswitch } = require('./killswitch');
const { createPlanGate } = require('./planGate');
const { createCooldowns } = require('./cooldowns');
const { createIdempotency } = require('./idempotency');
const { createReconcile } = require('./reconcile');
const { createCorrelationCap } = require('./correlationCap');
const { createAdaptiveSizing } = require('./adaptiveSizing');
const { createTiltDetector } = require('./tiltDetector');
const { createSkipNotify } = require('./skipNotify');
const { createAdminAlerts } = require('./adminAlerts');
const { createAiFilter } = require('./aiFilter');
const { createPartialTp } = require('./partialTp');
const { createExecutor, utcParts } = require('./executeAutoTrade');
const { createTraderSet, productionOverrides } = require('./traders');
const { regimeWarningText } = require('./messages');
const { resolveExchange } = require('../exchanges');

const ALL_EXCHANGES = Object.freeze(['bybit', 'bingx', 'binance', 'okx']);
const D5_DEFAULT_EXCHANGES = Object.freeze(['bybit', 'bingx']);

/** AUTOTRADE_EXCHANGES → the set of exchanges auto-trade may touch (D5; unknown names ignored). */
function enabledExchanges(env = process.env) {
  const raw = env.AUTOTRADE_EXCHANGES;
  if (raw === undefined || raw === null || String(raw).trim() === '') return new Set(D5_DEFAULT_EXCHANGES);
  const out = new Set();
  for (const part of String(raw).split(',')) {
    const ex = part.trim().toLowerCase();
    if (ALL_EXCHANGES.includes(ex)) out.add(ex);
  }
  return out;
}

/** The engine worker's master switch: auto-trade runs only with AUTOTRADE_ENABLED=1. */
function autoTradeEnabled(env = process.env) {
  return String(env.AUTOTRADE_ENABLED === undefined || env.AUTOTRADE_ENABLED === null ? '' : env.AUTOTRADE_ENABLED).trim() === '1';
}

const errText = (e) => (e && e.message !== undefined ? String(e.message) : String(e));

/**
 * The trader runtime hooks of every money path (the bot's module state behind each trader call):
 *   killswitch   defense.killswitch.require_active — checked by every place_trade / place_trade_split
 *   planGate     plan_gate.deny_reason — the traders' last-mile plan check
 *   events       db.trade_events.emit_bg (best effort)
 *   onAuthReset  bybit_trader._reset_auto_trade_for_key (10003 / 10004): every holder of the key gets
 *                auto_trade=0 → their uids. Keys are encrypted non-deterministically, so the candidates
 *                are decrypted and compared in memory (never logged).
 * Each one can be replaced through deps (tests); the executor and the trade-ops queue build theirs here.
 */
function createTraderHooks(deps = {}) {
  const log = deps.log || require('../marketData/mdLog').log;
  const now = deps.now || (() => Date.now() / 1000);
  const dbOf = () => (deps.db ? deps.db : require('../../models/database'));
  const isAdmin = deps.isAdmin || ((uid) => {
    try { return Boolean(require('../traderSettingsService').isAdmin(uid)); } catch (_e) { return false; }
  });
  const tdb = deps.tradeDb || createTradeDb({ db: deps.db || null, now, log, repo: deps.repo || null, invalidateUserCache: deps.invalidateUserCache || null });

  /** metrics.mutation_log.emit_mutation → audit_log (best effort; the bot's no-op filter kept). */
  const emitMutation = deps.emitMutation || (async (type, { actor = '', target = '', before = '', after = '', context = null } = {}) => {
    if (JSON.stringify(before) === JSON.stringify(after)) return false;
    try {
      const uid = context && Number.isInteger(Number(context.user_id)) && Number(context.user_id) > 0 ? Number(context.user_id) : null;
      dbOf().prepare('INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata) VALUES (?, ?, ?, ?, ?)')
        .run(uid, String(type), 'autotrade', null, JSON.stringify({ actor, target, before, after, context }));
      return true;
    } catch (e) {
      log.debug(`mutation_log ${type}: ${errText(e)}`);
      return false;
    }
  });
  const killswitch = deps.killswitch || createKillswitch({ log, emitMutation });
  const planGate = deps.planGate || createPlanGate({ isAdmin: async (uid) => isAdmin(uid), log });
  const events = deps.events || { emit: (tid, type, payload) => tdb.addTradeEvent(tid, type, payload) };
  const onAuthReset = deps.onAuthReset || (async (exchange, apiKey) => {
    if (!apiKey) return [];
    const rows = dbOf().prepare('SELECT id, user_id FROM exchange_keys WHERE exchange = ? ORDER BY user_id, id').all(String(exchange));
    const getCredentials = deps.getCredentials || ((id, uid) => require('../exchangeService').getCredentials(id, uid));
    const uids = [];
    for (const r of rows) {
      let k = null;
      try { k = getCredentials(r.id, r.user_id).apiKey; } catch (_e) { k = null; }
      if (k === apiKey && !uids.includes(Number(r.user_id))) uids.push(Number(r.user_id));
    }
    for (const uid of uids) await tdb.setAutoTrade(uid, false);
    return uids;
  });
  return { tdb, emitMutation, killswitch, planGate, events, onAuthReset };
}

/**
 * The exchange registry of the trade-ops queue (workers/tradeOpsWorker.js: confirm exec, quick
 * close, SL→BE): the site's default trader runtime plus the bot's hooks — without them a confirm
 * exec would place an order while the killswitch is halted (the bot's place_trade refuses).
 */
function createTradeOpsRegistry(deps = {}) {
  const { createRegistry } = require('../exchanges');
  const h = createTraderHooks(deps);
  return createRegistry({
    overrides: { killswitch: h.killswitch, planGate: h.planGate, events: h.events, onAuthReset: h.onAuthReset, ...(deps.overrides || {}) },
  });
}

function createAutoTrade(deps = {}) {
  const env = deps.env || process.env;
  const log = deps.log || require('../marketData/mdLog').log;
  const now = deps.now || (() => Date.now() / 1000);
  const sleep = deps.sleep || ((s) => new Promise((r) => setTimeout(r, Math.max(0, Number(s) || 0) * 1000)));
  const timers = deps.timers;
  const dbOf = () => (deps.db ? deps.db : require('../../models/database'));
  const exchanges = deps.exchanges ? new Set(deps.exchanges) : enabledExchanges(env);
  const defaultBot = deps.bot === undefined ? null : deps.bot;

  /** appSettingsService.exchangeKeys — the key the Mini App shows as connected ('default' label first, then newest). */
  const exchangeKeys = deps.exchangeKeys || ((uid, ex) => require('../appSettingsService').exchangeKeys(uid, ex));
  const isAdmin = deps.isAdmin || ((uid) => {
    try { return Boolean(require('../traderSettingsService').isAdmin(uid)); } catch (_e) { return false; }
  });

  // ── storage + the trader runtime hooks (shared with the trade-ops registry) ──
  const hooks = createTraderHooks({ ...deps, env, log, now, isAdmin });
  const { tdb, emitMutation } = hooks;

  // ── delivery ──
  const msSleep = (ms) => sleep(Math.max(0, Number(ms) || 0) / 1000);
  let safeSend = deps.safeSend || null;
  /** telegram_safe.safe_send_message for every auto-trade notice: filed as a 'trade' notification. */
  const sendMessage = deps.sendMessage || ((bot, uid, text, opts = {}) => {
    if (!safeSend) safeSend = require('../engine/scheduler').siteSafeSend({ log, sleep: msSleep });
    return safeSend(bot, uid, text, { siteType: 'trade', ...opts });
  });
  const enqueueCritical = deps.enqueueCritical === undefined ? null : deps.enqueueCritical;

  // ── module state of the bot ──
  const tasks = deps.tasks || asyncio.createTaskGroup({ log });
  const { killswitch, planGate } = hooks;
  const adminAlerts = deps.adminAlerts || createAdminAlerts({ now, kvGet: tdb.kvGet, kvSet: tdb.kvSet, log });
  const cooldowns = deps.cooldowns || createCooldowns({
    now, kvSet: tdb.kvSet, kvItemsWithPrefix: tdb.kvItemsWithPrefix, tasks, log,
    setAutoTrade: tdb.setAutoTrade,
    invalidateUserCaches: async () => { try { require('../traderSettingsService').invalidateCache(); } catch (_e) { /* best effort */ } },
    sendMessage, alertAuthBreaker: adminAlerts.alertAuthBreaker,
  });
  const idempotency = deps.idempotency || createIdempotency({
    now, kvGet: tdb.kvGet, kvSet: tdb.kvSet, kvKeysWithPrefix: tdb.kvKeysWithPrefix, tasks, log,
  });

  const { onAuthReset } = hooks;

  // deps.traderRuntime (tests): {transport, sleep, now, monotonic, kv, log, …} of the trader instances
  const tr = deps.traderRuntime || {};
  const { transport: trTransport = null, sleep: trSleep = null, ...trExtra } = tr;
  const traderFor = deps.traderFor || createTraderSet({
    overrides: productionOverrides({ killswitch, planGate, events: hooks.events, onAuthReset, transport: trTransport, sleep: trSleep, extra: trExtra }),
  });
  const reconcile = deps.reconcile || createReconcile({ traderFor, log, sleep, timers });
  const cache = deps.cache || require('../marketData/candleCache');
  const correlationCap = deps.correlationCap || createCorrelationCap({ db: deps.db || null, cache, now, log });
  const adaptiveSizing = deps.adaptiveSizing || createAdaptiveSizing({ db: deps.db || null, cache, now, log });
  const tiltDetector = deps.tiltDetector || createTiltDetector({ db: deps.db || null, now, log, sendMessage });
  const skipNotify = deps.skipNotify || createSkipNotify({ now, log, sendMessage, enqueueCritical, env });
  const balanceCache = deps.balanceCache || require('../exchanges/balanceCache').defaultCache();

  const regimeLoop = () => require('../engine/regimeLoop');
  const marketRegime = () => require('../../strategies/common/marketRegime');
  const regime = deps.regime || {
    getCachedRegime: () => regimeLoop().getCachedRegime(),
    detectRegime: (df) => marketRegime().detectRegime(df),
    regimeAllowsDirection: (r, d) => marketRegime().regimeAllowsDirection(r, d),
    regimeWarningText,
  };
  const aiFilter = deps.aiFilter || createAiFilter({
    getCachedRegime: () => regimeLoop().getCachedRegime(),
    regimeAllowsDirection: (r, d) => marketRegime().regimeAllowsDirection(r, d),
    env, log,
  });
  const trend = deps.trend || {
    ctxRiskMult: (ctx) => require('../engine/trendMonitor').ctxRiskMult(ctx),
    ctxLabel: (ctx) => require('../engine/trendMonitor').ctxLabel(ctx, 'ru'),
  };
  const partialTp = deps.partialTp || createPartialTp({
    traderFor, log, sleep, sendMessage, enqueueCritical, timers,
    adminAlert: (bot, title, details, dedupKey, alertType) => adminAlerts.sendAdminAlert(bot, title, details, dedupKey, alertType),
  });

  /** The users-row fields the site keeps outside trader_settings. */
  function telegramUsername(uid) {
    try {
      const r = dbOf().prepare('SELECT telegram_username FROM users WHERE id = ?').get(Number(uid));
      return r && r.telegram_username ? String(r.telegram_username) : null;
    } catch (_e) {
      return null;
    }
  }
  function okxPassphrase(uid) {
    try {
      const k = exchangeKeys(Number(uid), 'okx');
      return (k && k[2]) || '';
    } catch (_e) {
      return '';
    }
  }
  const getUserRow = deps.getUserRow || (async (uid) => {
    const r = await tdb.getUser(uid);
    if (!r) return null;
    return { ...r, username: telegramUsername(uid), okx_passphrase: okxPassphrase(uid) };
  });

  function confirmHook() {
    if (deps.onConfirmPending !== undefined) return deps.onConfirmPending;
    let mod = null;
    try {
      mod = require('./confirmMode');
    } catch (e) {
      if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message).includes('confirmMode')) return null;
      throw e;
    }
    return mod && typeof mod.onConfirmPending === 'function' ? mod.onConfirmPending : null;
  }

  const exec = createExecutor({
    db: tdb, traderFor, killswitch, cooldowns, idempotency, reconcile, partialTp, tasks,
    correlationCap, adaptiveSizing, tiltDetector, skipNotify, adminAlerts, aiFilter, balanceCache,
    log, now, sleep, timers, env, config: deps.config,
    isAdmin: async (uid) => isAdmin(uid),
    getUserRow, sendMessage, enqueueCritical,
    exchangeSymbols: deps.exchangeSymbols,
    regime, cache, trend,
    challengeGate: deps.challengeGate || (async (uid) => require('../challengeService').gate(uid)),
    emitMutation,
    userLog: deps.userLog, funnelTrackOnce: deps.funnelTrackOnce, recordLeverageCap: deps.recordLeverageCap,
    sentryCapture: deps.sentryCapture,
    onConfirmPending: async (info) => {
      const fn = confirmHook();
      if (typeof fn === 'function') await fn(info);
    },
    d6: deps.d6, d17: deps.d17, d18: deps.d18,
  });

  /** auto_trade.execute_auto_trade as the scanners call it. */
  async function executeAutoTrade(kwargs = {}) {
    const kw = { ...kwargs };
    delete kw.user;
    if (kw.bot === undefined) kw.bot = defaultBot;
    const ex = resolveExchange(kw.exchange === undefined ? 'bybit' : kw.exchange);
    if (!exchanges.has(ex)) {
      log.warning(pf('[AT-D5] uid=%s sym=%s exchange=%s is not enabled for auto-trade (AUTOTRADE_EXCHANGES) — not placed',
        kw.user_id, kw.symbol, ex));
      return { executed: false, show_trade_btn: false, limit_msg: null, skip_reason: 'exchange_not_enabled' };
    }
    return exec.executeAutoTrade(kw);
  }

  /** The scanners' API-key read: the bot's `exchange` branches (unknown → bybit), D5-gated. */
  function getApiKeys(user, exchange) {
    const uid = user ? Number(user.user_id) : 0;
    if (!uid) return null;
    const ex = resolveExchange(exchange);
    if (!exchanges.has(ex)) return null;
    try {
      const k = exchangeKeys(uid, ex);
      if (!k || !k[0] || !k[1]) return null;
      return { apiKey: k[0], apiSecret: k[1], passphrase: ex === 'okx' ? (k[2] || '') : '' };
    } catch (e) {
      log.debug(`autotrade keys uid=${uid} ex=${ex}: ${e && e.code ? e.code : 'error'}`);
      return null;
    }
  }

  /** balance_cache.get_cached_balance(user, exchange) with the user's exchange_keys key. */
  async function getBalance(user, exchange) {
    const uid = user ? Number(user.user_id) : 0;
    if (!uid) return null;
    const ex = String(exchange || '');
    const view = { user_id: uid, bybit_demo: Boolean(user.bybit_demo), okx_passphrase: '' };
    if (ALL_EXCHANGES.includes(ex)) {
      const keys = getApiKeys(user, ex);
      if (keys) {
        view[`${ex}_api_key`] = keys.apiKey;
        view[`${ex}_api_secret`] = keys.apiSecret;
        if (ex === 'okx') view.okx_passphrase = keys.passphrase;
      }
    }
    return balanceCache.getCachedBalance(view, ex);
  }

  /** bot.py start-up (after init_db): the idempotency registry, then the zero-balance cooldowns. */
  async function restore() {
    let idem = 0;
    let zb = 0;
    try {
      idem = await idempotency.restoreIdempotencyRegistry();
      if (idem > 0) log.info(pf('[IDEMPOTENCY-RESTORE] restored %d active entries from kv', idem));
    } catch (e) {
      log.warning(`idempotency restore at startup failed: ${errText(e)}`);
    }
    try {
      zb = await cooldowns.loadZeroBalanceCooldownsFromDb();
      if (zb) log.info(`💸 Zero-balance cooldowns restored: ${zb}`);
    } catch (e) {
      log.warning(`💸 zero-balance cooldowns restore failed: ${errText(e)}`);
    }
    return { idempotency: idem, zeroBalance: zb };
  }

  /** cache_gc._cleanup_once — the auto-trade registries, each returning the number freed. */
  const gc = {
    tradeLocks: () => exec.gcTradeLocks(),
    idempotency: () => idempotency.gcIdempotencyRegistry(),
    authFail: () => cooldowns.gcAuthFailRegistry(),
    zeroBalance: () => cooldowns.gcZeroBalanceRegistry(),
    commodity: () => cooldowns.gcCommodityBlocklist(),
    disabledDays: (t = now()) => exec.gcDisabledDaysNotified(utcParts(t).ordinal),
    correlation: () => correlationCap.gcCache(),
    tilt: () => tiltDetector.gcDedup(),
    skipNotify: () => skipNotify.gcState(),
  };

  /** auto_trade.reset_auth_failures(uid, exchange): the auth breaker forgets the user's failures (keys re-saved / auto-trade re-enabled). */
  function resetAuthFailures(uid, exchange) {
    cooldowns.resetAuthFailures(Number(uid), String(exchange === undefined || exchange === null ? 'bybit' : exchange));
  }

  return {
    executeAutoTrade, getApiKeys, getBalance, restore, gc, resetAuthFailures,
    drain: () => tasks.drain(),
    // D18: engine shutdown — no new placement, then wait for the ones in flight (workers/engineWorker.js)
    beginShutdown: () => exec.beginShutdown(),
    inflight: () => exec.inflight(),
    waitIdle: (timeoutMs) => exec.waitIdle(timeoutMs),
    exchanges: () => Array.from(exchanges),
    _exec: exec,
    _parts: {
      tdb, killswitch, planGate, cooldowns, idempotency, skipNotify, balanceCache, traderFor, adminAlerts, onAuthReset, getUserRow,
      sendMessage, emitMutation,
    },
  };
}

module.exports = {
  ALL_EXCHANGES, D5_DEFAULT_EXCHANGES, enabledExchanges, autoTradeEnabled, createAutoTrade, createTraderHooks, createTradeOpsRegistry,
};
