'use strict';
/**
 * vtimers — a virtual-time timer queue for runtime-semantics tests (the JS side of the
 * VirtualLoop in gen/gen_runtime_trace.py): setTimer / clearTimer / now() in seconds, timers fire
 * in (due time, insertion) order like asyncio's TimerHandle heap, and `stall(s)` holds the "loop":
 * the clock jumps, nothing runs in between, and every timer that fell due meanwhile fires once,
 * late, at the end of the stall (Node's timers phase / asyncio's ready queue after a blocked loop).
 * Real setImmediate turns between timers let promise chains settle.
 */

function createVirtualTimers() {
  const st = { t: 0, seq: 0, q: [] };
  const setTimer = (fn, ms) => {
    const h = { at: st.t + Math.max(0, Number(ms) || 0) / 1000, fn, seq: st.seq++, live: true };
    st.q.push(h);
    return h;
  };
  const clearTimer = (h) => { if (h && typeof h === 'object') h.live = false; };
  const turn = () => new Promise((r) => setImmediate(r));

  /** Fire every timer due ≤ limit (s), in order, letting the promise chains settle after each. */
  async function runUntil(limit) {
    for (;;) {
      await turn();
      await turn();
      st.q = st.q.filter((h) => h.live);
      if (!st.q.length) break;
      st.q.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const h = st.q[0];
      if (h.at > limit) break;
      h.live = false;
      st.t = Math.max(st.t, h.at);
      h.fn();
    }
    st.t = Math.max(st.t, limit);
    await turn();
  }

  return {
    setTimer, clearTimer, runUntil,
    now: () => st.t,
    /** a synchronous callback holding the loop for `s` seconds */
    stall: (s) => { st.t += s; },
    sleep: (ms) => new Promise((r) => setTimer(r, ms)),
    timers: { setTimeout: (fn, ms) => setTimer(fn, ms), clearTimeout: (h) => clearTimer(h) },
    pending: () => st.q.filter((h) => h.live).length,
  };
}

module.exports = { createVirtualTimers };
