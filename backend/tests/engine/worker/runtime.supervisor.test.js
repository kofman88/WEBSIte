/**
 * The engine worker's runtime behaviour around stalls, stray rejections and shutdown:
 *
 *   • watchdog vs a main-thread stall (GC pause, a synchronous request, a frozen process): the
 *     worker's heartbeats are queued behind the late watchdog tick, so such a tick restarts the
 *     liveness window instead of killing a healthy worker; a really silent worker is still
 *     terminated 120 s later.
 *   • asyncio's default exception handler in the worker thread: a stray rejection / an exception
 *     in a callback is logged ("Task exception was never retrieved" / "Exception in callback") and
 *     the thread goes on — on a real worker thread (Node's default would end it).
 *   • the delivery RPC timeout settles after the port's queued messages: an answer that arrived
 *     while the worker thread was stalled wins over the timer.
 *   • startEngine().stop() stops both halves at once (the bot cancels every task together).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import path from 'path';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);
const EW = req('../../../workers/engineWorker.js');
const { createRemoteDelivery } = req('../../../services/engine/signalDelivery.js');

const T0 = 1791565200;

class FakeWorker extends EventEmitter {
  constructor(id) { super(); this.id = id; this.posted = []; this.terminated = false; }
  postMessage(m) { this.posted.push(m); if (this.onPost) this.onPost(m); }
  terminate() { this.terminated = true; Promise.resolve().then(() => this.emit('exit', 1)); return Promise.resolve(1); }
  send(m) { this.emit('message', m); }
}

function supervisor() {
  const workers = [];
  const logs = [];
  const rec = (lvl) => (m) => logs.push([lvl, String(m)]);
  const log = { debug() {}, info: rec('INFO'), warn: rec('WARNING'), warning: rec('WARNING'), error: rec('ERROR') };
  const delivery = { alertAdmins: async () => 1, handleWorkerMessage: () => false };
  const sup = EW.createSupervisor({
    delivery, log, now: () => Date.now() / 1000,
    spawn: () => { const w = new FakeWorker(workers.length + 1); workers.push(w); return w; },
  });
  return { sup, workers, logs };
}

afterEach(() => { vi.useRealTimers(); });

describe('supervisor watchdog vs a main-thread stall', () => {
  it('a 200 s stall of the main thread does not kill a healthy worker; a silent one is still terminated 120 s later', async () => {
    vi.useFakeTimers({ now: T0 * 1000, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const h = supervisor();
    h.sup.start();
    const w = h.workers[0];
    w.send({ type: 'ready', tasks: [] });
    // the worker beats every 15 s while the main thread runs
    for (let i = 0; i < 4; i++) { await vi.advanceTimersByTimeAsync(15_000); w.send({ type: 'heartbeat', ts: Date.now() / 1000, regime: null }); }
    // main thread held for 200 s: no timer, no message runs; the clock moves on
    vi.setSystemTime(Date.now() + 200_000);
    await vi.advanceTimersByTimeAsync(0);
    // the late watchdog tick comes before the queued heartbeats: it must not judge the worker
    await vi.advanceTimersByTimeAsync(30_000);
    expect(w.terminated).toBe(false);
    expect(h.logs.some(([l, m]) => l === 'WARNING' && /^\[ENGINE-WORKER\] main thread stalled \d+s — liveness window restarted$/.test(m))).toBe(true);
    expect(h.sup.state.stalls).toBe(1);
    // the worker really is silent from now on: terminated once 120 s of silence were observed
    await vi.advanceTimersByTimeAsync(120_000);
    expect(w.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(w.terminated).toBe(true);
    expect(h.logs.some(([, m]) => /^\[ENGINE-WORKER\] no heartbeat for 1[2-5]\ds — terminating$/.test(m))).toBe(true);
    await h.sup.stop({ graceMs: 1 });
  });

  it('the regular case is unchanged: no stall, 150 s of silence → terminated', async () => {
    vi.useFakeTimers({ now: T0 * 1000, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const h = supervisor();
    h.sup.start();
    h.workers[0].send({ type: 'ready', tasks: [] });
    await vi.advanceTimersByTimeAsync(150_000);
    expect(h.workers[0].terminated).toBe(true);
    expect(h.sup.state.stalls).toBe(0);
    await h.sup.stop({ graceMs: 1 });
  });
});

describe('worker thread: asyncio default exception handler', () => {
  it('unit: a stray rejection / an uncaught exception are logged at ERROR, the handlers uninstall', () => {
    const proc = new EventEmitter();
    const lines = [];
    const log = { error: (m, x) => lines.push([m, String(x).split('\n')[0]]) };
    const off = EW.installTaskExceptionHandlers(proc, log);
    proc.emit('unhandledRejection', new Error('chart task failed'));
    proc.emit('uncaughtException', new TypeError('x is undefined'));
    expect(lines).toEqual([
      ['Task exception was never retrieved', 'Error: chart task failed'],
      ['Exception in callback', 'TypeError: x is undefined'],
    ]);
    off();
    expect(proc.listenerCount('unhandledRejection')).toBe(0);
    expect(proc.listenerCount('uncaughtException')).toBe(0);
  });

  it('a real worker thread survives a stray rejection with the handlers (and dies without them)', async () => {
    const { Worker } = req('worker_threads');
    const mod = path.join(__dirname, '..', '..', '..', 'workers', 'engineWorker.js').replace(/\\/g, '/');
    const code = (install) => `
      const { parentPort } = require('worker_threads');
      const EW = require(${JSON.stringify(mod)});
      if (${install}) EW.installTaskExceptionHandlers(process, { error: (m) => parentPort.postMessage({ log: m }) });
      Promise.reject(new Error('stray'));
      setImmediate(() => setImmediate(() => parentPort.postMessage({ alive: true })));
    `;
    const runOne = (install) => new Promise((resolve) => {
      const w = new Worker(code(install), { eval: true, env: { ...process.env, VITEST: 'true' } });
      const got = [];
      w.on('message', (m) => {
        got.push(m);
        if (m.alive) w.terminate();
      });
      w.on('error', (e) => got.push({ error: e.message }));
      w.on('exit', (c) => resolve({ got, code: c }));
    });
    const withIt = await runOne(true);
    expect(withIt.got).toEqual([{ log: 'Task exception was never retrieved' }, { alive: true }]);
    const without = await runOne(false);
    expect(without.got).toEqual([{ error: 'stray' }]);
    expect(without.code).toBe(1);
  }, 30_000);
});

describe('delivery RPC timeout vs a queued answer', () => {
  it('the timer fires first (stalled thread) but the answer already in the port queue wins', async () => {
    const { MessageChannel } = req('worker_threads');
    const ch = new MessageChannel();
    let fire = null;
    const remote = createRemoteDelivery((m) => ch.port1.postMessage(m), { setTimer: (fn) => { fire = fn; return 1; }, clearTimer: () => {} });
    ch.port1.on('message', (m) => remote.handleMessage(m));
    // the main side: answers every rpc at once
    ch.port2.on('message', (m) => { if (m.type === 'rpc') ch.port2.postMessage({ type: 'rpc-result', id: m.id, ok: true, result: true }); });
    try {
      const p = remote.deliver({ kind: 'card', userId: 1, tradeId: 't', text: 'x' });
      // wait until the answer is queued for port1, then fire the timeout before port1 reads it
      await new Promise((r) => { ch.port2.once('message', () => setImmediate(r)); });
      fire();
      expect(await p).toBe(true);
      expect(remote.pendingCount).toBe(0);
    } finally {
      ch.port1.close();
      ch.port2.close();
    }
  });

  it('no answer at all: the failure value after the timeout (+ one turn)', async () => {
    let fire = null;
    const remote = createRemoteDelivery(() => {}, { setTimer: (fn) => { fire = fn; return 1; }, clearTimer: () => {} });
    const p = remote.deliver({ kind: 'card', userId: 1, text: 'x' });
    fire();
    expect(await p).toBe(false);
    expect(remote.pendingCount).toBe(0);
  });
});

describe('startEngine().stop()', () => {
  it('stops the main-side loops and the worker at once', async () => {
    vi.useFakeTimers({ now: T0 * 1000, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const workers = [];
    const regimeHook = req('../../../services/genome/regime.js');
    const silent = { debug() {}, info() {}, warn() {}, warning() {}, error() {} };
    const delivery = { alertAdmins: async () => 0, handleWorkerMessage: () => false };
    const order = [];
    const eng = EW.startEngine({
      log: silent, delivery, spawn: () => { const w = new FakeWorker(1); workers.push(w); return w; },
      mainDeps: { only: [], log: silent },
    });
    try {
      const realStop = eng.scheduler.stop.bind(eng.scheduler);
      eng.scheduler.stop = async (o) => { order.push('main:start'); const r = await realStop(o); order.push('main:end'); return r; };
      workers[0].onPost = (m) => {
        if (m.type !== 'shutdown') return;
        order.push('worker:shutdown');
        Promise.resolve().then(() => { workers[0].send({ type: 'stopped' }); workers[0].emit('exit', 0); });
      };
      const res = await eng.stop();
      expect(res.worker).toEqual({ stopped: true, terminated: false });
      expect(order.indexOf('worker:shutdown')).toBeLessThan(order.indexOf('main:end'));
    } finally {
      regimeHook.setRegimeProvider(null);
    }
  });
});
