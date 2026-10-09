'use strict';
/**
 * runner.js — the main-thread side of workers/genomeWorker.js (PLAN §2.2: the genome runs
 * off the hot path, one generation at a time, spawned on demand).
 *
 *   runGenerationInWorker({strategy, tf, mode, coins, candles, cpuShare, seed, timeoutS, onProgress})
 *       spawn the worker, post ONE `evolve` message (with the cached BTC regime of this thread),
 *       resolve with its result, terminate it; a changed regime is re-sent on a progress message.
 *       A hard kill fires at timeoutS + 60 s (the worker's own deadlines are 1800 s / 700 s).
 *   triggerEvolution(strategy, tf, opts)
 *       trigger_evolution_now semantics in the main thread: one run at a time (the evolution lock
 *       is shared with the scheduler cycle) → "Эволюция уже идёт, подожди 1-3 мин"; `mode:
 *       'manual'` = the 700 s deadline → "Таймаут 10 мин — OKX недоступен или данных нет".
 *   setRunner(fn) / isRunning()   tests inject an in-process runner; the route checks the lock.
 *
 * Nothing here starts automatically (the scheduler wires the 6 h cycle later; under tests no
 * worker is spawned unless a test does it explicitly).
 */

const path = require('path');
const genomeLock = require('./lock');

const WORKER_PATH = path.join(__dirname, '..', '..', 'workers', 'genomeWorker.js');
const LOCK = { held: false, strategy: null, tf: null, startedAt: 0 };

function runGenerationInWorker({
  strategy, tf = null, mode = 'manual', coins = null, candles = null, cpuShare = null, seed = null,
  timeoutS = null, onProgress = null, env = null, regimeOf = null,
} = {}) {
  const { Worker } = require('worker_threads');
  // market_regime.get_cached_regime() of this thread (the engine worker's BTC regime, forwarded with
  // its heartbeats) for drift / paper validation inside the genome thread: sent with the job and
  // refreshed on every progress message (one evaluated genome)
  const regimeNow = () => {
    try { return (regimeOf || require('./regime').getCachedRegime)(); } catch (_e) { return null; }
  };
  return new Promise((resolve) => {
    let settled = false;
    const worker = new Worker(WORKER_PATH, { env: env || process.env });
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      worker.terminate().catch(() => {});
      resolve(res);
    };
    const hardS = (timeoutS || (mode === 'manual' ? 700 : 1800)) + 60;
    const killer = setTimeout(() => finish({ ok: false, error: mode === 'manual' ? 'Таймаут 10 мин — OKX недоступен или данных нет' : 'genome worker timeout' }), hardS * 1000);
    if (killer.unref) killer.unref();
    let lastRegime = regimeNow();
    worker.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'progress') {
        const r = regimeNow();
        if (r !== lastRegime) {
          lastRegime = r;
          try { worker.postMessage({ type: 'regime', regime: r }); } catch (_e) { /* worker gone */ }
        }
        if (onProgress) {
          try { onProgress(msg); } catch (_e) { /* */ }
        }
      } else if (msg.type === 'result') {
        finish(msg.result);
      }
    });
    worker.on('error', (e) => finish({ ok: false, error: String(e && e.message ? e.message : e) }));
    worker.on('exit', (code) => finish({ ok: false, error: `genome worker exited (${code})` }));
    worker.postMessage({ type: 'evolve', id: 1, strategy, tf, mode, coins, candles, cpuShare, seed, timeoutS, regime: lastRegime });
  });
}

let _runner = runGenerationInWorker;

function setRunner(fn) {
  _runner = typeof fn === 'function' ? fn : runGenerationInWorker;
}

function isRunning() {
  return LOCK.held;
}

/** trigger_evolution_now through the runner, under the main-thread evolution lock. */
async function triggerEvolution(strategy, tf = null, opts = {}) {
  if (LOCK.held) return { ok: false, error: 'Эволюция уже идёт, подожди 1-3 мин' };
  await genomeLock.acquire(LOCK);
  LOCK.strategy = strategy;
  LOCK.tf = tf;
  LOCK.startedAt = Date.now() / 1000;
  try {
    const res = await _runner({ strategy, tf, mode: 'manual', ...opts });
    return res || { ok: false, error: 'unknown' };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  } finally {
    LOCK.strategy = null;
    LOCK.tf = null;
    genomeLock.release(LOCK);   // hands it to a waiting genome_evolution_loop
  }
}

module.exports = { WORKER_PATH, LOCK, runGenerationInWorker, setRunner, isRunning, triggerEvolution };
