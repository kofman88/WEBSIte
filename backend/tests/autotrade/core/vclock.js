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

  return {
    now: () => st.wall,
    mono: () => st.mono,
    timers: api,
    sleep: (s) => new Promise((r) => api.setTimeout(r, Number(s) * 1000)),
    pending: () => timers.size,
    run,
    state: st,
  };
}

module.exports = { createVClock };
