/**
 * workers/engineWorker.js — the supervisor (spawn, protocol routing, liveness kill, restart backoff
 * = bot.py _guarded_restart, graceful stop, regime forwarding), startEngine's genome regime
 * provider, the scanner registry, and one real worker_threads round trip (ready → ping → shutdown,
 * event-driven, no sleeps).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import path from 'path';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);
const EW = req('../../../workers/engineWorker.js');
const registry = req('../../../services/engine/scanners/index.js');

const T0 = 1791565200;

class FakeWorker extends EventEmitter {
  constructor(id) { super(); this.id = id; this.posted = []; this.terminated = false; }
  postMessage(m) { this.posted.push(m); if (this.onPost) this.onPost(m); }
  terminate() { this.terminated = true; Promise.resolve().then(() => this.emit('exit', 1)); return Promise.resolve(1); }
  send(m) { this.emit('message', m); }
}

function harness(extra = {}) {
  const workers = [];
  const logs = [];
  const alerts = [];
  const rpc = [];
  const rec = (lvl) => (m, x) => logs.push([lvl, String(m), x === undefined ? null : x]);
  const log = { debug: rec('DEBUG'), info: rec('INFO'), warn: rec('WARNING'), warning: rec('WARNING'), error: rec('ERROR') };
  const delivery = {
    alertAdmins: async (t) => { alerts.push([Date.now() / 1000 - T0, t]); return 1; },
    handleWorkerMessage: (m, reply) => {
      if (m.type !== 'rpc' && m.type !== 'call') return false;
      rpc.push(m);
      if (m.type === 'rpc') reply({ type: 'rpc-result', id: m.id, ok: true, result: true });
      return true;
    },
  };
  const regimes = [];
  const sup = EW.createSupervisor({
    delivery, log, now: () => Date.now() / 1000, spawn: () => { const w = new FakeWorker(workers.length + 1); workers.push(w); return w; },
    onRegime: (r, ts) => regimes.push([r, ts - T0]), ...extra,
  });
  return { sup, workers, logs, alerts, rpc, regimes };
}

afterEach(() => { vi.useRealTimers(); registry._reset(); });

describe('supervisor', () => {
  it('spawns, starts, routes the protocol: ready, heartbeat (regime), health, log, rpc answered to the worker', async () => {
    vi.useFakeTimers({ now: T0 * 1000, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const h = harness({ startOptions: { only: ['smc_scanner'] } });
    h.sup.start();
    const w = h.workers[0];
    expect(w.posted).toEqual([{ type: 'start', options: { only: ['smc_scanner'] } }]);
    w.send({ type: 'ready', tasks: ['smc_scanner'], scanners: { SmcScanner: { available: true } } });
    expect(h.sup.state.ready).toEqual({ tasks: ['smc_scanner'], scanners: { SmcScanner: { available: true } } });
    await vi.advanceTimersByTimeAsync(15_000);
    w.send({ type: 'heartbeat', ts: T0 + 15, regime: 'trending_up' });
    w.send({ type: 'health', name: 'SMC', ts: T0 + 15 });
    w.send({ type: 'log', level: 'info', msg: 'SMC Scanner started, interval=300s', extra: null });
    w.send({ type: 'rpc', id: 1, method: 'deliver', args: [{}] });
    expect(h.regimes).toEqual([['trending_up', 15]]);
    expect(h.sup.state.health).toEqual({ SMC: T0 + 15 });
    expect(h.logs.map((l) => l[1])).toContain('[engine] SMC Scanner started, interval=300s');
    expect(h.rpc.length).toBe(1);
    expect(w.posted.at(-1)).toEqual({ type: 'rpc-result', id: 1, ok: true, result: true });
    h.sup.ping(7);
    expect(w.posted.at(-1)).toEqual({ type: 'ping', id: 7 });
  });

  it('a crashing worker is restarted with _guarded_restart backoff: 10 → 20 → 40, back to 10 after a ≥ 300 s run', async () => {
    vi.useFakeTimers({ now: T0 * 1000, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const h = harness({ heartbeatTimeoutMs: 1e12 });
    h.sup.start();
    const crash = async (i, after = 0) => {
      await vi.advanceTimersByTimeAsync(after * 1000);
      h.workers[i].emit('exit', 1);
    };
    await crash(0);                 // t=0, ran 0 → wait 10, next 20
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.workers.length).toBe(2);
    await crash(1);                 // t=10 → wait 20, next 40
    await vi.advanceTimersByTimeAsync(20_000);
    await crash(2, 400);            // healthy 400 s run → still waits 40 (quirk), next 10
    await vi.advanceTimersByTimeAsync(40_000);
    await crash(3);                 // → 10
    expect(h.alerts.map((a) => [a[0], a[1].split('\n')[0]])).toEqual([
      [0, '💀 <b>engine_worker упала — авто-рестарт через 10s</b>'],
      [10, '💀 <b>engine_worker упала — авто-рестарт через 20s</b>'],
      [430, '💀 <b>engine_worker упала — авто-рестарт через 40s</b>'],
      [470, '💀 <b>engine_worker упала — авто-рестарт через 10s</b>'],
    ]);
    expect(h.alerts[0][1]).toBe('💀 <b>engine_worker упала — авто-рестарт через 10s</b>\n<code>exit code 1</code>');
    expect(h.logs.filter((l) => l[0] === 'ERROR')[0]).toEqual(['ERROR', "💀 Задача 'engine_worker' упала (ran 0s) — авто-рестарт через 10s", 'exit code 1']);
    expect(h.sup.state.restarts).toBe(4);
  });

  it('a silent worker (no heartbeat for > 120 s) is terminated by the watchdog and restarted', async () => {
    vi.useFakeTimers({ now: T0 * 1000, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const h = harness();
    h.sup.start();
    h.workers[0].send({ type: 'ready', tasks: [] });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.workers[0].terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);          // watchdog at 150 s: 150 s silent
    expect(h.workers[0].terminated).toBe(true);
    expect(h.logs.some((l) => l[1] === '[ENGINE-WORKER] no heartbeat for 150s — terminating')).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.workers.length).toBe(2);
    expect(h.alerts[0][1]).toBe('💀 <b>engine_worker упала — авто-рестарт через 10s</b>\n<code>no heartbeat for 150s</code>');
  });

  it('fatal (the scheduler could not start) → terminate → restart with the reason', async () => {
    vi.useFakeTimers({ now: T0 * 1000, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const h = harness();
    h.sup.start();
    h.workers[0].send({ type: 'fatal', error: 'Error: cannot <load>' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.alerts[0][1]).toBe('💀 <b>engine_worker упала — авто-рестарт через 10s</b>\n<code>Error: cannot &lt;load&gt;</code>');
  });

  it('graceful stop: shutdown → stopped → the thread drains and exits by itself (no terminate), no restart after it', async () => {
    vi.useFakeTimers({ now: T0 * 1000, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const h = harness();
    h.sup.start();
    const w = h.workers[0];
    w.onPost = (m) => {
      if (m.type === 'shutdown') Promise.resolve().then(() => { w.send({ type: 'stopped', pending: 0, saved: 3 }); Promise.resolve().then(() => w.emit('exit', 0)); });
    };
    expect(await h.sup.stop()).toEqual({ stopped: true, terminated: false });
    expect(w.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.workers.length).toBe(1);
    expect(h.alerts).toEqual([]);
  });

  it('stopped but the thread does not drain: terminated after the 6 s grace', async () => {
    vi.useFakeTimers({ now: T0 * 1000, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const h = harness();
    h.sup.start();
    const w = h.workers[0];
    w.onPost = (m) => { if (m.type === 'shutdown') Promise.resolve().then(() => w.send({ type: 'stopped', pending: 0, saved: 0 })); };
    const p = h.sup.stop();
    await vi.advanceTimersByTimeAsync(EW.SHUTDOWN_GRACE_MS - 1);
    expect(w.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toEqual({ stopped: true, terminated: true });
  });

  it('stop with a hung worker: terminated after the 6 s grace', async () => {
    vi.useFakeTimers({ now: T0 * 1000, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const h = harness();
    h.sup.start();
    h.workers[0].terminate = () => { h.workers[0].terminated = true; return Promise.resolve(1); };
    const p = h.sup.stop();
    await vi.advanceTimersByTimeAsync(EW.SHUTDOWN_GRACE_MS);
    expect(await p).toEqual({ stopped: false, terminated: true });
    expect(h.workers[0].terminated).toBe(true);
  });

  it('startEngine: the main-thread loops start, the genome regime provider serves the forwarded regime (4 h TTL)', async () => {
    vi.useFakeTimers({ now: T0 * 1000, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const workers = [];
    const regimeHook = req('../../../services/genome/regime.js');
    const silent = { debug() {}, info() {}, warn() {}, warning() {}, error() {} };
    const delivery = { alertAdmins: async () => 0, handleWorkerMessage: () => false };
    const eng = EW.startEngine({
      log: silent, delivery, spawn: () => { const w = new FakeWorker(1); workers.push(w); return w; },
      mainDeps: { only: [], log: silent },
    });
    try {
      expect(eng.scheduler.tasks).toEqual([]);
      expect(regimeHook.getCachedRegime()).toBe(null);
      workers[0].send({ type: 'heartbeat', ts: T0, regime: 'ranging' });
      expect(regimeHook.getCachedRegime()).toBe('ranging');
      vi.setSystemTime((T0 + 4 * 3600 + 1) * 1000);
      expect(regimeHook.getCachedRegime()).toBe(null);
      workers[0].onPost = (m) => { if (m.type === 'shutdown') Promise.resolve().then(() => { workers[0].send({ type: 'stopped' }); workers[0].emit('exit', 0); }); };
      const res = await eng.stop();
      expect(res.worker).toEqual({ stopped: true, terminated: false });
    } finally {
      regimeHook.setRegimeProvider(null);
    }
  });
});

describe('scanner registry (scanners/index.js)', () => {
  it('lazy bot names → modules; a module that is not installed resolves to null; overrides for tests', () => {
    expect(registry.REGISTRY.MidScanner.file).toBe('../levelsScanner');
    expect(registry.REGISTRY.VolumeScanner.file).toBe('../volumeScanner');
    expect(typeof registry.get('SmcScanner')).toBe('function');
    expect(registry.get('SmcScanner')).toBe(req('../../../services/engine/smcScanner.js').runSmcScanner);
    const fs = req('fs');
    const has = (f) => fs.existsSync(path.join(__dirname, '..', '..', '..', 'services', 'engine', f));
    expect(registry.isAvailable('MidScanner')).toBe(has('levelsScanner.js'));
    expect(registry.isAvailable('VolumeScanner')).toBe(has('volumeScanner.js'));
    class M {}
    registry._setOverride('MidScanner', { MidScanner: M });
    registry._setOverride('VolumeScanner', function runVolumeScanner() {});
    expect(registry.get('MidScanner')).toBe(M);
    expect(registry.get('VolumeScanner').name).toBe('runVolumeScanner');
    registry._setOverride('SmcScanner', null);
    expect(registry.get('SmcScanner')).toBe(null);
    expect(() => registry.get('PumpScanner')).toThrow('unknown scanner: PumpScanner');
    expect(registry.describe().MidScanner).toEqual({ file: 'services/engine/levelsScanner.js', bot: 'scanner_mid.MidScanner', available: true, error: null });
  });
});

describe('a real worker thread', () => {
  it('ready → pong → heartbeat → shutdown → stopped → exit 0 (no sleeps: event-driven)', async () => {
    const { Worker } = req('worker_threads');
    const w = new Worker(EW.WORKER_PATH, {
      env: { ...process.env, DATABASE_PATH: path.join(process.cwd(), 'data', 'test-m9b-engine-thread.db'), DB_QUIET: '1', MARKET_LOG_LEVEL: 'silent' },
    });
    const seen = [];
    const waitFor = (type) => new Promise((resolve) => {
      const on = (m) => { if (m && m.type === type) { w.off('message', on); resolve(m); } };
      w.on('message', on);
    });
    w.on('message', (m) => seen.push(m.type));
    const exited = new Promise((r) => w.on('exit', r));
    const ready = waitFor('ready');
    w.postMessage({ type: 'start', options: { only: [] } });
    const r = await ready;
    expect(r.tasks).toEqual([]);
    expect(r.scanners.SmcScanner.available).toBe(true);
    const pong = waitFor('pong');
    w.postMessage({ type: 'ping', id: 42 });
    expect((await pong).id).toBe(42);
    const stopped = waitFor('stopped');
    w.postMessage({ type: 'shutdown' });
    expect(await stopped).toMatchObject({ type: 'stopped', pending: 0 });
    expect(await exited).toBe(0);
    expect(seen.slice(0, 2)).toEqual(['heartbeat', 'ready']);
  }, 30_000);
});
