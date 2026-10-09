'use strict';
/**
 * asyncio.js — the slice of asyncio semantics the auto-trade flow depends on, on promises.
 *
 *   waitFor(fn, timeoutS, {shield})   asyncio.wait_for(coro, timeout)
 *       fn runs inside a fresh *cancel scope* (AsyncLocalStorage). On timeout the scope is
 *       cancelled: every await on the scope's transport / sleep (cancellableTransport,
 *       cancellableSleep) rejects with CancelledError — an in-flight HTTP request is abandoned
 *       and NO further request leaves the process — then waitFor WAITS for fn to settle and
 *       raises TimeoutError (like wait_for's _cancel_and_wait). Every catch block of the traders
 *       re-raises CancelledError first (pyCompat.rethrowCancelled: the bot's `except Exception`
 *       never catches it), so nothing runs after the cancelled await — no log line, event,
 *       metric, cache write or request.
 *       `shield: true` (legacy, unused by the money paths): a timeout raises TimeoutError at once
 *       and fn keeps running as a whole.
 *   runInThread(fn)                    loop.run_in_executor / asyncio.to_thread: the bot's pybit
 *       work (rt.runInThread in services/exchanges/bybitTrader.js) runs on in a scope no
 *       cancellation reaches, while the awaiting coroutine is cancelled at that await — the
 *       async code around the thread (hedge-mode save, events, metrics, auth reset, retries)
 *       stops exactly where the bot's coroutine stops.
 *   CancelledError, TimeoutError       asyncio.CancelledError / TimeoutError (str(e) == '')
 *   checkCancelled()                   raise CancelledError when the current scope is cancelled
 *   cancellableTransport(base)         a trader transport that honours the cancel scope
 *   cancellableSleep(base)             a trader sleep that honours the cancel scope
 *   makeLock()                         asyncio.Lock (FIFO, `run(fn)` = `async with lock`)
 *   createTaskGroup({log})             asyncio.create_task registry: named background tasks, the
 *                                      bot's `_bg_tasks` strong refs, `drain()` for tests,
 *                                      `currentTaskName()` (AsyncLocalStorage) for call tagging
 */

const { AsyncLocalStorage } = require('node:async_hooks');

class CancelledError extends Error {
  constructor() { super(''); this.name = 'CancelledError'; this.pyType = 'CancelledError'; }
}

class TimeoutError extends Error {
  constructor(message = '') { super(message); this.name = 'TimeoutError'; this.pyType = 'TimeoutError'; }
}

const isTimeoutError = (e) => Boolean(e && (e instanceof TimeoutError || e.pyType === 'TimeoutError' || e.name === 'TimeoutError'));
const isCancelledError = (e) => Boolean(e && (e instanceof CancelledError || e.pyType === 'CancelledError'));

const scopeStore = new AsyncLocalStorage();

function scopeCancelled(scope) {
  for (let s = scope; s; s = s.parent) if (s.cancelled) return true;
  return false;
}

function currentScope() { return scopeStore.getStore() || null; }

function checkCancelled() {
  if (scopeCancelled(currentScope())) throw new CancelledError();
}

/** A promise that rejects with CancelledError as soon as `scope` (or a parent) is cancelled. */
function whenCancelled(scope) {
  let off = () => {};
  const p = new Promise((_resolve, reject) => {
    const fire = () => reject(new CancelledError());
    const chain = [];
    for (let s = scope; s; s = s.parent) {
      s.listeners.add(fire);
      chain.push(s);
    }
    off = () => { for (const s of chain) s.listeners.delete(fire); };
  });
  p.catch(() => {});
  return { promise: p, off };
}

/** Race `promise` against the cancellation of the current scope. */
async function guardCancel(promise) {
  const scope = currentScope();
  if (!scope) return promise;
  if (scopeCancelled(scope)) {
    Promise.resolve(promise).catch(() => {});
    throw new CancelledError();
  }
  const w = whenCancelled(scope);
  try {
    return await Promise.race([promise, w.promise]);
  } finally {
    w.off();
    Promise.resolve(promise).catch(() => {});
  }
}

function cancelScope(scope) {
  if (scope.cancelled) return;
  scope.cancelled = true;
  const fire = (s) => { for (const fn of Array.from(s.listeners)) { try { fn(); } catch (_e) { /* listener */ } } };
  fire(scope);
  // children registered on this scope as parent pick it up through scopeCancelled()
  for (const child of scope.children) fire(child);
}

const defaultTimers = {
  setTimeout: (fn, ms) => { const h = setTimeout(fn, ms); if (h && h.unref) h.unref(); return h; },
  clearTimeout: (h) => clearTimeout(h),
};

/**
 * asyncio.wait_for(fn(), timeoutS). `fn` is a function returning a promise (it must run inside
 * the scope); a non-function value is awaited as is (no cancellation possible).
 */
function waitFor(fn, timeoutS, { shield = false, timers = defaultTimers } = {}) {
  const parent = currentScope();
  const scope = { cancelled: false, parent, listeners: new Set(), children: new Set() };
  if (parent) parent.children.add(scope);
  let inner;
  try {
    inner = typeof fn === 'function' ? scopeStore.run(scope, () => Promise.resolve().then(fn)) : Promise.resolve(fn);
  } catch (e) {
    inner = Promise.reject(e);
  }
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = () => { done = true; if (parent) parent.children.delete(scope); };
    const timer = timeoutS === null || timeoutS === undefined ? null : timers.setTimeout(() => {
      if (done) return;
      if (shield) {
        finish();
        inner.catch(() => {});
        reject(new TimeoutError());
        return;
      }
      cancelScope(scope);
      inner.then(() => {}, () => {}).then(() => { finish(); reject(new TimeoutError()); });
    }, Math.max(0, Number(timeoutS) * 1000));
    inner.then((v) => {
      if (done || scope.cancelled) return;
      if (timer !== null) timers.clearTimeout(timer);
      finish();
      resolve(v);
    }, (e) => {
      if (done || scope.cancelled) return;
      if (timer !== null) timers.clearTimeout(timer);
      finish();
      reject(e);
    });
  });
}

/**
 * loop.run_in_executor / asyncio.to_thread (the bot's pybit work): `fn` runs to completion in a scope
 * of its own that no caller's cancellation reaches — a thread cannot be interrupted, its requests and
 * sleeps go on — while the AWAITING code is cancelled at this await exactly like `await fut` in the
 * bot: CancelledError at once, and whatever the coroutine had after the await (hedge-mode save, trade
 * events, metrics, the auth reset, a retry, the TP verification) never runs. The thread's late result
 * or error is dropped.
 */
function runInThread(fn) {
  const threadScope = { cancelled: false, parent: null, listeners: new Set(), children: new Set() };
  let p;
  try {
    p = scopeStore.run(threadScope, () => Promise.resolve().then(fn));
  } catch (e) {
    p = Promise.reject(e);
  }
  p.catch(() => {});
  return guardCancel(p);
}

/** Trader transport wrapper: no request starts in a cancelled scope; an in-flight one is abandoned. */
function cancellableTransport(base) {
  return (req) => {
    checkCancelled();
    return guardCancel(base(req));
  };
}

/** Trader sleep wrapper (seconds). */
function cancellableSleep(base) {
  return (s) => {
    checkCancelled();
    return guardCancel(base(s));
  };
}

// ── asyncio.Lock ────────────────────────────────────────────────────────

function makeLock() {
  let locked = false;
  const waiters = [];
  const acquire = () => {
    if (!locked) { locked = true; return Promise.resolve(); }
    return new Promise((resolve) => waiters.push(resolve));
  };
  const release = () => {
    const next = waiters.shift();
    if (next) next();
    else locked = false;
  };
  return {
    locked: () => locked,
    async run(fn) {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}

// ── asyncio.create_task ─────────────────────────────────────────────────

const taskStore = new AsyncLocalStorage();

/** The name of the task the caller runs in ('main' outside any created task). */
function currentTaskName() {
  const t = taskStore.getStore();
  return t ? t.name : 'main';
}

function runAsTask(name, fn) {
  return taskStore.run({ name }, fn);
}

/**
 * The bot's fire-and-forget tasks (`asyncio.create_task(coro, name=...)` + `_bg_tasks` strong
 * references + `add_done_callback`). `create(name, fn, {onError})` schedules fn on the next
 * microtask in its own task context (and outside any cancel scope — a task is not cancelled
 * by the caller's wait_for). `drain()` awaits every task, including tasks spawned by tasks.
 */
function createTaskGroup({ log = null } = {}) {
  const pending = new Set();
  function create(name, fn, { onError = null } = {}) {
    const p = scopeStore.exit(() => taskStore.run({ name }, () => Promise.resolve().then(fn)));
    const tracked = p.then(
      (v) => v,
      (e) => {
        if (isCancelledError(e)) return undefined;
        if (typeof onError === 'function') {
          try { onError(e); } catch (_e) { /* callback */ }
        } else if (log) {
          log.debug(`task ${name} error: ${e && e.message}`);
        }
        return undefined;
      },
    );
    pending.add(tracked);
    tracked.then(() => pending.delete(tracked));
    return tracked;
  }
  async function drain() {
    while (pending.size) {
      await Promise.all(Array.from(pending));
    }
  }
  return { create, drain, size: () => pending.size };
}

module.exports = {
  CancelledError, TimeoutError, isTimeoutError, isCancelledError,
  waitFor, checkCancelled, guardCancel, currentScope, cancellableTransport, cancellableSleep,
  makeLock, createTaskGroup, currentTaskName, runAsTask, defaultTimers, runInThread,
};
