'use strict';
/**
 * engineWorker.js — the signal engine off the HTTP thread (PLAN §2.2 / M9).
 *
 * Two halves in one file:
 *   • the worker entry (runs when loaded as a worker_threads Worker): the 'worker' side of
 *     services/engine/scheduler.js — LEVELS / SMC / VOLUME scanners, the WS feeds and the cache
 *     warmer, the trend monitor, the regime / momentum / coin-quality loops, the free evening
 *     report, the signal tracker, cache_gc, the health monitor and — with the switches on — the
 *     trade runtime (services/autotrade: the auto-trade executor and the M15 trade-ops loops on ONE
 *     runtime, PLAN_M15 D21) — with the per-thread module state of those modules and its own SQLite
 *     connection (WAL, busy_timeout 15 s);
 *   • the main-thread supervisor `startEngine()` / `createSupervisor()`: spawns the worker, answers
 *     its delivery RPCs through services/engine/signalDelivery.js (notifications, SSE, Telegram
 *     mirror, signal_msg_id), runs the 'main' side of the scheduler (ghost cleanup, Genome
 *     maintenance, Genome evolution through workers/genomeWorker.js), installs the regime
 *     provider the genome reads, and restarts a crashed or silent worker with the bot's
 *     `_guarded_restart` backoff (10 s, ×2 up to 300 s, back to 10 s after a run ≥ 300 s).
 *
 * Message protocol (structured clone):
 *   main → worker
 *     { type: 'autotrade', op, … }       hand-offs to the trade runtime (op 'reset_auth_failures')
 *     { type: 'start', options? }        start the scheduler ('worker' side; options.only = task names;
                                        options.boot = run scheduler.boot() first: candle cache +
                                        exchange symbol lists, as startEngine does)
 *     { type: 'shutdown' }               graceful stop: scheduler.stop() (≤ 4 s) + registry force-save
 *     { type: 'ping', id }               → { type: 'pong', id, ts }
 *     { type: 'rpc-result', id, ok, result | error }   answer to a delivery request
 *   worker → main
 *     { type: 'ready', tasks, scanners } the scheduler started (task names, scanner registry state)
 *     { type: 'heartbeat', ts, regime, loops }  every HEARTBEAT_MS (15 s) — liveness + the cached BTC regime
 *                                        + the M15 loops' counters (tradeLoops.stats(), null without loops)
 *     { type: 'health', name, ts }       a scanner heartbeat (HealthMonitor.heartbeat: LEVELS / SMC / VOLUME)
 *     { type: 'rpc', id, method, args } / { type: 'call', method, args }   delivery (signalDelivery.js)
 *     { type: 'log', level, msg, extra } the worker's engine log lines (main logs them via winston)
 *     { type: 'stopped', pending, saved } after a shutdown
 *     { type: 'fatal', error }           the scheduler could not start
 *
 * The supervisor kills a worker that sent no heartbeat for HEARTBEAT_TIMEOUT_MS (120 s) and
 * restarts it; a clean exit after 'shutdown' is not restarted (`_guarded_restart`: clean return =
 * stop). Every timer is injectable, the worker factory too (tests run the worker half in-process
 * over a MessageChannel).
 */

const { isMainThread, parentPort } = require('worker_threads');

const WORKER_PATH = __filename;
const HEARTBEAT_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 120_000;
const WATCHDOG_EVERY_MS = 30_000;
const SHUTDOWN_GRACE_MS = 6_000;
// D18: a graceful stop lets an auto-trade placement in flight finish (≤ 15 s) — server.js gives the
// engine 18 s inside the bot's 22 s shutdown deadline, like the trade-ops queue
const AUTOTRADE_DRAIN_MS = 15_000;
const SHUTDOWN_GRACE_WITH_DRAIN_MS = 18_000;
const RESTART_BASE_S = 10;
const RESTART_MAX_S = 300;
const RESTART_HEALTHY_S = 300;

// ═══════════════════════════════════════════════════════════════════════
//  worker half
// ═══════════════════════════════════════════════════════════════════════

/** Forward the engine logger (marketData/mdLog, used by every engine module) to the main thread. */
function forwardLogs(post) {
  const mdLog = require('../services/marketData/mdLog');
  const fmt = (args) => args.map((a) => (typeof a === 'string' ? a : (a && a.message) || String(a)));
  const send = (level) => (...args) => {
    const [msg, ...extra] = fmt(args);
    post({ type: 'log', level, msg, extra: extra.length ? extra.join(' ') : null });
  };
  mdLog.setLogger({ debug: send('debug'), info: send('info'), warn: send('warn'), error: send('error'), critical: send('error') });
}

/**
 * asyncio's default exception handler, for the worker thread. In the bot an exception nobody
 * awaited (a background task's: "Task exception was never retrieved") or one raised in a plain
 * callback ("Exception in callback …") is logged at ERROR by the loop, and every other task goes on.
 * Node's default ends the thread on the first stray rejection — every scanner, feed and loop with
 * it, then a full restart. Returns the uninstall function.
 */
function installTaskExceptionHandlers(proc = process, log = null) {
  const L = () => log || require('../services/marketData/mdLog').log;
  const text = (e) => (e && e.stack ? String(e.stack) : String(e));
  const onRejection = (reason) => { try { L().error('Task exception was never retrieved', text(reason)); } catch (_e) { /* never throw here */ } };
  const onException = (err) => { try { L().error('Exception in callback', text(err)); } catch (_e) { /* never throw here */ } };
  proc.on('unhandledRejection', onRejection);
  proc.on('uncaughtException', onException);
  return () => {
    proc.removeListener('unhandledRejection', onRejection);
    proc.removeListener('uncaughtException', onException);
  };
}

/**
 * The thread's own end after 'stopped': close its SQLite connection (when this thread opened
 * one) and the port, so the thread drains and exits by itself. Not process.exit(): ending a
 * worker thread that way while better-sqlite3 / the file loggers still hold native resources
 * crashed the whole process now and then (SIGSEGV in about 1 of 4 runs); the supervisor
 * terminates a thread that does not drain within the grace period anyway.
 */
function softExit(port) {
  try {
    const p = require.resolve('../models/database');
    if (require.cache[p]) require(p).close();
  } catch (_e) { /* not loaded / already closed */ }
  try { port.close(); } catch (_e) { /* closed */ }
}

/**
 * The thread's trade runtime (services/autotrade): the executor (M13b) and the M15 trade-ops loops on ONE
 * runtime (PLAN_M15 §1.2 / D21 / D22 / D24) — { runtime, autoTrade, tradeLoops }, each null when off:
 *   AUTOTRADE_ENABLED   TRADE_LOOPS_ENABLED        executor  loops
 *   unset / not 1       unset / not 0/1            —         —      (the default deploy: nothing runs)
 *   1                   unset / not 0/1 / 1        built     on
 *   1                   0                          —         —      ERROR: the executor refuses to run without loops
 *   not 1               1                          —         on     "protect only": no new placement
 * A malformed ORPHAN_SWEEP_* int (Python int() rules) → ERROR, nothing built (D24; the bot dies at start-up).
 * bot.py start-up order: the idempotency registry and the zero-balance cooldowns are restored before any
 * scanner runs — in protect-only mode too (C-8). A failure to build leaves the engine without both
 * (no keys → no trade), never half-wired.
 *   opts.runtimeDeps / opts.loopsDeps   extra deps of createTradeRuntime / createTradeLoops (tests)
 */
async function workerTradeRuntime(bot, env, { runtimeDeps = null, loopsDeps = null } = {}) {
  const L = require('../services/marketData/mdLog').log;
  const off = { runtime: null, autoTrade: null, tradeLoops: null };
  try {
    const at = require('../services/autotrade');
    const atOn = at.autoTradeEnabled(env);
    const loopsOn = at.tradeLoopsEnabled(env);
    if (atOn && !loopsOn) {
      L.error('[AUTO-TRADE] not started: TRADE_LOOPS_ENABLED=0 — open positions would have no BE monitor / reconcile');
      return off;
    }
    if (!loopsOn) return off;
    const envErr = at.tradeRuntimeEnvError(env);
    if (envErr) {
      L.error(envErr);
      return off;
    }
    const runtime = at.createTradeRuntime({ bot, env, ...(runtimeDeps || {}) });
    await runtime.restore();
    const autoTrade = atOn ? at.createAutoTrade({ runtime, bot, env }) : null;
    const tradeLoops = require('../services/autotrade/tradeLoops').createTradeLoops(runtime, { env, ...(loopsDeps || {}) });
    const exchanges = Array.from(runtime.exchanges).join(',') || '-';
    if (autoTrade) L.info(`[AUTO-TRADE] enabled, exchanges=${exchanges}`);
    L.info(`[TRADE-LOOPS] enabled (${autoTrade ? 'with auto-trade' : 'protect only — no new placements'}), exchanges=${exchanges}, `
      + `wired: ${tradeLoops.wired().join(', ') || '-'}`);
    return { runtime, autoTrade, tradeLoops };
  } catch (e) {
    L.error(`[AUTO-TRADE] not started: ${e && e.message}`);
    return off;
  }
}

/** The executor of workerTradeRuntime alone (M13b callers / tests): null unless auto-trade runs. */
async function workerAutoTrade(bot, env) {
  return (await workerTradeRuntime(bot, env)).autoTrade;
}

/**
 * Run the worker half on `port` ({postMessage, on('message')}). Returns a handle for tests:
 * { scheduler(), remote, stop() }.
 *   deps          extra scheduler deps (tests: fakes for rest / cache / wsPool / …)
 *   heartbeatMs   liveness period; setTimer / clearTimer / setEvery / clearEvery injectable
 *   exit(code)    called after the shutdown answer (the thread entry: softExit)
 */
function runWorker(port, {
  deps = {}, heartbeatMs = HEARTBEAT_MS, logs = true, exit = null,
  setEvery = (fn, ms) => setInterval(fn, ms), clearEvery = (h) => clearInterval(h),
  autoTradeDrainMs = AUTOTRADE_DRAIN_MS,
} = {}) {
  const { createRemoteDelivery } = require('../services/engine/signalDelivery');
  let heldLogs = null;   // the log lines of the registry load while it runs, delivered after 'ready' (see start)
  const post = (m) => {
    if (heldLogs && m && m.type === 'log') { heldLogs.push(m); return; }
    try { port.postMessage(m); } catch (_e) { /* port closed */ }
  };
  const remote = createRemoteDelivery(post);
  if (logs) forwardLogs(post);
  let scheduler = null;
  let hb = null;
  let stopping = null;

  const regimeNow = () => {
    try { return require('../services/engine/regimeLoop').getCachedRegime(); } catch (_e) { return null; }
  };
  const loopsNow = () => {
    const tl = scheduler && scheduler.ctx ? scheduler.ctx.tradeLoops : null;
    if (!tl || typeof tl.stats !== 'function') return null;
    try { return tl.stats(); } catch (_e) { return null; }
  };
  const beat = () => post({ type: 'heartbeat', ts: Date.now() / 1000, regime: regimeNow(), loops: loopsNow() });

  let starting = false;
  async function start(options = {}) {
    if (scheduler || starting) return;
    starting = true;   // the auto-trade restore awaits: a second 'start' must not build a second scheduler
    let startLogs = [];
    const flushStartLogs = () => { const held = startLogs; startLogs = []; for (const m of held) post(m); };
    try {
      const { createScheduler } = require('../services/engine/scheduler');
      const { tradeRuntimeDeps, tradeLoopsDeps, ...rest } = deps;
      const sd = { ...rest, bot: remote };
      if (options.only) sd.only = options.only;
      // INF-S-1: signal_registry is loaded at import in the bot (_persist_load) — before any scanner or
      // loop runs, so post-close cooldowns and the 4 h dedup survive a restart and the first persist
      // does not wipe the snapshot. Its line ("FIX-AUDIT-26: signal_registry загружен …") is forwarded
      // after 'ready' (a started worker's first messages stay heartbeat → ready).
      const reg = deps.registry || require('../services/engine/signalRegistry').defaultRegistry;
      if (reg && typeof reg.load === 'function') {
        heldLogs = [];
        try { reg.load(); } catch (e) { require('../services/marketData/mdLog').log.warning(`signal_registry load failed: ${e && e.message}`); }
        startLogs = heldLogs;
        heldLogs = null;
      }
      if (sd.autoTrade === undefined && sd.tradeLoops === undefined) {
        const tr = await workerTradeRuntime(remote, deps.env || process.env, { runtimeDeps: tradeRuntimeDeps, loopsDeps: tradeLoopsDeps });
        sd.autoTrade = tr.autoTrade;
        sd.tradeLoops = tr.tradeLoops;
        sd.tradeRuntime = tr.runtime;
      }
      if (stopping) { flushStartLogs(); return; }
      scheduler = createScheduler({ side: 'worker', deps: sd });
      scheduler.ctx.health.onHeartbeat = (name, ts) => post({ type: 'health', name, ts });
      // bot.py main() before the gather: the candle cache, the exchange symbol lists
      if (options.boot) await scheduler.boot();
      if (stopping) { flushStartLogs(); return; }
      const tasks = scheduler.start();
      let scanners = {};
      try { scanners = scheduler.ctx.scanners.describe(); } catch (_e) { scanners = {}; }
      beat();
      hb = setEvery(beat, heartbeatMs);
      if (hb && typeof hb.unref === 'function') hb.unref();
      post({ type: 'ready', tasks, scanners });
      flushStartLogs();
    } catch (e) {
      if (!scheduler) starting = false;
      flushStartLogs();
      post({ type: 'fatal', error: String(e && e.stack ? e.stack : e) });
    }
  }

  async function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      let res = { pending: 0, saved: null };
      // D18: no new auto placement from here on; the scheduler's loops stop; then a placement in
      // flight (entry → SL → TP of one place_trade) is let finish before the thread closes its DB
      const at = scheduler && scheduler.ctx ? scheduler.ctx.autoTrade : null;
      if (at && typeof at.beginShutdown === 'function') {
        try { at.beginShutdown(); } catch (_e) { /* best effort */ }
      }
      if (scheduler) {
        try { res = await scheduler.stop(); } catch (_e) { /* best effort */ }
      }
      if (at && typeof at.waitIdle === 'function') {
        try {
          const left = await at.waitIdle(autoTradeDrainMs);
          const L = require('../services/marketData/mdLog').log;
          if (left > 0) L.warning(`[D18-SHUTDOWN] ${left} auto-trade placement(s) still in flight after ${Math.round(autoTradeDrainMs / 1000)}s — stopping anyway`);
          // the scanners' registry commits of those signals happened after the scheduler's save
          const reg = deps.registry || require('../services/engine/signalRegistry').defaultRegistry;
          if (typeof reg.forceSave === 'function') res.saved = reg.forceSave();
        } catch (_e) { /* best effort */ }
      }
      if (hb !== null) clearEvery(hb);
      hb = null;
      remote.failAll();
      post({ type: 'stopped', pending: res.pending, saved: res.saved });
      if (exit) exit(0);
      return res;
    })();
    return stopping;
  }

  port.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (remote.handleMessage(msg)) return;
    // the app routes' reads of the engine memory (engineBridge: prices, cached candles, trends)
    if (require('../services/engine/engineBridge').handleQueryMessage(msg, post, scheduler ? scheduler.ctx : null)) return;
    if (msg.type === 'start') start(msg.options || {});
    else if (msg.type === 'autotrade') autoTradeControl(msg);
    else if (msg.type === 'shutdown') stop();
    else if (msg.type === 'ping') post({ type: 'pong', id: msg.id, ts: Date.now() / 1000 });
  });

  /**
   * The main thread's hand-offs to this thread's trade-runtime module state (fire-and-forget, like the
   * bot's in-process call): {op: 'reset_auth_failures', userId, exchange} — the executor's breaker, which
   * is the runtime's, or the runtime's alone in protect-only mode (the BE monitor feeds it, C-8). Without a
   * runtime there is nothing to reset.
   */
  function autoTradeControl(msg) {
    const ctx = scheduler && scheduler.ctx ? scheduler.ctx : null;
    const at = ctx ? (ctx.autoTrade || ctx.tradeRuntime || null) : null;
    if (!at) return false;
    try {
      if (msg.op === 'reset_auth_failures' && typeof at.resetAuthFailures === 'function') {
        at.resetAuthFailures(Number(msg.userId), String(msg.exchange || 'bybit'));
        return true;
      }
    } catch (e) {
      try { require('../services/marketData/mdLog').log.debug(`[AUTO-TRADE] control ${msg.op}: ${e && e.message}`); } catch (_e) { /* */ }
    }
    return false;
  }

  return { scheduler: () => scheduler, remote, stop, start, autoTradeControl };
}

// ═══════════════════════════════════════════════════════════════════════
//  main-thread half
// ═══════════════════════════════════════════════════════════════════════

/**
 * createSupervisor({ delivery, spawn, log, now, timers, env, startOptions })
 *   spawn()   → a Worker-like object: postMessage, on('message'|'error'|'exit'), terminate()
 *   delivery  signalDelivery.createSignalDelivery() (the RPC target)
 *   onRegime(regime, ts)  called on every heartbeat (genome regime provider)
 */
function createSupervisor({
  delivery = null, spawn = null, log = null, now = () => Date.now() / 1000, env = process.env,
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (h) => clearTimeout(h),
  setEvery = (fn, ms) => setInterval(fn, ms), clearEvery = (h) => clearInterval(h),
  heartbeatTimeoutMs = HEARTBEAT_TIMEOUT_MS, watchdogEveryMs = WATCHDOG_EVERY_MS,
  startOptions = {}, onRegime = null, onMessage = null,
} = {}) {
  const L = log || require('../services/marketData/mdLog').log;
  const deliveryImpl = delivery || require('../services/engine/signalDelivery').createSignalDelivery({ log: L });
  const makeWorker = spawn || (() => {
    const { Worker } = require('worker_threads');
    return new Worker(WORKER_PATH, { env });
  });
  const { htmlEscape, errHead } = require('../services/engine/scheduler');
  const { fmtFixed } = require('../strategies/common/pyfmt');

  const state = {
    worker: null, startedAt: 0, lastBeat: 0, restarts: 0, delay: RESTART_BASE_S, stopping: false,
    restartTimer: null, watchdog: null, ready: null, regime: null, regimeAt: 0, health: {}, exitReason: null,
    lastTick: null, stalls: 0, loops: null,
  };

  function logLine(level, msg, extra) {
    const fn = L[level === 'warning' ? 'warn' : level] || L.info;
    try { if (extra) fn.call(L, msg, extra); else fn.call(L, msg); } catch (_e) { /* */ }
  }

  function post(m) {
    if (!state.worker) return;
    try { state.worker.postMessage(m); } catch (_e) { /* worker gone */ }
  }
  const queries = require('../services/engine/engineBridge').createQueryClient(post, { setTimer, clearTimer });

  function onWorkerMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (onMessage) { try { onMessage(msg); } catch (_e) { /* test hook */ } }
    if (deliveryImpl.handleWorkerMessage(msg, post)) return;
    if (queries.handleMessage(msg)) return;
    switch (msg.type) {
      case 'heartbeat':
        state.lastBeat = now();
        state.regime = msg.regime === undefined ? null : msg.regime;
        state.regimeAt = state.lastBeat;
        state.loops = msg.loops === undefined ? null : msg.loops;
        if (onRegime) { try { onRegime(state.regime, state.lastBeat); } catch (_e) { /* */ } }
        break;
      case 'health':
        state.health[msg.name] = msg.ts;
        break;
      case 'ready':
        state.ready = { tasks: msg.tasks || [], scanners: msg.scanners || {} };
        state.lastBeat = now();
        L.info(`[ENGINE-WORKER] ready: ${(msg.tasks || []).join(', ')}`);
        break;
      case 'log':
        logLine(msg.level, `[engine] ${msg.msg}`, msg.extra);
        break;
      case 'fatal':
        state.exitReason = String(msg.error || 'fatal');
        L.error(`[ENGINE-WORKER] fatal: ${state.exitReason}`);
        try { state.worker.terminate(); } catch (_e) { /* */ }
        break;
      default:
        break;
    }
  }

  function spawnWorker() {
    state.restartTimer = null;
    state.ready = null;
    state.exitReason = null;
    state.startedAt = now();
    state.lastBeat = now();
    let w;
    try {
      w = makeWorker();
    } catch (e) {
      onExit(null, e);
      return;
    }
    state.worker = w;
    let exited = false;
    w.on('message', onWorkerMessage);
    w.on('error', (e) => {
      state.exitReason = errHead(e);
      L.error(`[ENGINE-WORKER] error: ${e && e.stack ? e.stack : e}`);
    });
    w.on('exit', (code) => {
      if (exited) return;
      exited = true;
      onExit(code, null);
    });
    post({ type: 'start', options: startOptions });
  }

  /** _guarded_restart around the worker: a clean exit after shutdown stops, anything else restarts. */
  function onExit(code, err) {
    state.worker = null;
    queries.failAll();
    if (state.stopping) return;
    const ran = now() - state.startedAt;
    const delay = state.delay;
    const reason = err ? errHead(err) : (state.exitReason || `exit code ${code}`);
    L.error(`💀 Задача 'engine_worker' упала (ran ${fmtFixed(ran, 0)}s) — авто-рестарт через ${delay}s`, reason);
    Promise.resolve(deliveryImpl.alertAdmins(`💀 <b>engine_worker упала — авто-рестарт через ${delay}s</b>\n<code>${htmlEscape(reason)}</code>`))
      .catch(() => L.debug('guarded_restart alert engine_worker failed'));
    state.restarts += 1;
    state.delay = ran >= RESTART_HEALTHY_S ? RESTART_BASE_S : Math.min(delay * 2, RESTART_MAX_S);
    state.restartTimer = setTimer(() => { if (!state.stopping) spawnWorker(); }, delay * 1000);
    if (state.restartTimer && state.restartTimer.unref) state.restartTimer.unref();
  }

  /**
   * The watchdog tick. A tick that comes much later than its period means this (main) thread did
   * not run meanwhile — a long GC pause, a synchronous request handler, a frozen process: the
   * worker's heartbeats of that time are still queued behind this tick (the timers phase runs
   * before the port's messages), so the silence says nothing about the worker. Such a tick only
   * restarts the liveness window; a worker is judged on silence measured while this thread ran.
   */
  function checkLiveness() {
    if (!state.worker || state.stopping) return;
    const t = now();
    const gapMs = state.lastTick === null ? 0 : (t - state.lastTick) * 1000;
    state.lastTick = t;
    if (gapMs > watchdogEveryMs * 2) {
      state.stalls += 1;
      L.warn(`[ENGINE-WORKER] main thread stalled ${Math.round(gapMs / 1000)}s — liveness window restarted`);
      state.lastBeat = Math.max(state.lastBeat, t);
      return;
    }
    const silent = (t - state.lastBeat) * 1000;
    if (silent > heartbeatTimeoutMs) {
      state.exitReason = `no heartbeat for ${Math.round(silent / 1000)}s`;
      L.error(`[ENGINE-WORKER] ${state.exitReason} — terminating`);
      const w = state.worker;
      try { w.terminate(); } catch (_e) { /* */ }
    }
  }

  return {
    state,
    start() {
      state.stopping = false;
      state.lastTick = now();
      spawnWorker();
      state.watchdog = setEvery(checkLiveness, watchdogEveryMs);
      if (state.watchdog && state.watchdog.unref) state.watchdog.unref();
      return this;
    },
    /** Graceful: 'shutdown' → wait for 'stopped' / exit ≤ SHUTDOWN_GRACE_MS → terminate. */
    async stop({ graceMs = SHUTDOWN_GRACE_MS } = {}) {
      state.stopping = true;
      if (state.restartTimer) clearTimer(state.restartTimer);
      state.restartTimer = null;
      if (state.watchdog) clearEvery(state.watchdog);
      state.watchdog = null;
      const w = state.worker;
      if (!w) return { stopped: true, terminated: false };
      let stopped = false;
      let exited = false;
      let wake = null;
      const changed = () => { if (wake) { const f = wake; wake = null; f(); } };
      w.on('message', (m) => { if (m && m.type === 'stopped') { stopped = true; changed(); } });
      w.on('exit', () => { exited = true; changed(); });
      post({ type: 'shutdown' });
      // wait for 'stopped' and then for the thread to drain and exit by itself (softExit); a
      // thread still alive after the grace period is terminated
      let t = null;
      const deadline = new Promise((r) => { t = setTimer(() => r('timeout'), graceMs); });
      while (!exited) {
        const how = await Promise.race([new Promise((r) => { wake = r; }), deadline]);
        if (how === 'timeout') break;
      }
      clearTimer(t);
      let terminated = false;
      if (!exited) {
        try { await w.terminate(); terminated = true; } catch (_e) { /* */ }
      }
      state.worker = null;
      return { stopped, terminated };
    },
    ping(id = 1) { post({ type: 'ping', id }); },
    /** auto_trade.reset_auth_failures in the worker (which owns the auto-trade registries); no worker → nothing to reset. */
    resetAuthFailures(userId, exchange) {
      if (!state.worker) return false;
      post({ type: 'autotrade', op: 'reset_auth_failures', userId: Number(userId), exchange: String(exchange || 'bybit') });
      return true;
    },
    /** engineBridge query → the worker's answer (rejects without a worker / after timeoutMs). */
    query(method, args = [], timeoutMs = undefined) {
      if (!state.worker) return Promise.reject(new Error('engine worker not running'));
      return queries.query(method, args, timeoutMs);
    },
    get worker() { return state.worker; },
  };
}

/**
 * startEngine(): what server.js calls outside tests when ENGINE_WORKER=1 — the supervised
 * worker + the main-thread loops + the genome regime provider. Returns { supervisor, scheduler, stop() }.
 */
/** A winston-style logger (debug / info / warn / error) with the engine's warning / critical names. */
function engineLog(log) {
  const call = (name, fallback) => (...a) => {
    const fn = log[name] || log[fallback] || log.info;
    try { return fn.apply(log, a); } catch (_e) { return undefined; }
  };
  return {
    debug: call('debug', 'info'), info: call('info', 'info'), warn: call('warn', 'warning'), warning: call('warn', 'warning'),
    error: call('error', 'error'), critical: call('error', 'error'),
  };
}

function startEngine({ log = null, env = process.env, spawn = null, delivery = null, mainDeps = {}, startOptions = null } = {}) {
  const L = log ? engineLog(log) : require('../services/marketData/mdLog').log;
  // the engine modules of the main thread (genome, ghost cleanup …) log through mdLog → the site logger
  if (log) require('../services/marketData/mdLog').setLogger(L);
  const regimeHook = require('../services/genome/regime');
  const { CACHE_TTL } = require('../services/engine/regimeLoop');
  const regime = { value: null, at: 0 };
  // market_regime.get_cached_regime() for the main thread (drift / paper validation / optimizer
  // filters of the genome): the worker's cached BTC regime, forwarded with every heartbeat.
  regimeHook.setRegimeProvider(() => (regime.value !== null && Date.now() / 1000 - regime.at <= CACHE_TTL ? regime.value : null));
  const supervisor = createSupervisor({
    delivery, spawn, log: L, env, startOptions: { boot: true, ...(startOptions || {}) },
    onRegime: (r, ts) => { regime.value = r; regime.at = ts; },
  }).start();
  const { createScheduler } = require('../services/engine/scheduler');
  const dl = delivery || require('../services/engine/signalDelivery').createSignalDelivery({ log: L });
  const scheduler = createScheduler({ side: 'main', deps: { log: L, env, bot: require('../services/engine/signalDelivery').localFacade(dl), ...mainDeps } });
  scheduler.start();
  // bot.py's daily_summary_loop (23:55 UTC) and weekly_digest_loop (Monday 09:05 UTC) — reports.js
  // on this thread: they deliver through the notifier (in-app feed + SSE, e-mail, Telegram mirror)
  // as the bot's loops send through `bot`; `mainDeps.only` selects them like the scheduler's tasks
  const want = (name) => !Array.isArray(mainDeps.only) || mainDeps.only.includes(name);
  const reports = mainDeps.reports !== undefined ? mainDeps.reports : require('../services/engine/reports').createReports({
    db: require('../models/database'), log: L, env,
    challengeLine: (user, now) => require('../services/challengeService').dailySummaryLine(user, now),
  });
  if (reports) {
    if (want('daily_summary')) reports.startDaily();
    if (want('weekly_digest')) reports.startWeekly();
  }
  // bot.py's challenge_loop (90 s, then tick() every LOOP_INTERVAL_S) and entry_advisor_loop
  // (600 s, then INTERVAL_S; off with ENTRY_ADVISOR_ENABLED=0) — the verified M17a ports, run on
  // this thread and delivering through the notifier; `mainDeps.challengeLoop` /
  // `mainDeps.entryAdvisorLoop` replace them (each returns its stop function)
  const retentionStops = [];
  if (want('challenge')) {
    const start = mainDeps.challengeLoop || require('../services/challengeService').startLoop;
    retentionStops.push(start());
  }
  if (want('entry_advisor')) {
    const start = mainDeps.entryAdvisorLoop || require('../services/entryAdvisor').startLoop;
    retentionStops.push(start());
  }
  // bot.py's drip_campaign (drip_loop: hourly, day 1/3/5/7 of a Free user) and engagement
  // (engagement_loop: 120 s, then hourly 3d/1d/7d/14d/30d reminders) — services/retention
  if (want('drip_campaign')) {
    const start = mainDeps.dripLoop || require('../services/retention/dripCampaign').startLoop;
    retentionStops.push(start());
  }
  if (want('engagement')) {
    const start = mainDeps.engagementLoop || require('../services/retention/engagement').startLoop;
    retentionStops.push(start());
  }
  // the app routes (routes/appData.js) read the worker's memory through the bridge
  const bridge = require('../services/engine/engineBridge');
  bridge.setRemote((method, args, timeoutMs) => supervisor.query(method, args, timeoutMs));
  return {
    supervisor, scheduler, regime, reports,
    resetAuthFailures: (userId, exchange) => supervisor.resetAuthFailures(userId, exchange),
    /**
     * Both halves at once, like the bot cancelling every gather task together and waiting ≤ 4 s:
     * the main-side loops (≤ 4 s) and the worker (its own ≤ 4 s + the registry save, ≤ 6 s grace).
     */
    async stop() {
      bridge.setRemote(null);
      if (reports) reports.stop();
      for (const stopLoop of retentionStops) { try { stopLoop(); } catch (_e) { /* already stopped */ } }
      const [r1, r2] = await Promise.all([scheduler.stop(), supervisor.stop()]);
      return { main: r1, worker: r2 };
    },
  };
}

// Only as the entry script of a worker thread (never when another thread merely requires the module).
if (!isMainThread && parentPort && require.main === module) {
  // the thread's own SQLite connection first (WAL, busy_timeout 15 s; the idempotent migrations
  // are a no-op once the main thread ran them) — opened at start, not lazily mid-shutdown
  try { require('../models/database'); } catch (e) { parentPort.postMessage({ type: 'fatal', error: String(e && e.stack ? e.stack : e) }); }
  runWorker(parentPort, { exit: () => softExit(parentPort) });
  // after runWorker: its log forwarding carries these lines to the main thread
  installTaskExceptionHandlers(process);
}

module.exports = {
  WORKER_PATH, HEARTBEAT_MS, HEARTBEAT_TIMEOUT_MS, WATCHDOG_EVERY_MS, SHUTDOWN_GRACE_MS, AUTOTRADE_DRAIN_MS, SHUTDOWN_GRACE_WITH_DRAIN_MS,
  RESTART_BASE_S, RESTART_MAX_S, RESTART_HEALTHY_S,
  runWorker, createSupervisor, startEngine, forwardLogs, softExit, engineLog, installTaskExceptionHandlers,
  workerAutoTrade, workerTradeRuntime,
};
