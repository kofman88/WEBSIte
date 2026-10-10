'use strict';
/**
 * vclock.js — the JS side of the Python driver's virtual-time event loop: a wall + monotonic
 * clock that only moves when the process is idle, jumping to the earliest pending timer.
 *
 *   const clk = createVClock(wall0)
 *   clk.now() / clk.mono()            time.time() / time.monotonic()
 *   clk.timers                         {setTimeout, clearTimeout} for asyncio.waitFor
 *   clk.sleep(s)                       asyncio.sleep on the virtual clock
 *   await clk.run(promise)             drive timers until nothing is pending; returns the
 *                                      promise's value (throws its error); `stuck` when the
 *                                      promise never settled
 *   await clk.runUntil(limitMono)      drive timers due at or before `limitMono` (an infinite loop
 *                                      shell never settles), then move the clock to the limit;
 *                                      later timers stay pending — abort the loop to end it
 *
 * Timers due at the same instant fire in creation order (`seq`), as the Python VLoops do
 * (_FifoTimerHandle in tests/autotrade/m15/py/m15_harness.py and wire/py/drive_wire_diff.py).
 * clk.sleep does not honour a cancel scope; a driver that cancels sleeps uses
 * tests/autotrade/m15/harness.js vclockSleep (the timer is removed when the sleep is cancelled).
 */

function createVClock(wall0, mono0 = 1000.0) {
  const st = { wall: Number(wall0), mono: Number(mono0) };
  const timers = new Set();
  let seq = 0;
  const api = {
    setTimeout(fn, ms) {
      const h = { at: st.mono + Math.max(0, Number(ms) || 0) / 1000, seq: seq++, fn };
      timers.add(h);
      return h;
    },
    clearTimeout(h) { timers.delete(h); },
  };

  async function settle() {
    for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
  }

  async function run(promise, { maxSteps = 100000 } = {}) {
    let done = false;
    let value;
    let error;
    let failed = false;
    Promise.resolve(promise).then((v) => { done = true; value = v; }, (e) => { done = true; failed = true; error = e; });
    for (let step = 0; step < maxSteps; step++) {
      await settle();
      if (!timers.size) break;
      let next = null;
      for (const h of timers) if (!next || h.at < next.at || (h.at === next.at && h.seq < next.seq)) next = h;
      timers.delete(next);
      if (next.at > st.mono) {
        st.wall += next.at - st.mono;
        st.mono = next.at;
      }
      next.fn();
    }
    await settle();
    if (!done) throw new Error('vclock: the driven promise never settled (deadlock)');
    if (failed) throw error;
    return value;
  }

  async function runUntil(limitMono, { maxSteps = 1000000 } = {}) {
    const limit = Number(limitMono);
    for (let step = 0; step < maxSteps; step++) {
      await settle();
      let next = null;
      for (const h of timers) if (!next || h.at < next.at || (h.at === next.at && h.seq < next.seq)) next = h;
      if (!next || next.at > limit) break;
      timers.delete(next);
      if (next.at > st.mono) {
        st.wall += next.at - st.mono;
        st.mono = next.at;
      }
      next.fn();
    }
    if (limit > st.mono) {
      st.wall += limit - st.mono;
      st.mono = limit;
    }
    await settle();
  }

  return {
    now: () => st.wall,
    mono: () => st.mono,
    timers: api,
    sleep: (s) => new Promise((r) => api.setTimeout(r, Number(s) * 1000)),
    pending: () => timers.size,
    /** Fire the earliest timer (the clock jumps to it); false when none is pending. For drivers with real I/O. */
    fireNext() {
      if (!timers.size) return false;
      let next = null;
      for (const h of timers) if (!next || h.at < next.at || (h.at === next.at && h.seq < next.seq)) next = h;
      timers.delete(next);
      if (next.at > st.mono) {
        st.wall += next.at - st.mono;
        st.mono = next.at;
      }
      next.fn();
      return true;
    },
    run,
    runUntil,
    state: st,
  };
}

module.exports = { createVClock };
