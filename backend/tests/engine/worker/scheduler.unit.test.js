/**
 * services/engine/scheduler.js — the wrappers, HealthMonitor, cache_gc, the genome low-load wait
 * and cycle, the side split, the trend / regime default install, stop() — pinned against the
 * bot's code paths (bot.py _guarded / _guarded_restart, health_monitor.py, cache_gc.py,
 * genome._wait_for_low_load / genome_evolution_loop). Fake timers only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-m9b-scheduler-unit.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(process.env.DATABASE_PATH + ext); } catch (_e) { /* */ } });

const req = createRequire(import.meta.url);
const SCH = req('../../../services/engine/scheduler.js');

const T0 = 1791565200;

function capture() {
  const lines = [];
  const rec = (lvl) => (msg, extra) => lines.push([lvl, String(msg), extra === undefined ? null : extra]);
  return { lines, log: { debug: rec('DEBUG'), info: rec('INFO'), warning: rec('WARNING'), warn: rec('WARNING'), error: rec('ERROR'), critical: rec('CRITICAL') } };
}

function ctxFor({ log, alerts, alertFails = false } = {}) {
  const ac = new AbortController();
  return {
    ac,
    ctx: {
      signal: ac.signal, log, now: () => Date.now() / 1000, mono: () => Date.now(),
      sleep: SCH.makeSleep(ac.signal),
      bot: { alertAdmins: async (t) => { if (alertFails) throw new Error('tg down'); alerts.push([Date.now() / 1000 - T0, t]); return 1; } },
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 * 1000, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});
afterEach(() => { vi.useRealTimers(); });

describe('_guarded_restart', () => {
  it('backoff 10 → 20 → 40 … capped at 300 for a loop that keeps dying at once', async () => {
    const { log, lines } = capture();
    const alerts = [];
    const { ctx, ac } = ctxFor({ log, alerts });
    let n = 0;
    const p = SCH.guardedRestart('scanner', async () => { n += 1; throw new Error(`boom ${n}`); }, ctx);
    await vi.advanceTimersByTimeAsync((10 + 20 + 40 + 80 + 160 + 300 + 300) * 1000);
    ac.abort();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    const delays = alerts.map(([, t]) => Number(/через (\d+)s/.exec(t)[1]));
    expect(delays).toEqual([10, 20, 40, 80, 160, 300, 300, 300]);
    expect(alerts.map(([t]) => t)).toEqual([0, 10, 30, 70, 150, 310, 610, 910]);
    expect(lines.filter((l) => l[0] === 'CRITICAL').map((l) => l[1]).slice(0, 2)).toEqual([
      "💀 Задача 'scanner' упала (ran 0s) — авто-рестарт через 10s",
      "💀 Задача 'scanner' упала (ran 0s) — авто-рестарт через 20s",
    ]);
    expect(lines[0][2]).toMatch(/^Error: boom 1/);      // exc_info → the stack rides along
  });

  it('smc_scanner base_delay=30: 30 → 60 → 120 → 240 → 300', async () => {
    const alerts = [];
    const { ctx, ac } = ctxFor({ log: capture().log, alerts });
    const p = SCH.guardedRestart('smc_scanner', async () => { throw new Error('x'); }, ctx, { baseDelay: 30 });
    await vi.advanceTimersByTimeAsync((30 + 60 + 120 + 240) * 1000);
    ac.abort();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(alerts.map(([, t]) => t.split('\n')[0])).toEqual([
      '💀 <b>smc_scanner упала — авто-рестарт через 30s</b>', '💀 <b>smc_scanner упала — авто-рестарт через 60s</b>',
      '💀 <b>smc_scanner упала — авто-рестарт через 120s</b>', '💀 <b>smc_scanner упала — авто-рестарт через 240s</b>',
      '💀 <b>smc_scanner упала — авто-рестарт через 300s</b>',
    ]);
  });

  it('quirk: the reset after a healthy run (≥ 300 s) happens AFTER sleeping the escalated delay', async () => {
    const alerts = [];
    const { ctx, ac } = ctxFor({ log: capture().log, alerts });
    const runs = [0, 0, 400, 0];        // how long each run lasts before it throws
    let i = 0;
    const p = SCH.guardedRestart('scanner', async () => {
      const d = runs[i++] ?? 1e9;
      await new Promise((r) => setTimeout(r, d * 1000));
      throw new Error('x');
    }, ctx);
    await vi.advanceTimersByTimeAsync((10 + 20 + 400 + 40 + 10) * 1000);
    ac.abort();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    // 10, 20, then the 400 s run still waits 40 (the delay escalated by the short runs), then base 10
    expect(alerts.map(([, t]) => Number(/через (\d+)s/.exec(t)[1]))).toEqual([10, 20, 40, 10]);
  });

  it('a clean return is an intended stop: no alert, no restart', async () => {
    const alerts = [];
    const { ctx } = ctxFor({ log: capture().log, alerts });
    let n = 0;
    await SCH.guardedRestart('volume_scanner', async () => { n += 1; }, ctx);
    expect(n).toBe(1);
    expect(alerts).toEqual([]);
  });

  it('cancellation (stop) ends the wrapper without an alert; a failing alert is swallowed', async () => {
    const { log, lines } = capture();
    const alerts = [];
    const { ctx, ac } = ctxFor({ log, alerts, alertFails: true });
    const p = SCH.guardedRestart('scanner', async () => { throw new Error('x'); }, ctx);
    await vi.advanceTimersByTimeAsync(1);
    expect(lines.some((l) => l[0] === 'DEBUG' && l[1] === 'guarded_restart alert scanner failed')).toBe(true);
    ac.abort();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    const c2 = ctxFor({ log, alerts });
    c2.ac.abort();
    await SCH.guardedRestart('x', async () => { throw new Error('cancelled'); }, c2.ctx);
    expect(alerts).toEqual([]);
  });

  it('the alert escapes the error text (html.escape quote=True) and keeps str(e)[:300] in code points', async () => {
    const alerts = [];
    const { ctx, ac } = ctxFor({ log: capture().log, alerts });
    const msg = `<a href="x">'&'</a> ${'🙂'.repeat(400)}`;
    const p = SCH.guardedRestart('scanner', async () => { throw new Error(msg); }, ctx);
    await vi.advanceTimersByTimeAsync(1);
    ac.abort();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    const head = Array.from(msg).slice(0, 300).join('');
    expect(alerts[0][1]).toBe(`💀 <b>scanner упала — авто-рестарт через 10s</b>\n<code>${SCH.htmlEscape(head)}</code>`);
    expect(SCH.htmlEscape(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#x27;&amp;&#x27;&lt;/a&gt;');
  });
});

describe('_guarded', () => {
  it('a crash is reported (critical + admin alert) and the task stays dead', async () => {
    const { log, lines } = capture();
    const alerts = [];
    const { ctx } = ctxFor({ log, alerts });
    let n = 0;
    await SCH.guarded('trend_monitor', async () => { n += 1; throw new Error('bad <thing>'); }, ctx);
    expect(n).toBe(1);
    expect(lines.find((l) => l[0] === 'CRITICAL')[1]).toBe("💀 Задача 'trend_monitor' завершилась с необработанным исключением!");
    expect(alerts).toEqual([[0, '💀 <b>Задача упала: trend_monitor</b>\n<code>bad &lt;thing&gt;</code>\nТребуется перезапуск бота.']]);
  });

  it('cancellation is silent', async () => {
    const alerts = [];
    const { ctx, ac } = ctxFor({ log: capture().log, alerts });
    ac.abort();
    await SCH.guarded('x', async () => { throw new Error('AbortError'); }, ctx);
    expect(alerts).toEqual([]);
  });
});

describe('HealthMonitor (health_monitor.py)', () => {
  it('alerts only for monitored scanners that heart-beat once and then went silent past their timeout', async () => {
    const { log, lines } = capture();
    const sent = [];
    const hm = new SCH.HealthMonitor({ alertAdmins: async (t) => { sent.push(t); return 1; } }, { log, now: () => Date.now() / 1000 });
    const beats = [];
    hm.onHeartbeat = (n, t) => beats.push([n, t - T0]);
    expect(await hm.checkHealth()).toEqual([]);                  // nobody started yet → no alert
    hm.heartbeat('LEVELS');
    hm.heartbeat('VOLUME');
    hm.heartbeat('SMC');                                         // not monitored (no timeout)
    vi.setSystemTime((T0 + 901) * 1000);
    expect(await hm.checkHealth()).toEqual(['🔴 Сканер <b>LEVELS</b> не отвечает 15 мин!', '🔴 Сканер <b>VOLUME</b> не отвечает 15 мин!']);
    expect(sent).toEqual(['🚨 <b>Health Alert</b>\n\n🔴 Сканер <b>LEVELS</b> не отвечает 15 мин!\n🔴 Сканер <b>VOLUME</b> не отвечает 15 мин!']);
    expect(lines.at(-1)).toEqual(['WARNING', 'Health alert: 🔴 Сканер <b>LEVELS</b> не отвечает 15 мин! | 🔴 Сканер <b>VOLUME</b> не отвечает 15 мин!', null]);
    expect(beats).toEqual([['LEVELS', 0], ['VOLUME', 0], ['SMC', 0]]);
    expect(SCH.HealthMonitor.SCANNER_TIMEOUTS).toEqual({ LEVELS: 600, ORPHAN: 1200, VOLUME: 900 });
  });

  it('elapsed == timeout is not an alert (strict >); minutes = int(elapsed / 60)', async () => {
    const hm = new SCH.HealthMonitor({ alertAdmins: async () => 1 }, { log: capture().log, now: () => Date.now() / 1000 });
    hm.heartbeat('LEVELS');
    vi.setSystemTime((T0 + 600) * 1000);
    expect(await hm.checkHealth()).toEqual([]);
    vi.setSystemTime((T0 + 659.9) * 1000);
    expect(await hm.checkHealth()).toEqual(['🔴 Сканер <b>LEVELS</b> не отвечает 10 мин!']);
  });

  it('API error counter: > 10 per period alerts, every check resets the counters', async () => {
    const hm = new SCH.HealthMonitor({ alertAdmins: async () => 1 }, { log: capture().log, now: () => Date.now() / 1000 });
    for (let i = 0; i < 11; i++) hm.reportError('bingx');
    for (let i = 0; i < 10; i++) hm.reportError('okx');
    expect(await hm.checkHealth()).toEqual(['⚠️ <b>bingx</b>: 11 API-ошибок за период']);
    expect(await hm.checkHealth()).toEqual([]);
  });

  it('run_forever: 120 s, the start line, then a check every 300 s; a failing alert is only a debug line', async () => {
    const { log, lines } = capture();
    const ac = new AbortController();
    const hm = new SCH.HealthMonitor({ alertAdmins: async () => { throw new Error('down'); } }, { log, now: () => Date.now() / 1000 });
    hm.heartbeat('VOLUME');
    const p = hm.runForever({ signal: ac.signal, sleep: SCH.makeSleep(ac.signal) });
    await vi.advanceTimersByTimeAsync(119_000);
    expect(lines).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(lines[0][1]).toBe('🏥 HealthMonitor запущен (проверка каждые 300 сек)');
    await vi.advanceTimersByTimeAsync(1_200_000);
    expect(lines.filter((l) => l[1].startsWith('Health alert')).length).toBe(2);   // VOLUME (900 s): at 1020 and 1320
    expect(lines.some((l) => l[0] === 'DEBUG' && l[1] === 'health alert send: down')).toBe(true);
    ac.abort();
    await p;
  });
});

describe('cache_gc', () => {
  it('_cleanup_once on the site caches, in the bot order, with the bot keys', () => {
    const { createSmcScanner } = req('../../../services/engine/smcScanner.js');
    const { createSignalConfluence } = req('../../../services/engine/signalConfluence.js');
    const { createFreeReport } = req('../../../services/engine/freeReport.js');
    const { memKv } = req('../pipeline/vectors.js');
    const now = T0;
    const sc = createSmcScanner({ now: () => now, log: capture().log });
    sc._tfCache.set('A|4H', [now - 3601, null]);
    sc._tfCache.set('B|4H', [now - 100, null]);
    sc._lastScan.set(1, now - 86401);
    sc._lastScan.set(2, now - 10);
    let t = now - 4000;
    const conf = createSignalConfluence({ now: () => t });
    conf.recordSignal('X', 'LONG', 'SMC');
    t = now;
    const fr = createFreeReport({ now: () => now, kv: memKv(), log: capture().log });
    fr.previewSent.set(7, new Map([['X:LONG', '2026-10-08']]));
    fr.previewSent.set(8, new Map([['X:LONG', '2026-10-09']]));
    const freed = SCH.cacheGcOnce({
      now: () => now, log: capture().log, smcInstance: () => sc,
      scanners: { loadModule: () => ({ gcSent: () => 3 }) },
      confluence: () => conf, balanceCache: () => ({ gcCache: () => 2 }), freeReport: () => fr,
    });
    expect(Object.entries(freed)).toEqual([
      ['smc._tf_cache', 1], ['smc._SMC_LAST_SCAN', 1], ['volume_scanner._sent_bars', 3],
      ['signal_confluence._recent', 1], ['balance_cache._BALANCE_CACHE', 2], ['free_report._FREE_PREVIEW_SENT', 1],
    ]);
    expect(Array.from(sc._lastScan.keys())).toEqual([2]);
    expect(Array.from(fr.previewSent.keys())).toEqual([8]);
  });

  it('gc_loop: start line, first pass at 300 s, hourly; the 24 h block (candles + trades GC) at 300 s and after 24 h', async () => {
    const { log, lines } = capture();
    const ev = [];
    const { ctx, ac } = ctxFor({ log, alerts: [] });
    Object.assign(ctx, {
      cacheGcOnce: () => { ev.push(['gc', Date.now() / 1000 - T0]); return ev.length === 1 ? { 'smc._tf_cache': 4, 'signal_confluence._recent': 2 } : {}; },
      candleStore: () => ({ cleanup: () => ev.push(['candles', Date.now() / 1000 - T0]) }),
      ghost: () => ({ runTradesGc: () => ev.push(['trades', Date.now() / 1000 - T0]) }),
      db: () => ({}),
    });
    const p = SCH.cacheGcLoop(ctx);
    await vi.advanceTimersByTimeAsync((300 + 25 * 3600) * 1000);
    ac.abort();
    await p;
    expect(lines[0][1]).toBe('🧹 Cache GC запущен (интервал 3600с)');
    expect(lines.find((l) => l[1].startsWith('🧹 Cache GC: удалено'))[1]).toBe('🧹 Cache GC: удалено записей — smc._tf_cache=4, signal_confluence._recent=2');
    expect(ev.filter((e) => e[0] === 'candles').map((e) => e[1])).toEqual([300, 300 + 25 * 3600]);
    expect(ev.filter((e) => e[0] === 'trades').map((e) => e[1])).toEqual([300, 300 + 25 * 3600]);
    expect(ev.filter((e) => e[0] === 'gc').length).toBe(26);
  });
});

describe('genome: _wait_for_low_load(0.9, 600) and the evolution cycle', () => {
  it('high CPU twice, then OK: two skip lines, the OK line with the waited seconds → true', async () => {
    const { log, lines } = capture();
    const { ctx } = ctxFor({ log, alerts: [] });
    const ratios = [0.95, 0.91, 0.5];
    ctx.cpuRatio = async (w) => { await new Promise((r) => setTimeout(r, w * 1000)); return ratios.shift(); };
    const p = SCH.waitForLowLoad(ctx);
    await vi.advanceTimersByTimeAsync(200_000);
    expect(await p).toBe(true);
    const cpus = require('os').availableParallelism ? require('os').availableParallelism() : require('os').cpus().length;
    expect(lines.map((l) => l[1])).toEqual([
      `🧬 skip evolution: process cpu=0.95 of ${cpus} CPU >= 0.90, recheck in 60s`,
      `🧬 skip evolution: process cpu=0.91 of ${cpus} CPU >= 0.90, recheck in 60s`,
      `🧬 process cpu=0.50 of ${cpus} CPU OK (waited 135s) — starting evolution`,
    ]);
  });

  it('always busy: gives up after 600 s (10 checks) → false; an exception → true at once', async () => {
    const { log, lines } = capture();
    const { ctx } = ctxFor({ log, alerts: [] });
    ctx.cpuRatio = async (w) => { await new Promise((r) => setTimeout(r, w * 1000)); return 1.0; };
    const p = SCH.waitForLowLoad(ctx);
    await vi.advanceTimersByTimeAsync(700_000);
    expect(await p).toBe(false);
    expect(lines.length).toBe(10);
    ctx.cpuRatio = async () => { throw new Error('no /proc'); };
    expect(await SCH.waitForLowLoad(ctx)).toBe(true);
    expect(lines.at(-1)).toEqual(['WARNING', 'genome._wait_for_low_load() unhandled exception: no /proc', null]);
  });

  it('cycle: LEVELS → SMC → VOLUME × their TFs in the genome worker, the bot line or "failed", 10 s apart', async () => {
    const { log, lines } = capture();
    const { ctx } = ctxFor({ log, alerts: [] });
    const calls = [];
    ctx.runGeneration = async (o) => {
      calls.push([o.strategy, o.tf, o.mode, Date.now() / 1000 - T0]);
      if (o.strategy === 'SMC' && o.tf === '1h') return { ok: false, error: 'Таймаут' };
      return { ok: true, generation: 7, best_fitness: 0.12345, best_wr: 61.25, best_pf: 1.875, elapsed: 42.5 };
    };
    const p = SCH.runEvolutionCycle(ctx);
    await vi.advanceTimersByTimeAsync(100_000);
    const out = await p;
    expect(calls.map((c) => c.slice(0, 2).join('/'))).toEqual(['LEVELS/15m', 'LEVELS/1h', 'LEVELS/4h', 'SMC/15m', 'SMC/1h', 'SMC/4h', 'VOLUME/15m', 'VOLUME/1h', 'VOLUME/4h']);
    expect(calls.map((c) => c[3])).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80]);
    expect(calls.every((c) => c[2] === 'cycle')).toBe(true);
    expect(lines[0][1]).toBe('🧬 LEVELS/15m evolution: gen=7 fitness=0.123 WR=61.2% PF=1.88 (42s)');
    expect(lines[4]).toEqual(['WARNING', '🧬 SMC/1h evolution failed: Таймаут', null]);
    expect(out.length).toBe(8);
  });
});

describe('createScheduler', () => {
  it('the side split: main = ghost cleanup + Genome maintenance / evolution, worker = the rest; gather order kept', () => {
    const fake = { get: () => null, loadModule: () => null, describe: () => ({}) };
    const main = SCH.createScheduler({ side: 'main', deps: { scanners: fake, bot: {}, log: capture().log } });
    const worker = SCH.createScheduler({ side: 'worker', deps: { scanners: fake, bot: {}, log: capture().log } });
    expect(main.tasks).toEqual(['genome_maintenance', 'ghost_cleanup', 'genome_evolution']);
    expect(worker.tasks).toEqual(['scanner', 'smc_coin_warmup', 'cache_gc', 'health_monitor', 'coin_quality', 'regime_loop',
      'momentum_loop', 'candle_prefetch', 'ws_feed', 'cache_warmer', 'smc_scanner', 'volume_scanner', 'free_report',
      'trend_monitor', 'signal_tracker']);
    expect(SCH.TASKS.filter((t) => t.restart).map((t) => [t.name, t.baseDelay])).toEqual([['scanner', 10], ['smc_scanner', 30], ['volume_scanner', 10]]);
  });

  it('a scanner module that is not installed is logged and its task is not started (the bot\'s _SMC_OK)', () => {
    const { log, lines } = capture();
    const fake = { get: () => null, loadModule: () => null, describe: () => ({}) };
    const s = SCH.createScheduler({ side: 'worker', deps: { scanners: fake, bot: {}, log, only: ['scanner', 'smc_scanner', 'volume_scanner'] } });
    expect(s.start()).toEqual([]);
    expect(lines.map((l) => l[1])).toEqual([
      '[ENGINE] LEVELS scanner not installed (services/engine/levelsScanner.js) — task "scanner" not started',
      'smc import failed: services/engine/smcScanner.js not available',
      '[ENGINE] VOLUME scanner not installed (services/engine/volumeScanner.js) — task "volume_scanner" not started',
    ]);
  });

  it('MidScanner(config, bot, um, stop_event) gets the bot Config fields, its fetcher feeds the other loops, _health is set', async () => {
    let made = null;
    class Mid {
      constructor(config, bot, um, opts) { made = { config, bot, um, opts }; this.fetcher = { tag: 'mid' }; }
      async runForever() { await new Promise((r) => this.opts_stop(r)); }
      opts_stop(r) { made.opts.stopEvent.wait().then(r); }
    }
    const fake = { get: (n) => (n === 'MidScanner' ? Mid : null), loadModule: () => null, describe: () => ({}) };
    const bot = { alertAdmins: async () => 1 };
    const um = { tag: 'um' };
    const s = SCH.createScheduler({ side: 'worker', deps: { scanners: fake, bot, um, log: capture().log, only: ['scanner'], registry: { forceSave: () => 3 } } });
    expect(s.start()).toEqual(['scanner']);
    expect(made.config.API_CONCURRENCY).toBe(12);
    expect(made.config.SCAN_WORKERS).toBe(10);
    expect(made.config.SCAN_LOOP_SLEEP).toBe(5);
    expect(made.bot).toBe(bot);
    expect(made.um).toBe(um);
    expect(s.ctx.fetcher()).toEqual({ tag: 'mid' });
    expect(s.ctx.levels._health).toBe(s.ctx.health);
    const stopP = s.stop();
    await vi.advanceTimersByTimeAsync(10);
    expect(await stopP).toEqual({ pending: 0, saved: 3 });
  });

  it('stop(): a loop that ignores the cancellation is counted after 4 s ("🛑 shutdown: N задач …")', async () => {
    const { log, lines } = capture();
    class Stubborn { constructor() { this.fetcher = {}; } runForever() { return new Promise(() => {}); } }
    const fake = { get: (n) => (n === 'MidScanner' ? Stubborn : null), loadModule: () => null, describe: () => ({}) };
    const s = SCH.createScheduler({ side: 'worker', deps: { scanners: fake, bot: {}, log, only: ['scanner'], registry: { forceSave: () => 0 } } });
    s.start();
    const p = s.stop();
    await vi.advanceTimersByTimeAsync(4000);
    expect(await p).toEqual({ pending: 1, saved: 0 });
    expect(lines.map((l) => l[1])).toEqual([
      '🛑 Завершение — отменяем фоновые задачи...',
      '🛑 shutdown: 1 задач не завершились за 4с — продолжаем',
      '🛑 signal_registry persisted: 0 записей',
    ]);
  });

  it('installDefault: the module-level helpers read the loop instance (trend_monitor / market_regime globals)', () => {
    const tm = req('../../../services/engine/trendMonitor.js');
    const rl = req('../../../services/engine/regimeLoop.js');
    const before = { tm: { ...tm.defaultMonitor }, rl: { ...rl.defaultLoop } };
    try {
      const inst = tm.createTrendMonitor({ log: capture().log, env: {} });
      SCH.installDefault(tm.defaultMonitor, inst);
      inst._seed({ '15m': 'UP' });
      expect(tm.getTrend('15m')).toBe('UP');
      const r = rl.createRegimeLoop({ log: capture().log, kv: { get: () => null, set() {} } });
      SCH.installDefault(rl.defaultLoop, r);
      r.setCachedRegime('trending_up');
      expect(rl.getCachedRegime()).toBe('trending_up');
    } finally {
      Object.assign(tm.defaultMonitor, before.tm);
      Object.assign(rl.defaultLoop, before.rl);
    }
  });

  it('cache warmer start: no feed within 30 × 1 s → the bot warning, no warmer', async () => {
    const { log, lines } = capture();
    const { ctx, ac } = ctxFor({ log, alerts: [] });
    ctx.wsPool = () => ({ getActiveFeeds: () => [] });
    const p = SCH.startCacheWarmer(ctx);
    await vi.advanceTimersByTimeAsync(30_000);
    await p;
    expect(lines).toEqual([['WARNING', 'cache_warmer: _active_feed(s) не появились за 30с — abort', null]]);
    expect(Date.now() / 1000 - T0).toBe(30);
    ac.abort();
  });

  it('errHead = str(e)[:300] by code points; botConfig reads API_CONCURRENCY / SCAN_WORKERS from the env', () => {
    expect(SCH.errHead(new Error('🙂'.repeat(301)))).toBe('🙂'.repeat(300));
    expect(SCH.errHead('plain')).toBe('plain');
    expect(SCH.botConfig({ API_CONCURRENCY: '7', SCAN_WORKERS: 'x' })).toMatchObject({ API_CONCURRENCY: 7, SCAN_WORKERS: 10, CHUNK_SIZE: 15 });
  });
});
