/**
 * Scheduler timing vs the bot: services/engine/scheduler.js under fake timers against
 * fixtures/scheduler_trace.json — gen/gen_scheduler_trace.py ran bot.py's own loops
 * (CPython 3.11, virtual-time event loop) for 6 simulated hours.
 *
 * Both sides run the same task list (bot.py gather order) with the same fakes: a fetcher and a
 * user manager that record their calls, admin alerts, the stubbed loop work (cache GC,
 * prefetch, warmer cycle, trend refresh, tracker cycle, genome generation / GC / baseline, ghost
 * cleanup, coin-quality recompute, trades GC, candle-store cleanup), the WS pool (2.5 s initial
 * load, one feed) and LEVELS / VOLUME stand-ins that cycle every 60 s, crash on the scripted
 * instants and (LEVELS) stop heart-beating for a while. Everything else is the real code: the
 * _guarded / _guarded_restart wrappers, the nested bot.py loops (coin warm-up, ws_feed start,
 * cache warmer start, ghost cleanup, candle prefetch), HealthMonitor, the trend monitor / regime
 * / momentum / coin-quality / free-report / signal-tracker / genome / cache-GC / SMC loops.
 *
 * Compared: every recorded call per name with its exact instant (ms) and arguments, the admin
 * alerts, and the log lines (level + text + instant) of the whole run.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-m9b-scheduler-timing.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(process.env.DATABASE_PATH + ext); } catch (_e) { /* */ } });

const req = createRequire(import.meta.url);
const TRACE = req('./fixtures/scheduler_trace.json');
const S = TRACE.scenario;
const T0 = S.t0;
const HORIZON = S.horizon;

// log lines only one side can print: the subs JSON export (no site equivalent), an import-time
// config warning of the bot, and the summary lines of loop bodies the bot side stubbed
const PY_ONLY = [/^📋 subs_backup\.json обновлён/, /^⚠️ {2}PAYMENT_ADDRESS не задан/];
const JS_ONLY = [/^candle_store prefetch: /, /^candle_store prefetch done: /, /^\[COIN-BLACKLIST-CYCLE\] /];

const round3 = (x) => Math.round(x * 1000) / 1000;

let JS = null;

async function runJs() {
  vi.useFakeTimers({ now: T0 * 1000, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  const rel = () => round3(Date.now() / 1000 - T0);
  const EVENTS = [];
  const ALERTS = [];
  const LOGS = [];
  const ev = (name, ...args) => EVENTS.push([rel(), name, ...args]);
  const lvl = (L) => (msg) => LOGS.push([rel(), L, String(msg)]);
  const log = {
    debug() {}, info: lvl('INFO'), warning: lvl('WARNING'), warn: lvl('WARNING'), error: lvl('ERROR'), critical: lvl('CRITICAL'),
  };
  const mdLog = req('../../../services/marketData/mdLog.js');
  mdLog.setLogger({ debug() {}, info: log.info, warn: log.warning, error: log.error });

  const { createScheduler } = req('../../../services/engine/scheduler.js');
  const wsPoolReal = req('../../../services/marketData/wsPool.js');
  const { CacheWarmer } = req('../../../services/marketData/cacheWarmer.js');
  const candleStoreReal = req('../../../services/marketData/candleStore.js');
  const { createTrendMonitor } = req('../../../services/engine/trendMonitor.js');
  const { createRegimeLoop } = req('../../../services/engine/regimeLoop.js');
  const { createMomentumDetector } = req('../../../services/engine/momentumDetector.js');
  const { createCoinQualityLearner } = req('../../../services/engine/coinQualityLearner.js');
  const { createFreeReport } = req('../../../services/engine/freeReport.js');
  const { createSignalTracker } = req('../../../services/engine/signalTracker.js');
  const smc = req('../../../services/engine/smcScanner.js');
  const { memKv } = req('../pipeline/vectors.js');
  const now = () => Date.now() / 1000;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let sched = null;
  const abortable = (ms) => sched.ctx.sleep(ms);   // the scheduler's sleep (ends on stop), like a cancelled asyncio.sleep

  // ── fakes (gen_scheduler_trace.py's, one-to-one) ──
  let pairsCalls = 0;
  const fetcher = {
    volBySym: Object.fromEntries(S.coins.map((s) => [s, 10_000_000.0])),
    async getAllUsdtPairs(min) {
      pairsCalls += 1;
      ev('fetch.pairs', min);
      const mode = S.pairs_script[String(pairsCalls)];
      if (mode === 'empty') return [];
      if (mode === 'raise') throw new Error('pairs endpoint down');
      return S.coins.slice();
    },
    async getCandles(symbol, tf, limit = 300) { ev('fetch.candles', symbol, tf, limit); return null; },
  };
  const um = {
    async getActiveUsers() { ev('um.active'); return []; },
    allUsers() { ev('um.all'); return []; },
  };
  const bot = {
    async alertAdmins(text) {
      for (const id of S.admin_ids) { ALERTS.push([rel(), id, text]); ev('alert', id, text); }
      return S.admin_ids.length;
    },
    async deliver() { return false; },
    deliverChart() { return true; },
    async sendText() { return false; },
    notifier: { dispatch: async () => ({ error: 'user_not_found' }) },
    sse: null,
  };

  class FakeMid {
    // MidScanner(config, bot, um, stop_event, deps) — the real constructor's signature
    constructor(config, b, u, stopEvent) {
      this.cfg = config; this.bot = b; this.um = u; this._stopEvent = stopEvent;
      this.fetcher = fetcher;
      this._health = null;
      this._crashes = S.levels_crashes.slice();
      this._n = 0;
    }

    async runForever() {
      for (;;) {
        const t = rel();
        if (!(S.levels_hang[0] <= t && t < S.levels_hang[1]) && this._health) this._health.heartbeat('LEVELS');
        ev('levels.cycle');
        if (this._crashes.length && t >= this._crashes[0]) {
          this._crashes.shift();
          this._n += 1;
          throw new Error(`levels boom #${this._n} <scan>`);
        }
        await abortable(S.levels_period * 1000);
        if (this._stopEvent.isSet()) return;
      }
    }
  }
  const volCrashes = S.volume_crashes.slice();
  async function fakeRunVolumeScanner(b, u, f, { health, signal }) {
    for (;;) {
      const t = rel();
      if (health) health.heartbeat('VOLUME');
      ev('volume.cycle');
      if (volCrashes.length && t >= volCrashes[0]) { volCrashes.shift(); throw new Error('volume boom'); }
      await abortable(S.volume_period * 1000);
      if (signal.aborted) return;
    }
  }
  smc._resetDefault();
  const scanners = {
    get: (name) => ({ MidScanner: FakeMid, VolumeScanner: fakeRunVolumeScanner, SmcScanner: smc.runSmcScanner }[name] || null),
    loadModule: (name) => (name === 'SmcScanner' ? smc : null),
    describe: () => ({}),
  };

  const feeds = [];
  const wsPool = {
    DEFAULT_TIMEFRAMES: wsPoolReal.DEFAULT_TIMEFRAMES,
    resolveMaxSymbols: wsPoolReal.resolveMaxSymbols,
    selectUniverse: wsPoolReal.selectUniverse,
    async runWsPool({ symbols, timeframes, sleep }) {
      ev('ws.run', symbols.length, timeframes.slice());
      await sleep(S.ws_initial_load_s * 1000);
      feeds.push({ subscriptions: [], _loadedChannels: new Set() });
      return { feeds, async stop() {} };
    },
    getActiveFeeds: () => feeds.slice(),
  };
  const origWarm = CacheWarmer.prototype.warmOneCycle;
  CacheWarmer.prototype.warmOneCycle = async function warmOneCycle() { ev('warmer.cycle'); };
  const cache = { getCoins: () => S.coins.slice(), getCandles: () => null, setCandles() {} };
  const KV = { genome_evolution_last_ts_v1: req('../../../strategies/common/pyfmt.js').pyRepr(S.genome_last_ts) };
  const genomeStore = {
    kvGet: (k) => (Object.prototype.hasOwnProperty.call(KV, k) ? KV[k] : null),
    kvSet: (k, v) => { ev('kv.set', k, v); KV[k] = v; },
    kvKeysWithPrefix: () => { ev('genome.gc'); return []; },
    kvDelete() {},
    getDb: () => { ev('genome.baseline'); throw new Error('no db'); },
  };
  const trend = createTrendMonitor({ log, now, kv: memKv(), env: {}, sleep: abortable });
  trend.loadState = () => {};
  trend.refresh = async () => { ev('trend.refresh'); return []; };
  const tracker = createSignalTracker({
    repo: { getTrackableSignals: () => { ev('tracker.cycle'); return []; }, getExpireCandidates: () => [] },
    provider: {}, notifier: bot.notifier, sse: null, log,
  });

  const free = createFreeReport({ log, now, kv: memKv() });
  sched = createScheduler({
    side: 'all',
    deps: {
      log, env: { ...S.env }, now, mono: () => Date.now(), bot, um, fetcher, cache, scanners, wsPool,
      smcDeps: { log, now, cache, fetcher, um, freeReport: free, access: { strategyEnabled: () => false, can: () => false } },
      candleStore: { cleanup: () => { ev('gc.candles'); return 0; }, candlePrefetchLoop: candleStoreReal.candlePrefetchLoop },
      historyLoader: { getTopCoins: async () => { ev('prefetch'); return []; } },
      ghost: {
        runGhostCleanup: (db, { maxAgeDays }) => { ev('ghost.cleanup', maxAgeDays); return [0, 0]; },
        runTradesGc: () => { ev('gc.trades'); return 0; },
      },
      db: {},
      cacheGcOnce: () => { ev('gc.cleanup'); return {}; },
      genomeStore, genomeLock: { held: false },
      runGeneration: async ({ strategy, tf }) => {
        ev('genome.evolve', strategy, tf);
        return { ok: true, generation: 1, best_fitness: 0.5, best_wr: 50.0, best_pf: 1.5, elapsed: 12.0 };
      },
      cpuRatio: async (w) => { await wait(w * 1000); return 0.0; },
      trend, tracker,
      regime: createRegimeLoop({ fetcher, log, now, kv: memKv(), cache }),
      momentum: createMomentumDetector({ log, now }),
      coinQuality: createCoinQualityLearner({ log, now, kv: memKv(), repo: { coinQualityPairs: () => { ev('coinq.recompute'); return []; } } }),
      freeReport: free,
      regimeProvider: false,
      registry: { forceSave: () => 0 },
    },
  });
  const started = sched.start();
  await vi.advanceTimersByTimeAsync(HORIZON * 1000 - 1);
  const snapshot = { events: EVENTS.slice(), alerts: ALERTS.slice(), logs: LOGS.slice(), started };
  const stopP = sched.stop();
  await vi.advanceTimersByTimeAsync(5000);
  const stopRes = await stopP;
  CacheWarmer.prototype.warmOneCycle = origWarm;
  mdLog.setLogger(null);
  vi.useRealTimers();
  return { ...snapshot, stopRes, stopLogs: LOGS.slice(snapshot.logs.length) };
}

const byName = (events) => {
  const out = {};
  for (const [t, name, ...args] of events) {
    if (t >= HORIZON) continue;
    (out[name] = out[name] || []).push(name === 'genome.baseline' ? [round3(t)] : [round3(t), ...args]);
  }
  return out;
};

describe('scheduler vs bot.py loop timings (6 simulated hours, PY311 trace)', () => {
  beforeAll(async () => { JS = await runJs(); }, 120_000);
  afterAll(() => { vi.useRealTimers(); });

  it('starts every task of the trace, in the bot.py gather order', () => {
    expect(JS.started).toEqual([
      'scanner', 'smc_coin_warmup', 'cache_gc', 'genome_maintenance', 'health_monitor', 'coin_quality',
      'regime_loop', 'momentum_loop', 'ghost_cleanup', 'genome_evolution', 'candle_prefetch', 'ws_feed',
      'cache_warmer', 'smc_scanner', 'volume_scanner', 'free_report', 'trend_monitor', 'signal_tracker',
    ]);
  });

  it('the trace covers every loop (sanity of the fixture)', () => {
    const names = Object.keys(byName(TRACE.events)).sort();
    expect(names).toEqual(['alert', 'coinq.recompute', 'fetch.candles', 'fetch.pairs', 'gc.candles', 'gc.cleanup', 'gc.trades',
      'genome.baseline', 'genome.evolve', 'genome.gc', 'ghost.cleanup', 'kv.set', 'levels.cycle', 'prefetch', 'tracker.cycle',
      'trend.refresh', 'um.active', 'um.all', 'volume.cycle', 'warmer.cycle', 'ws.run']);
    expect(TRACE.python).toMatch(/^3\.11\./);
  });

  it('every loop fires at the same instants with the same arguments', () => {
    const py = byName(TRACE.events);
    const js = byName(JS.events);
    expect(Object.keys(js).sort()).toEqual(Object.keys(py).sort());
    for (const name of Object.keys(py)) {
      expect({ name, calls: js[name] }).toEqual({ name, calls: py[name] });
    }
  });

  it('the same admin alerts (restart backoff incl. the escalated delay after a healthy run, Health Alert)', () => {
    const py = TRACE.alerts.filter((a) => a[0] < HORIZON).map((a) => [round3(a[0]), a[1], a[2]]);
    expect(JS.alerts).toEqual(py);
    // 10 → 10 → 20 → (healthy 1920 s run) still 40, then back to 10 — the reset applies after the sleep
    expect(py.map((a) => a[2].split('\n')[0])).toEqual([
      '💀 <b>scanner упала — авто-рестарт через 10s</b>',
      '💀 <b>scanner упала — авто-рестарт через 10s</b>',
      '💀 <b>scanner упала — авто-рестарт через 20s</b>',
      '💀 <b>volume_scanner упала — авто-рестарт через 10s</b>',
      '💀 <b>scanner упала — авто-рестарт через 40s</b>',
      '🚨 <b>Health Alert</b>',
      '🚨 <b>Health Alert</b>',
      '🚨 <b>Health Alert</b>',
    ]);
  });

  it('the same log lines (level, text, instant)', () => {
    const norm = (rows, drop) => rows
      .filter((r) => r[0] < HORIZON && !drop.some((re) => re.test(r[r.length - 1])))
      .map((r) => JSON.stringify([round3(r[0]), r[r.length - 2], r[r.length - 1]]))
      .sort();
    const py = norm(TRACE.logs.map((r) => [r[0], r[2], r[3]]), PY_ONLY);
    const js = norm(JS.logs, JS_ONLY);
    expect(js).toEqual(py);
  });

  it('graceful stop: the shutdown line, every loop ends inside the 4 s window, registry saved', () => {
    expect(JS.stopRes.pending).toBe(0);
    expect(JS.stopRes.saved).toBe(0);
    const msgs = JS.stopLogs.map((r) => r[2]);
    expect(msgs[0]).toBe('🛑 Завершение — отменяем фоновые задачи...');
    expect(msgs).toContain('🛑 signal_registry persisted: 0 записей');
    // the SMC loop is cancelled in its wake wait: no "SMC Scanner stopped." (the bot logs it only
    // when the cancellation lands inside _scan_cycle)
    expect(msgs).not.toContain('SMC Scanner stopped.');
    expect(msgs).toContain('regime_loop остановлен.');
  });
});
