'use strict';
/**
 * engineWorker.js — the signal engine off the HTTP thread (PLAN §2.2 / M9).
 *
 * Two halves in one file:
 *   • the worker entry (runs when loaded as a worker_threads Worker): the 'worker' side of
 *     services/engine/scheduler.js — LEVELS / SMC / VOLUME scanners, the WS feeds and the cache
 *     warmer, the trend monitor, the regime / momentum / coin-quality loops, the free evening
 *     report, the signal tracker, cache_gc, the health monitor — with the per-thread module
 *     state of those modules and its own SQLite connection (WAL, busy_timeout 15 s);
 *   • the main-thread supervisor `startEngine()` / `createSupervisor()`: spawns the worker, answers
 *     its delivery RPCs through services/engine/signalDelivery.js (notifications, SSE, Telegram
 *     mirror, signal_msg_id), runs the 'main' side of the scheduler (ghost cleanup, Genome
 *     maintenance, Genome evolution through workers/genomeWorker.js), installs the regime
 *     provider the genome reads, and restarts a crashed or silent worker with the bot's
 *     `_guarded_restart` backoff (10 s, ×2 up to 300 s, back to 10 s after a run ≥ 300 s).
 *
 * Message protocol (structured clone):
 *   main → worker
 *     { type: 'start', options? }        start the scheduler ('worker' side; options.only = task names)
 *     { type: 'shutdown' }               graceful stop: scheduler.stop() (≤ 4 s) + registry force-save
 *     { type: 'ping', id }               → { type: 'pong', id, ts }
 *     { type: 'rpc-result', id, ok, result | error }   answer to a delivery request
 *   worker → main
 *     { type: 'ready', tasks, scanners } the scheduler started (task names, scanner registry state)
 *     { type: 'heartbeat', ts, regime }  every HEARTBEAT_MS (15 s) — liveness + the cached BTC regime
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
 * Run the worker half on `port` ({postMessage, on('message')}). Returns a handle for tests:
 * { scheduler(), remote, stop() }.
 *   deps          extra scheduler deps (tests: fakes for rest / cache / wsPool / …)
 *   heartbeatMs   liveness period; setTimer / clearTimer / setEvery / clearEvery injectable
 *   exit(code)    called after the shutdown answer (process.exit in a real worker thread)
 */
function runWorker(port, {
  deps = {}, heartbeatMs = HEARTBEAT_MS, logs = true, exit = null,
  setEvery = (fn, ms) => setInterval(fn, ms), clearEvery = (h) => clearInterval(h),
} = {}) {
  const { createRemoteDelivery } = require('../services/engine/signalDelivery');
  const post = (m) => { try { port.postMessage(m); } catch (_e) { /* port closed */ } };
  const remote = createRemoteDelivery(post);
  if (logs) forwardLogs(post);
  let scheduler = null;
  let hb = null;
  let stopping = null;

  const regimeNow = () => {
    try { return require('../services/engine/regimeLoop').getCachedRegime(); } catch (_e) { return null; }
  };
  const beat = () => post({ type: 'heartbeat', ts: Date.now() / 1000, regime: regimeNow() });

  function start(options = {}) {
    if (scheduler) return;
    try {
      const { createScheduler } = require('../services/engine/scheduler');
      const sd = { ...deps, bot: remote };
      if (options.only) sd.only = options.only;
      scheduler = createScheduler({ side: 'worker', deps: sd });
      scheduler.ctx.health.onHeartbeat = (name, ts) => post({ type: 'health', name, ts });
      const tasks = scheduler.start();
      let scanners = {};
      try { scanners = scheduler.ctx.scanners.describe(); } catch (_e) { scanners = {}; }
      beat();
      hb = setEvery(beat, heartbeatMs);
      if (hb && typeof hb.unref === 'function') hb.unref();
      post({ type: 'ready', tasks, scanners });
    } catch (e) {
      post({ type: 'fatal', error: String(e && e.stack ? e.stack : e) });
    }
  }

  async function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      let res = { pending: 0, saved: null };
      if (scheduler) {
        try { res = await scheduler.stop(); } catch (_e) { /* best effort */ }
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
    if (msg.type === 'start') start(msg.options || {});
    else if (msg.type === 'shutdown') stop();
    else if (msg.type === 'ping') post({ type: 'pong', id: msg.id, ts: Date.now() / 1000 });
  });

  return { scheduler: () => scheduler, remote, stop, start };
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
  };

  function logLine(level, msg, extra) {
    const fn = L[level === 'warning' ? 'warn' : level] || L.info;
    try { if (extra) fn.call(L, msg, extra); else fn.call(L, msg); } catch (_e) { /* */ }
  }

  function post(m) {
    if (!state.worker) return;
    try { state.worker.postMessage(m); } catch (_e) { /* worker gone */ }
  }

  function onWorkerMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (onMessage) { try { onMessage(msg); } catch (_e) { /* test hook */ } }
    if (deliveryImpl.handleWorkerMessage(msg, post)) return;
    switch (msg.type) {
      case 'heartbeat':
        state.lastBeat = now();
        state.regime = msg.regime === undefined ? null : msg.regime;
        state.regimeAt = state.lastBeat;
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

  function checkLiveness() {
    if (!state.worker || state.stopping) return;
    const silent = (now() - state.lastBeat) * 1000;
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
      let resolveDone;
      const done = new Promise((r) => { resolveDone = r; });
      const onMsg = (m) => { if (m && m.type === 'stopped') resolveDone('stopped'); };
      w.on('message', onMsg);
      w.on('exit', () => resolveDone('exit'));
      post({ type: 'shutdown' });
      let t = null;
      const how = await Promise.race([done, new Promise((r) => { t = setTimer(() => r('timeout'), graceMs); })]);
      clearTimer(t);
      let terminated = false;
      try { await w.terminate(); terminated = true; } catch (_e) { /* */ }
      state.worker = null;
      return { stopped: how !== 'timeout', terminated };
    },
    ping(id = 1) { post({ type: 'ping', id }); },
    get worker() { return state.worker; },
  };
}

/**
 * startEngine(): what server.js calls outside tests when ENGINE_WORKER=1 — the supervised
 * worker + the main-thread loops + the genome regime provider. Returns { supervisor, scheduler, stop() }.
 */
function startEngine({ log = null, env = process.env, spawn = null, delivery = null, mainDeps = {} } = {}) {
  const L = log || require('../services/marketData/mdLog').log;
  const regimeHook = require('../services/genome/regime');
  const { CACHE_TTL } = require('../services/engine/regimeLoop');
  const regime = { value: null, at: 0 };
  // market_regime.get_cached_regime() for the main thread (drift / paper validation / optimizer
  // filters of the genome): the worker's cached BTC regime, forwarded with every heartbeat.
  regimeHook.setRegimeProvider(() => (regime.value !== null && Date.now() / 1000 - regime.at <= CACHE_TTL ? regime.value : null));
  const supervisor = createSupervisor({
    delivery, spawn, log: L, env,
    onRegime: (r, ts) => { regime.value = r; regime.at = ts; },
  }).start();
  const { createScheduler } = require('../services/engine/scheduler');
  const dl = delivery || require('../services/engine/signalDelivery').createSignalDelivery({ log: L });
  const scheduler = createScheduler({ side: 'main', deps: { log: L, env, bot: require('../services/engine/signalDelivery').localFacade(dl), ...mainDeps } });
  scheduler.start();
  return {
    supervisor, scheduler, regime,
    async stop() {
      const r1 = await scheduler.stop();
      const r2 = await supervisor.stop();
      return { main: r1, worker: r2 };
    },
  };
}

if (!isMainThread && parentPort) {
  runWorker(parentPort, { exit: (code) => process.exit(code) });
}

module.exports = {
  WORKER_PATH, HEARTBEAT_MS, HEARTBEAT_TIMEOUT_MS, WATCHDOG_EVERY_MS, SHUTDOWN_GRACE_MS,
  RESTART_BASE_S, RESTART_MAX_S, RESTART_HEALTHY_S,
  runWorker, createSupervisor, startEngine, forwardLogs,
};
