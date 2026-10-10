'use strict';
/**
 * strayWorker.js — a worker thread for runtime.test.js: the reconcile loop shell (bot.py's swallowing wrapper
 * over state_reconciliation_loop) whose first pass leaves a promise rejection nobody awaits — the bot's
 * "Task exception was never retrieved" — on fast timers (1 s = 1 ms). With workerData.handlers the thread
 * installs the engine worker's asyncio-style handlers (workers/engineWorker.js installTaskExceptionHandlers)
 * and must survive to pass 3; without them Node's default ends the thread at the stray rejection.
 * Messages: {type:'pass', n} · {type:'log', level, msg} · {type:'loop-done'}.
 */
const { parentPort, workerData } = require('worker_threads');
const EW = require('../../../workers/engineWorker.js');
const S = require('../../../services/autotrade/loopShells.js');
const { makeSleep } = require('../../../services/engine/scheduler.js');

const post = (m) => parentPort.postMessage(m);
const line = (level) => (msg, extra) => post({ type: 'log', level, msg: String(msg), extra: extra ? String(extra).split('\n')[0] : null });
const log = { debug() {}, info: line('info'), warning: line('warning'), warn: line('warning'), error: line('error'), critical: line('critical') };

if (workerData && workerData.handlers) EW.installTaskExceptionHandlers(process, log);

const ctrl = new AbortController();
const ctx = {
  signal: ctrl.signal,
  sleep: makeSleep(ctrl.signal, { setTimer: (fn, ms) => setTimeout(fn, ms / 1000), clearTimer: (h) => clearTimeout(h) }),
  log,
  now: () => Date.now() / 1000,
};
let n = 0;
S.runStateReconciliation(log, () => S.stateReconciliationLoop(ctx, {
  reconcileOnce: async () => {
    n += 1;
    post({ type: 'pass', n });
    if (n === 1) Promise.reject(new Error('stray rejection in a loop pass'));   // nobody awaits it
    if (n === 3) ctrl.abort();
  },
})).then(() => post({ type: 'loop-done' }));
