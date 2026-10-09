'use strict';
/**
 * tradeOpsWorker.js — the trade-ops side of the site (PLAN §2.2): the queue every action that can
 * send, modify or close an order goes through, serialised per user, with liveness heartbeats.
 * This is the M13b skeleton: the confirm-mode exec (services/autotrade/confirmMode.js) and the
 * quick-close actions (services/autotrade/quickClose.js) run here today; the M15 loops (BE monitor,
 * reconcile, SL verifier, anomaly detector, orphan sweeper, daily summary) and the auto-trade queue
 * (execute_auto_trade) join the same per-user lock later.
 *
 * Bot semantics kept: exec_trade holds its per-trade asyncio.Lock (a second press answers
 * «⏳ Сделка уже открывается…» at once); execute_auto_trade's per-user `_trade_locks[uid]` is the
 * per-user lock here, and the site also takes it for exec / quick close (D16: two presses of one
 * user never race the limit / duplicate checks or close a position twice concurrently). A job
 * that started always runs to its end — a placement is never abandoned half-way; the HTTP side
 * only stops waiting for it (the result then arrives as a `trade` notification).
 *
 * Three ways to run, one job implementation (`createTradeOps`):
 *   • in-process (`client()` before `startTradeOps()`, and always under tests): the jobs run in
 *     this thread — the bot's model (its callbacks share one event loop with everything else);
 *   • worker thread: `startTradeOps()` spawns this file as a worker_threads Worker (own SQLite
 *     connection, own trader instances) and `client()` forwards jobs to it;
 *   • tests drive the worker half over a MessageChannel (`runWorker(port)`).
 *
 * Message protocol (structured clone):
 *   main → worker  { type: 'job', id, kind, payload }   kind: exec | qc | reset_auth_failures
 *                  { type: 'ping', id } · { type: 'shutdown' } · delivery rpc-results
 *   worker → main  { type: 'job-result', id, ok, result | error } · { type: 'heartbeat', ts, running, users }
 *                  { type: 'pong', id, ts } · { type: 'stopped', running } · delivery 'rpc' / 'call'
 *                  (signalDelivery: notifications, SSE) · { type: 'log', level, msg }
 */

const { isMainThread, parentPort } = require('worker_threads');

const WORKER_PATH = __filename;
const HEARTBEAT_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 120_000;
const WATCHDOG_EVERY_MS = 30_000;
const SHUTDOWN_GRACE_MS = 60_000;        // an exchange call in flight is let finish (place_trade ≤ ~60 s)
const RESTART_BASE_S = 10;
const RESTART_MAX_S = 300;
const KINDS = Object.freeze(['exec', 'qc', 'reset_auth_failures']);
const QC_ACTIONS = Object.freeze(['half', 'full', 'force', 'wait', 'be']);

// ═══════════════════════════════════════════════════════════════════════
//  per-user lock (asyncio.Lock semantics: FIFO, not re-entrant)
// ═══════════════════════════════════════════════════════════════════════

function createUserLocks() {
  const locks = new Map();     // uid → { held, waiters: [] }
  function lockFor(uid) {
    const key = String(uid);
    return {
      locked() { const l = locks.get(key); return Boolean(l && l.held); },
      async run(fn) {
        let l = locks.get(key);
        if (!l) {
          l = { held: false, waiters: [] };
          locks.set(key, l);
        }
        if (l.held) await new Promise((resolve) => l.waiters.push(resolve));
        l.held = true;
        try {
          return await fn();
        } finally {
          const next = l.waiters.shift();
          if (next) next();
          else {
            l.held = false;
            locks.delete(key);      // _trade_locks GC: drop an idle lock
          }
        }
      },
    };
  }
  return { lockFor, size: () => locks.size, held: () => Array.from(locks.values()).filter((l) => l.held).length };
}

// ═══════════════════════════════════════════════════════════════════════
//  the jobs
// ═══════════════════════════════════════════════════════════════════════

/**
 * createTradeOps(deps) — the job runner.
 *   deps.delivery  signalDelivery facade (sendText, broadcast | sse.broadcast) for the effects
 *   deps.registry  exchanges registry (tests: scripted transports); deps.db; deps.log; deps.now
 *   deps.resetAuthFailures(uid, ex)  the auto-trade auth breaker (M13b core); no-op until wired
 * submit(kind, payload) → Promise<result>; payload {userId, admin, tradeId, action}.
 */
function createTradeOps(deps = {}) {
  const locks = createUserLocks();
  const state = { running: 0, done: 0, failed: 0, lastBeat: 0, stopping: false };
  const log = () => deps.log || require('../services/marketData/mdLog').log;

  const ts = () => require('../services/traderSettingsService');
  const keys = () => require('../services/exchangeKeysService');
  const CM = () => require('../services/autotrade/confirmMode');
  const QC = () => require('../services/autotrade/quickClose');

  function handlerDeps(user, admin) {
    return {
      db: deps.db, registry: deps.registry, log: deps.log,
      now: deps.now,
      keysOf: (uid, ex) => keys().exchangeKeys(uid, ex),
      checkAccess: (u) => ts().checkAccess(u, { admin: Boolean(admin), now: deps.now ? deps.now() : undefined }),
      userLock: (uid) => locks.lockFor(uid),
      candles: deps.candles || (async () => null),
    };
  }

  let localDelivery = null;
  function deliveryOf() {
    if (deps.delivery) return deps.delivery;
    const SD = require('../services/engine/signalDelivery');
    if (!localDelivery) localDelivery = SD.localFacade(SD.createSignalDelivery({ log: log() }));
    return localDelivery;
  }

  async function runJob(kind, payload) {
    const uid = Number(payload.userId);
    // um.get_or_create at the time the callback runs (the bot reads the user per press)
    const user = ts().getOrCreate(uid, deps.now ? { now: deps.now() } : {});
    const hd = handlerDeps(user, payload.admin);
    let r;
    try {
      if (kind === 'exec') {
        r = await CM().execTrade(user, String(payload.tradeId), hd);
      } else if (kind === 'qc') {
        const q = QC();
        const fn = { half: q.cbQcHalf, full: q.cbQcFull, force: q.cbQcFullForce, be: q.cbQcBe, wait: q.cbHoldlockWait }[payload.action];
        if (!fn) throw new Error(`unknown quick-close action: ${payload.action}`);
        r = await fn(user, String(payload.tradeId), hd);
      } else {
        throw new Error(`unknown job kind: ${kind}`);
      }
    } catch (e) {
      // the bot leaves what the callback already did (a card edited to «⏳ Открываю сделку…»)
      if (e && Array.isArray(e.effects) && payload.applyEffects !== false) {
        await CM().applyEffects(e.effects, { userId: uid, tradeId: payload.tradeId, lang: user.lang === 'en' ? 'en' : 'ru', delivery: deliveryOf(), db: deps.db, log: log() });
      }
      throw e;
    }
    if (payload.applyEffects !== false) {
      await CM().applyEffects(r.effects, { userId: uid, tradeId: payload.tradeId, lang: user.lang === 'en' ? 'en' : 'ru', delivery: deliveryOf(), db: deps.db, log: log() });
    }
    // structured-clone-safe answer (the trader result is a plain dict)
    return JSON.parse(JSON.stringify({ outcome: r.outcome, effects: r.effects, result: r.result === undefined ? null : r.result, res: r.res || null }));
  }

  async function submit(kind, payload = {}) {
    if (!KINDS.includes(kind)) throw new Error(`unknown job kind: ${kind}`);
    if (state.stopping) {
      const e = new Error('trade ops stopping');
      e.code = 'unavailable';
      throw e;
    }
    if (kind === 'reset_auth_failures') {
      const fn = deps.resetAuthFailures;
      if (typeof fn === 'function') await fn(Number(payload.userId), String(payload.exchange));
      return { outcome: 'ok' };
    }
    state.running += 1;
    try {
      const r = await runJob(kind, payload);
      state.done += 1;
      return r;
    } catch (e) {
      state.failed += 1;
      throw e;
    } finally {
      state.running -= 1;
    }
  }

  return {
    submit,
    userLock: (uid) => locks.lockFor(uid),
    resetAuthFailures: (uid, ex) => submit('reset_auth_failures', { userId: uid, exchange: ex }),
    stats: () => ({ running: state.running, done: state.done, failed: state.failed, users: locks.held(), lastBeat: state.lastBeat }),
    beat() { state.lastBeat = Date.now() / 1000; return this.stats(); },
    /** Refuse new jobs and wait (≤ graceMs) for the running ones. → the number still running. */
    async drain(graceMs = SHUTDOWN_GRACE_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
      state.stopping = true;
      const until = Date.now() + graceMs;
      while (state.running > 0 && Date.now() < until) await sleep(50);
      return state.running;
    },
    _state: state,
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  worker half
// ═══════════════════════════════════════════════════════════════════════

function runWorker(port, { deps = {}, heartbeatMs = HEARTBEAT_MS, exit = null } = {}) {
  const post = (m) => { try { port.postMessage(m); } catch (_e) { /* port closed */ } };
  const { createRemoteDelivery } = require('../services/engine/signalDelivery');
  const remote = createRemoteDelivery(post);
  const ops = createTradeOps({ ...deps, delivery: deps.delivery || remote });
  const beat = () => post({ type: 'heartbeat', ts: Date.now() / 1000, ...ops.beat() });
  const hb = setInterval(beat, heartbeatMs);
  if (hb.unref) hb.unref();
  beat();
  let stopping = null;

  async function onJob(msg) {
    try {
      const result = await ops.submit(msg.kind, msg.payload || {});
      post({ type: 'job-result', id: msg.id, ok: true, result });
    } catch (e) {
      post({ type: 'job-result', id: msg.id, ok: false, error: String(e && e.message ? e.message : e), code: (e && e.code) || null });
    }
  }

  port.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (remote.handleMessage(msg)) return;
    if (msg.type === 'job') onJob(msg);
    else if (msg.type === 'ping') post({ type: 'pong', id: msg.id, ts: Date.now() / 1000 });
    else if (msg.type === 'shutdown' && !stopping) {
      stopping = ops.drain().then((left) => {
        clearInterval(hb);
        remote.failAll();
        post({ type: 'stopped', running: left });
        if (exit) exit(0);
      });
    }
  });
  return { ops, stop: () => { clearInterval(hb); } };
}

// ═══════════════════════════════════════════════════════════════════════
//  main-thread half
// ═══════════════════════════════════════════════════════════════════════

/**
 * createSupervisor({spawn, log, delivery}) — spawns the worker, forwards jobs, answers its delivery
 * RPCs, restarts it after a crash / silence (10 s doubling to 300 s). A job whose worker died is
 * answered with error code `worker_lost`: the order may or may not exist — the caller says so.
 */
function createSupervisor({
  spawn = null, log = null, delivery = null, env = process.env, now = () => Date.now() / 1000,
  heartbeatTimeoutMs = HEARTBEAT_TIMEOUT_MS, watchdogEveryMs = WATCHDOG_EVERY_MS,
} = {}) {
  const L = log || require('../services/marketData/mdLog').log;
  const dl = delivery || require('../services/engine/signalDelivery').createSignalDelivery({ log: L });
  const makeWorker = spawn || (() => new (require('worker_threads').Worker)(WORKER_PATH, { env }));
  const st = { worker: null, lastBeat: 0, delay: RESTART_BASE_S, stopping: false, nextId: 1, pending: new Map(), watchdog: null, restartTimer: null };

  const post = (m) => { if (st.worker) { try { st.worker.postMessage(m); } catch (_e) { /* gone */ } } };

  function failPending() {
    for (const [id, p] of st.pending) {
      st.pending.delete(id);
      const e = new Error('trade ops worker lost');
      e.code = 'worker_lost';
      p.reject(e);
    }
  }

  function onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (dl.handleWorkerMessage(msg, post)) return;
    if (msg.type === 'heartbeat') st.lastBeat = now();
    else if (msg.type === 'job-result') {
      const p = st.pending.get(msg.id);
      if (!p) return;
      st.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else {
        const e = new Error(msg.error || 'job failed');
        e.code = msg.code || null;
        p.reject(e);
      }
    } else if (msg.type === 'log') {
      const fn = L[msg.level] || L.info;
      try { fn.call(L, `[trade-ops] ${msg.msg}`); } catch (_e) { /* */ }
    }
  }

  function spawnWorker() {
    st.restartTimer = null;
    st.lastBeat = now();
    let w;
    try { w = makeWorker(); } catch (e) { onExit(e); return; }
    st.worker = w;
    let exited = false;
    w.on('message', onMessage);
    w.on('error', (e) => L.error(`[TRADE-OPS] worker error: ${e && e.stack ? e.stack : e}`));
    w.on('exit', () => { if (!exited) { exited = true; onExit(null); } });
  }

  function onExit(err) {
    st.worker = null;
    failPending();
    if (st.stopping) return;
    const delay = st.delay;
    L.error(`[TRADE-OPS] worker exited${err ? `: ${err.message}` : ''} — restart in ${delay}s`);
    st.delay = Math.min(delay * 2, RESTART_MAX_S);
    st.restartTimer = setTimeout(() => { if (!st.stopping) spawnWorker(); }, delay * 1000);
    if (st.restartTimer.unref) st.restartTimer.unref();
  }

  return {
    state: st,
    start() {
      spawnWorker();
      st.watchdog = setInterval(() => {
        if (st.worker && (now() - st.lastBeat) * 1000 > heartbeatTimeoutMs) {
          L.error('[TRADE-OPS] no heartbeat — terminating the worker');
          try { st.worker.terminate(); } catch (_e) { /* */ }
        }
      }, watchdogEveryMs);
      if (st.watchdog.unref) st.watchdog.unref();
      return this;
    },
    submit(kind, payload) {
      if (!st.worker) {
        const e = new Error('trade ops worker not running');
        e.code = 'unavailable';
        return Promise.reject(e);
      }
      const id = st.nextId++;
      return new Promise((resolve, reject) => {
        st.pending.set(id, { resolve, reject });
        post({ type: 'job', id, kind, payload });
      });
    },
    resetAuthFailures(uid, ex) { return this.submit('reset_auth_failures', { userId: uid, exchange: ex }); },
    async stop({ graceMs = SHUTDOWN_GRACE_MS + 5000 } = {}) {
      st.stopping = true;
      if (st.watchdog) clearInterval(st.watchdog);
      if (st.restartTimer) clearTimeout(st.restartTimer);
      const w = st.worker;
      if (!w) return { stopped: true };
      const done = new Promise((r) => w.on('exit', r));
      post({ type: 'shutdown' });
      const t = new Promise((r) => { const h = setTimeout(() => r('timeout'), graceMs); if (h.unref) h.unref(); });
      if ((await Promise.race([done, t])) === 'timeout') { try { await w.terminate(); } catch (_e) { /* */ } }
      st.worker = null;
      return { stopped: true };
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  the process-wide client
// ═══════════════════════════════════════════════════════════════════════

let _supervisor = null;
let _local = null;

/** startTradeOps({log}) — server.js (outside tests): the supervised worker thread. */
function startTradeOps(opts = {}) {
  if (!_supervisor) _supervisor = createSupervisor(opts).start();
  return _supervisor;
}

/** The job runner the routes use: the worker thread when started, else this thread's own queue. */
function client() {
  if (_supervisor) return _supervisor;
  if (!_local) _local = createTradeOps({});
  return _local;
}

/** Tests: replace the in-process runner (deps → a fresh createTradeOps(deps); null → reset). */
function configureLocal(deps) {
  _local = deps ? createTradeOps(deps) : null;
  return _local;
}

// the thread entry — only when this file IS the worker's script (never when another thread requires it)
if (!isMainThread && parentPort && require.main === module) {
  runWorker(parentPort, {
    exit: () => {
      try { require('../models/database').close(); } catch (_e) { /* not opened */ }
      try { parentPort.close(); } catch (_e) { /* closed */ }
    },
  });
}

module.exports = {
  WORKER_PATH, HEARTBEAT_MS, HEARTBEAT_TIMEOUT_MS, SHUTDOWN_GRACE_MS, KINDS, QC_ACTIONS,
  createUserLocks, createTradeOps, runWorker, createSupervisor, startTradeOps, client, configureLocal,
};
