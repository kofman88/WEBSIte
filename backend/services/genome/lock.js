'use strict';
/**
 * lock.js — genome._evolution_lock (an asyncio.Lock) on the plain `{ held }` objects the genome
 * shares (runner.LOCK in the main thread, evolve.STATE.lock).
 *
 *   `async with _evolution_lock:` → await acquire(lock) … release(lock)
 *   `_evolution_lock.locked()`    → lock.held
 *
 * acquire() takes a free lock at once and otherwise waits in FIFO order; release() hands the lock
 * to the next waiter (it stays held) or frees it. A holder must release through release() so a
 * waiting `genome_evolution_loop` wakes up (the bot's loop waits for a manual run to finish
 * instead of skipping the cycle).
 */

const WAITERS = new WeakMap();

function waitersOf(lock) {
  let w = WAITERS.get(lock);
  if (!w) {
    w = [];
    WAITERS.set(lock, w);
  }
  return w;
}

/** await lock.acquire() */
function acquire(lock) {
  if (!lock.held) {
    lock.held = true;
    return Promise.resolve();
  }
  return new Promise((resolve) => waitersOf(lock).push(resolve));
}

/** lock.release(): the next waiter gets it (still held), else it is free. */
function release(lock) {
  const next = waitersOf(lock).shift();
  if (next) next();
  else lock.held = false;
}

/** Number of tasks waiting for the lock (tests / diagnostics). */
function waiting(lock) {
  return waitersOf(lock).length;
}

module.exports = { acquire, release, waiting };
