/**
 * PLAN_M15 U1 — services/autotrade/asyncio.js createSemaphore + runInScope.
 *   createSemaphore: the asyncio.Semaphore traces of CPython 3.11.17 recorded by py/m15_harness.py
 *     (_selftest_semaphores: FIFO hand-over, no barging past a queued waiter, a waiter cancelled while
 *     queued, a woken waiter cancelled before it resumed, a holder cancelled, the verifier's
 *     Semaphore(5) over 12 checks, same-instant wake-ups that decide who gets a slot) replayed on the
 *     virtual clock — per-task instants, acquisition order, peak concurrency and the final counter must
 *     match — plus JS-only edge cases; the one deviation (a cancel delivered at the instant of a slot
 *     hand-over, after it) pinned as documented, and the harness guard that refuses such a vector.
 *   runInScope: the root cancel scope of a loop task (the bot's task.cancel() at shutdown).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);
const H = req('./harness.js');
const asyncio = req('../../../services/autotrade/asyncio.js');
const FX = H.loadFixture('m15_units');

/** The JS twin of m15_harness._selftest_semaphores.scenario. */
async function replay(sc) {
  const clk = H.createVClock(H.createVClock(0).now(), 1000.0);
  const sem = asyncio.createSemaphore(sc.value);
  const sleep = H.vclockSleep(clk);
  const base = clk.mono();
  const traces = {};
  const acq = [];
  let active = 0;
  let peak = 0;
  const ctrls = {};
  const ev = (tid, what) => { (traces[tid] = traces[tid] || []).push([Math.round((clk.mono() - base) * 1e6) / 1e6, what]); };
  async function holder(tid, start, hold, cancelOther = null) {
    if (start) await sleep(start);
    ev(tid, 'want');
    try {
      await sem.acquire();                      // `async with sem:` — a cancelled acquire never enters the body
      try {
        acq.push(tid);
        active += 1;
        peak = Math.max(peak, active);
        ev(tid, 'acquired');
        try {
          await sleep(hold);
        } finally {
          active -= 1;
        }
        ev(tid, 'release');
        if (cancelOther) {
          sem.release();
          ctrls[cancelOther].abort();
          await sem.acquire();
        }
      } finally {
        sem.release();
      }
    } catch (e) {
      if (asyncio.isCancelledError(e)) ev(tid, 'cancelled');
      throw e;
    }
    ev(tid, 'done');
  }
  const all = [];
  for (const [tid, start, hold, other] of sc.specs) {
    ctrls[tid] = new AbortController();
    all.push(asyncio.runInScope(ctrls[tid].signal, () => asyncio.runAsTask(`sem_${tid}`, () => holder(tid, start, hold, other || null))));
  }
  for (const [tid, at, pre] of sc.cancels) {
    all.push((async () => {
      if (pre) {
        await clk.sleep(pre);
        await clk.sleep(at - pre);
      } else {
        await clk.sleep(at);
      }
      ctrls[tid].abort();
    })());
  }
  await clk.run(Promise.allSettled(all));
  return { traces, acquire_order: acq, peak, final_value: sem.value(), locked: sem.locked() };
}

describe('createSemaphore = asyncio.Semaphore (CPython 3.11.17 traces)', () => {
  const scenarios = FX.harness.semaphores.filter((s) => s.traces && !s.deviation && !(s.refused || []).length);
  it('has the nine recorded holder scenarios (guarded: no cancel on a release instant of another task)', () => {
    expect(scenarios.map((s) => s.name)).toEqual(['fifo_2_of_5', 'cancel_queued', 'woken_then_cancelled', 'no_barging',
      'verifier_5_of_12', 'cancel_holder', 'cancel_all_waiting', 'tie_wake_3_of_6', 'tie_8_of_3']);
    expect(scenarios.every((s) => s.guard === true)).toBe(true);
    // the guard's rule seen from the traces: a canceller's instant is never a release instant
    for (const s of scenarios) {
      const releases = new Set(Object.values(s.traces).flat().filter(([, what]) => what === 'release').map(([t]) => t));
      for (const [, at] of s.cancels) expect(releases.has(at), `${s.name} cancel at ${at}`).toBe(false);
    }
  });
  it('same-instant wake-ups decide who gets a slot: the bot (FIFO timers) and the site agree', () => {
    const by = Object.fromEntries(FX.harness.semaphores.map((s) => [s.name, s]));
    expect(by.tie_wake_3_of_6.acquire_order).toEqual(['t0', 't5', 't1', 't2', 't3', 't4']);
    expect(by.tie_wake_3_of_6.traces.t4).toEqual([[4, 'want'], [6, 'acquired'], [9.5, 'cancelled']]);
    expect(by.tie_8_of_3.acquire_order).toEqual(['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8']);
  });
  it('locked() stays true while a woken waiter has not resumed (two releases in one step)', async () => {
    const want = FX.harness.semaphores.find((s) => s.name === 'double_release_locked').log;
    const sem = asyncio.createSemaphore(0);
    const log = [];
    const tb = (async () => { await sem.acquire(); log.push(['b', 'acquired', sem.value(), sem.locked()]); })();
    await Promise.resolve();
    log.push(['queued', sem.value(), sem.locked()]);
    sem.release();
    log.push(['release1', sem.value(), sem.locked()]);
    sem.release();
    log.push(['release2', sem.value(), sem.locked()]);
    await tb;
    log.push(['after', sem.value(), sem.locked()]);
    expect(log).toEqual(want);
  });
  it('a waiter queued behind a woken waiter is woken when that one resumes (value left > 0)', async () => {
    const want = FX.harness.semaphores.find((s) => s.name === 'post_acquire_wake').log;
    const sem = asyncio.createSemaphore(0);
    const log = [];
    const waiter = async (name) => {
      log.push([name, 'acquire', sem.value(), sem.locked()]);
      await sem.acquire();
      log.push([name, 'acquired', sem.value(), sem.locked()]);
    };
    const tb = waiter('b');
    await Promise.resolve();
    sem.release();
    sem.release();
    // the bot's d task takes its first step here: after both releases, before b resumes
    const td = waiter('d');
    log.splice(log.length - 1, 0, ['released', sem.value(), sem.locked()]);
    await Promise.all([tb, td]);
    log.push(['after', sem.value(), sem.locked()]);
    expect(log).toEqual(want);
  });
  for (const sc of scenarios) {
    it(sc.name, async () => {
      const got = await replay(sc);
      expect(got.traces).toEqual(sc.traces);
      expect(got.acquire_order).toEqual(sc.acquire_order);
      expect(got.peak).toBe(sc.peak);
      expect(got.final_value).toBe(sc.final_value);
      expect(got.locked).toBe(sc.locked);
    });
  }
});

describe('createSemaphore — the documented deviation: a cancel at the instant of a slot hand-over', () => {
  const by = Object.fromEntries(FX.harness.semaphores.map((s) => [s.name, s]));
  it('bot: the woken waiter raises at acquire and passes the slot on; site: it has entered its body (README)', async () => {
    const sc = by.same_instant_cancel;
    expect([sc.deviation, sc.guard, sc.cancels]).toEqual([true, false, [['b', 10, 0.5]]]);
    expect(sc.traces.b).toEqual([[1, 'want'], [10, 'cancelled']]);
    expect(sc.acquire_order).toEqual(['a', 'c']);
    const got = await replay(sc);
    expect(got.traces.b).toEqual([[1, 'want'], [10, 'acquired'], [10, 'cancelled']]);
    expect(got.acquire_order).toEqual(['a', 'b', 'c']);
    // everything else is the same: a and c at the same instants, the counter restored
    expect(got.traces.a).toEqual(sc.traces.a);
    expect(got.traces.c).toEqual(sc.traces.c);
    expect([got.final_value, got.locked]).toEqual([sc.final_value, sc.locked]);
  });
  it('m15_harness.guarded_cancel refuses that vector (the release came from another task at that instant)', () => {
    const g = by.same_instant_cancel_guarded;
    expect(g.guard).toBe(true);
    expect(g.refused.length).toBe(1);
    expect(g.refused[0]).toMatch(/lands on a semaphore release of the same instant \(task sem_a\).*offset the cancel/);
    expect(g.acquire_order).toEqual(['a', 'b', 'c']);           // the refused cancel was not delivered
  });
});

describe('createSemaphore — edge cases', () => {
  it('a negative initial value raises ValueError', () => {
    expect(() => asyncio.createSemaphore(-1)).toThrow('Semaphore initial value must be >= 0');
  });

  it('locked() counts only waiters that are not cancelled; a wait_for timeout on acquire loses no slot', async () => {
    const clk = H.createVClock(1767225600, 1000);
    const sem = asyncio.createSemaphore(1);
    await sem.acquire();
    expect(sem.locked()).toBe(true);
    const timedOut = asyncio.waitFor(() => sem.acquire(), 5, { timers: clk.timers });
    const later = sem.run(async () => 'later');
    let err = null;
    await clk.run(timedOut.catch((e) => { err = e; }));
    expect(asyncio.isTimeoutError(err)).toBe(true);
    expect(sem.waiting()).toBe(1);               // `later` still queued
    sem.release();
    expect(await later).toBe('later');
    expect(sem.value()).toBe(1);
    expect(sem.locked()).toBe(false);
  });

  it('release without waiters only raises the counter (no upper bound, like asyncio.Semaphore)', async () => {
    const sem = asyncio.createSemaphore(0);
    sem.release();
    sem.release();
    expect(sem.value()).toBe(2);
    await sem.acquire();
    expect(sem.value()).toBe(1);
  });

  it('gather of 12 checks under Semaphore(5): never more than 5 inside, FIFO start order', async () => {
    const clk = H.createVClock(1767225600, 1000);
    const sem = asyncio.createSemaphore(5);
    const sleep = asyncio.cancellableSleep(clk.sleep);
    let inside = 0;
    let peak = 0;
    const order = [];
    const job = (i) => sem.run(async () => {
      order.push(i);
      inside += 1;
      peak = Math.max(peak, inside);
      await sleep((i % 4) + 1);
      inside -= 1;
      if (i === 3) throw new Error('check failed');
      return i;
    });
    const res = await clk.run(Promise.allSettled(Array.from({ length: 12 }, (_v, i) => job(i))));
    expect(peak).toBe(5);
    expect(order.slice(0, 5)).toEqual([0, 1, 2, 3, 4]);
    expect(res[3].status).toBe('rejected');      // gather(return_exceptions=True): one failure, the others go on
    expect(res.filter((r) => r.status === 'fulfilled').length).toBe(11);
    expect(sem.value()).toBe(5);
  });
});

describe('runInScope — the loop task cancel scope', () => {
  it('abort during an in-flight await: CancelledError at that await, nothing after it runs, no further request', async () => {
    const clk = H.createVClock(1767225600, 1000);
    const sent = [];
    const transport = asyncio.cancellableTransport(async (r) => { sent.push(r.url); await clk.sleep(2); return { status: 200, text: 'ok' }; });
    const sleep = asyncio.cancellableSleep(clk.sleep);
    const after = [];
    const ctrl = new AbortController();
    const p = asyncio.runInScope(ctrl.signal, async () => {
      await transport({ url: 'a' });
      after.push('a done');
      await sleep(30);                            // the loop's in-pass sleep
      after.push('slept');
      await transport({ url: 'b' });
      after.push('b done');
    });
    let err = null;
    const done = p.catch((e) => { err = e; });
    clk.timers.setTimeout(() => ctrl.abort(), 10_000);   // shutdown at +10 s
    await clk.run(done);
    expect(asyncio.isCancelledError(err)).toBe(true);
    expect(after).toEqual(['a done']);
    expect(sent).toEqual(['a']);
    expect(clk.mono()).toBe(1032);               // cancellableSleep cannot clear its base's timer: it still fires, ignored
                                                 // (the replay drivers use harness.vclockSleep, which clears it)
  });

  it('abort while a request is in flight: the request is abandoned at its await', async () => {
    const clk = H.createVClock(1767225600, 1000);
    const transport = asyncio.cancellableTransport(() => new Promise(() => {}));   // never answers
    const ctrl = new AbortController();
    const after = [];
    const p = asyncio.runInScope(ctrl.signal, async () => { await transport({ url: 'x' }); after.push('x'); });
    setTimeout(() => ctrl.abort(), 5);
    let err = null;
    await p.catch((e) => { err = e; });
    expect(asyncio.isCancelledError(err)).toBe(true);
    expect(after).toEqual([]);
    expect(clk.pending()).toBe(0);
  });

  it('a nested waitFor gets the CancelledError (not a TimeoutError); its own timeout still works before the abort', async () => {
    const clk = H.createVClock(1767225600, 1000);
    const sleep = asyncio.cancellableSleep(clk.sleep);
    const ctrl = new AbortController();
    const seen = [];
    const p = asyncio.runInScope(ctrl.signal, async () => {
      try {
        await asyncio.waitFor(() => sleep(100), 6, { timers: clk.timers });
      } catch (e) {
        seen.push([asyncio.isTimeoutError(e) ? 'timeout' : 'other', clk.mono()]);
      }
      try {
        await asyncio.waitFor(() => sleep(100), 60, { timers: clk.timers });
      } catch (e) {
        seen.push([asyncio.isCancelledError(e) ? 'cancelled' : 'other', clk.mono()]);
        throw e;
      }
    });
    clk.timers.setTimeout(() => ctrl.abort(), 20_000);
    let err = null;
    await clk.run(p.catch((e) => { err = e; }));
    expect(seen).toEqual([['timeout', 1006], ['cancelled', 1020]]);
    expect(asyncio.isCancelledError(err)).toBe(true);
  });

  it('an already aborted signal never runs fn (a task cancelled before its first step)', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    let ran = false;
    await expect(asyncio.runInScope(ctrl.signal, async () => { ran = true; })).rejects.toSatisfy(asyncio.isCancelledError);
    expect(ran).toBe(false);
  });

  it('abort before the first microtask: fn does not start', async () => {
    const ctrl = new AbortController();
    let ran = false;
    const p = asyncio.runInScope(ctrl.signal, async () => { ran = true; });
    ctrl.abort();
    await expect(p).rejects.toSatisfy(asyncio.isCancelledError);
    expect(ran).toBe(false);
  });

  it('passes the value / the error of fn through; no signal = a scope that is never cancelled', async () => {
    expect(await asyncio.runInScope(new AbortController().signal, async () => 42)).toBe(42);
    expect(await asyncio.runInScope(null, async () => 'x')).toBe('x');
    await expect(asyncio.runInScope(null, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    // a late abort after fn finished changes nothing
    const ctrl = new AbortController();
    expect(await asyncio.runInScope(ctrl.signal, async () => 'done')).toBe('done');
    ctrl.abort();
  });

  it('create_task children are not cancelled with the loop task; checkCancelled sees the scope', async () => {
    const clk = H.createVClock(1767225600, 1000);
    const sleep = asyncio.cancellableSleep(clk.sleep);
    const tasks = asyncio.createTaskGroup();
    const ctrl = new AbortController();
    const log = [];
    const p = asyncio.runInScope(ctrl.signal, async () => {
      tasks.create('bg_alert', async () => { await sleep(5); log.push('bg finished'); });
      await sleep(1);
      ctrl.abort();
      try {
        asyncio.checkCancelled();
      } catch (e) {
        log.push(asyncio.isCancelledError(e) ? 'checkCancelled raised' : 'other');
        throw e;
      }
    });
    await clk.run(Promise.allSettled([p, tasks.drain()]));
    expect(log).toEqual(['checkCancelled raised', 'bg finished']);
  });

  it('a queued semaphore waiter of an aborted loop gives up without taking the slot', async () => {
    const clk = H.createVClock(1767225600, 1000);
    const sem = asyncio.createSemaphore(1);
    await sem.acquire();
    const ctrl = new AbortController();
    const p = asyncio.runInScope(ctrl.signal, () => sem.run(async () => 'never'));
    clk.timers.setTimeout(() => ctrl.abort(), 1000);
    let err = null;
    await clk.run(p.catch((e) => { err = e; }));
    expect(asyncio.isCancelledError(err)).toBe(true);
    expect(sem.waiting()).toBe(0);
    sem.release();
    expect(sem.value()).toBe(1);
  });

  it('runInThread inside the scope: the awaiting code is cancelled, the thread runs on', async () => {
    const clk = H.createVClock(1767225600, 1000);
    const ctrl = new AbortController();
    const out = [];
    const p = asyncio.runInScope(ctrl.signal, async () => {
      await asyncio.runInThread(async () => { await clk.sleep(3); out.push('thread done'); });
      out.push('after thread');
    });
    clk.timers.setTimeout(() => ctrl.abort(), 1000);
    let err = null;
    await clk.run(p.catch((e) => { err = e; }));
    expect(asyncio.isCancelledError(err)).toBe(true);
    expect(out).toEqual(['thread done']);
  });
});
