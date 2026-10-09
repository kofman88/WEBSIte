/**
 * startEngine() runs the bot's report loops on the main thread (bot.py gather: daily_summary_loop,
 * weekly_digest_loop — services/engine/reports.js, texts verified in tests/engine/stats/reports*.test.js):
 *   • `mainDeps.only` selects them like the scheduler's tasks, `mainDeps.reports` replaces them, stop() stops them;
 *   • the default instance on the site DB: Monday 09:05 UTC the weekly digest reaches a user with
 *     signals in the last 7 days as an in-app `report` notification (the bot's message), the ISO week
 *     is stored in kv `weekly_digest_last_week`; the 23:55 UTC daily summary skips users without
 *     auto-trade (the bot's rule) — all under fake timers, no real sleep.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { createRequire } from 'module';
import { setupEnv, insertUser } from '../../app/data/helpers.js';

const req = createRequire(import.meta.url);
setupEnv('reports-wiring');

const MONDAY_0900 = Date.UTC(2026, 9, 5, 9, 0, 0) / 1000;     // Monday 2026-10-05 09:00 UTC
const silent = { debug() {}, info() {}, warn() {}, warning() {}, error() {} };

class FakeWorker extends EventEmitter {
  constructor() { super(); this.posted = []; }
  postMessage(m) {
    this.posted.push(m);
    if (m.type === 'shutdown') Promise.resolve().then(() => { this.emit('message', { type: 'stopped' }); this.emit('exit', 0); });
  }
  terminate() { Promise.resolve().then(() => this.emit('exit', 1)); return Promise.resolve(1); }
}

let db; let EW; let regimeHook; let ts;
beforeAll(() => {
  db = req('../../../models/database.js');
  EW = req('../../../workers/engineWorker.js');
  regimeHook = req('../../../services/genome/regime.js');
  ts = req('../../../services/traderSettingsService.js');
});

afterEach(() => {
  vi.useRealTimers();
  regimeHook.setRegimeProvider(null);
});

const delivery = { alertAdmins: async () => 0, handleWorkerMessage: () => false };

describe('report loops in startEngine', () => {
  it('only / replacement / stop', async () => {
    vi.useFakeTimers({ now: MONDAY_0900 * 1000, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const calls = [];
    const fake = { startDaily: () => calls.push('daily'), startWeekly: () => calls.push('weekly'), stop: () => calls.push('stop') };
    let eng = EW.startEngine({ log: silent, delivery, spawn: () => new FakeWorker(), mainDeps: { only: [], log: silent, reports: fake } });
    expect(calls).toEqual([]);
    await eng.stop();
    expect(calls).toEqual(['stop']);
    calls.length = 0;
    eng = EW.startEngine({ log: silent, delivery, spawn: () => new FakeWorker(), mainDeps: { only: ['weekly_digest'], log: silent, reports: fake } });
    expect(calls).toEqual(['weekly']);
    await eng.stop();
    calls.length = 0;
    eng = EW.startEngine({ log: silent, delivery, spawn: () => new FakeWorker(), mainDeps: { only: ['daily_summary', 'weekly_digest'], log: silent, reports: fake } });
    expect(calls).toEqual(['daily', 'weekly']);
    await eng.stop();
    expect(calls).toEqual(['daily', 'weekly', 'stop']);
  });

  it('the default loops on the site DB: Monday 09:05 weekly digest → a report notification; 23:55 daily skips non-auto-trade users', async () => {
    vi.useFakeTimers({ now: MONDAY_0900 * 1000, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    insertUser(db, 1201);
    insertUser(db, 1202);
    for (const uid of [1201, 1202]) ts.getOrCreate(uid);
    const ins = db.prepare(`INSERT INTO signal_trades (trade_id, user_id, symbol, direction, entry, sl, original_sl, tp1, tp2, tp3,
      timeframe, strategy, created_at, signal_msg_id, progress_stage, progress_ts, result, order_id)
      VALUES (?, ?, 'BTC-USDT-SWAP', 'LONG', 100, 98, 98, 103, 105, 108, '1h', 'LEVELS', ?, 1, ?, ?, '', '')`);
    ins.run('rw-1', 1201, MONDAY_0900 - 2 * 86400, 'TP1', MONDAY_0900 - 2 * 86400 + 3600);
    ins.run('rw-2', 1201, MONDAY_0900 - 3 * 86400, 'SL', MONDAY_0900 - 3 * 86400 + 3600);
    const env = { ...process.env, DAILY_SUMMARY_ENABLED: '1', WEEKLY_DIGEST_ENABLED: '1' };
    const eng = EW.startEngine({ log: silent, env, delivery, spawn: () => new FakeWorker(), mainDeps: { only: ['daily_summary', 'weekly_digest'], log: silent } });
    try {
      expect(eng.reports).toBeTruthy();
      const reports = () => db.prepare("SELECT user_id, type, title, body, link FROM notifications WHERE type = 'report' ORDER BY id").all();
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
      expect(reports()).toEqual([]);
      await vi.advanceTimersByTimeAsync(60 * 1000 + 5000);
      const rows = reports();
      expect(rows.map((r) => r.user_id)).toEqual([1201]);                 // 1202 had no signal in 7 days
      expect(rows[0].title).toMatch(/^📊 Итоги недели · /);
      expect(rows[0].link).toBe('/app/?tab=stats');
      expect(db.prepare("SELECT value FROM engine_kv WHERE key = 'weekly_digest_last_week'").get().value).toMatch(/^2026-W41$/);
      // 23:55 UTC: no user has auto-trade → nothing sent (the bot's daily summary rule)
      await vi.advanceTimersByTimeAsync((14 * 3600 + 50 * 60) * 1000);
      expect(reports().length).toBe(1);
    } finally {
      await eng.stop();
    }
  });

  it('challenge / entry_advisor / drip_campaign / engagement loops: started like the bot, selectable with only, replaceable, stopped by stop()', async () => {
    vi.useFakeTimers({ now: MONDAY_0900 * 1000, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const calls = [];
    const loop = (name) => () => { calls.push(`start:${name}`); return () => calls.push(`stop:${name}`); };
    const none = { startDaily() {}, startWeekly() {}, stop() {} };
    const loops = { challengeLoop: loop('challenge'), entryAdvisorLoop: loop('advisor'), dripLoop: loop('drip'), engagementLoop: loop('engagement') };
    let eng = EW.startEngine({ log: silent, delivery, spawn: () => new FakeWorker(),
      mainDeps: { only: [], log: silent, reports: none, ...loops } });
    expect(calls).toEqual([]);
    await eng.stop();
    expect(calls).toEqual([]);
    eng = EW.startEngine({ log: silent, delivery, spawn: () => new FakeWorker(),
      mainDeps: { only: ['challenge', 'entry_advisor', 'drip_campaign', 'engagement'], log: silent, reports: none, ...loops } });
    expect(calls).toEqual(['start:challenge', 'start:advisor', 'start:drip', 'start:engagement']);
    await eng.stop();
    expect(calls).toEqual(['start:challenge', 'start:advisor', 'start:drip', 'start:engagement',
      'stop:challenge', 'stop:advisor', 'stop:drip', 'stop:engagement']);
    calls.length = 0;
    eng = EW.startEngine({ log: silent, delivery, spawn: () => new FakeWorker(),
      mainDeps: { only: ['engagement'], log: silent, reports: none, ...loops } });
    expect(calls).toEqual(['start:engagement']);
    await eng.stop();
  });

  it('the default challenge loop ticks after the bot\'s 90 s delay, then every LOOP_INTERVAL_S, and stops with the engine', async () => {
    vi.useFakeTimers({ now: MONDAY_0900 * 1000, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const cs = req('../../../services/challengeService.js');
    // tick() starts with kv.itemsWithPrefix('challenge_') (loadAllActive): each call is one pass
    const passes = [];
    cs.configure({ kv: { itemsWithPrefix: (p) => { passes.push([Date.now() / 1000 - MONDAY_0900, p]); return []; } } });
    const eng = EW.startEngine({ log: silent, delivery, spawn: () => new FakeWorker(), mainDeps: { only: ['challenge'], log: silent, reports: null } });
    try {
      await vi.advanceTimersByTimeAsync(89 * 1000);
      expect(passes).toEqual([]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(passes).toEqual([[90, 'challenge_']]);
      await vi.advanceTimersByTimeAsync(cs.CONFIG.LOOP_INTERVAL_S * 1000);
      expect(passes.map((x) => x[0])).toEqual([90, 90 + cs.CONFIG.LOOP_INTERVAL_S]);
    } finally {
      await eng.stop();
      cs.resetDeps();
    }
    await vi.advanceTimersByTimeAsync(10 * cs.CONFIG.LOOP_INTERVAL_S * 1000);
    expect(passes.length).toBe(2);                     // no pass after stop()
  });

  it('the default entry advisor loop: first cycle after 600 s, then every INTERVAL_S; ENTRY_ADVISOR_ENABLED=0 → no loop', async () => {
    vi.useFakeTimers({ now: MONDAY_0900 * 1000, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const ea = req('../../../services/entryAdvisor.js');
    const cycles = [];
    ea.configure({ activeUsers: () => { cycles.push(Date.now() / 1000 - MONDAY_0900); return []; }, log: silent });
    let eng = EW.startEngine({ log: silent, delivery, spawn: () => new FakeWorker(), mainDeps: { only: ['entry_advisor'], log: silent, reports: null } });
    try {
      await vi.advanceTimersByTimeAsync(599 * 1000);
      expect(cycles).toEqual([]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(cycles).toEqual([600]);
      await vi.advanceTimersByTimeAsync(ea.config().INTERVAL_S * 1000);
      expect(cycles).toEqual([600, 600 + ea.config().INTERVAL_S]);
    } finally {
      await eng.stop();
    }
    await vi.advanceTimersByTimeAsync(3 * ea.config().INTERVAL_S * 1000);
    expect(cycles.length).toBe(2);
    cycles.length = 0;
    ea.configure({ config: { ENABLED: false } });
    eng = EW.startEngine({ log: silent, delivery, spawn: () => new FakeWorker(), mainDeps: { only: ['entry_advisor'], log: silent, reports: null } });
    try {
      await vi.advanceTimersByTimeAsync(2 * ea.config().INTERVAL_S * 1000);
      expect(cycles).toEqual([]);
    } finally {
      await eng.stop();
      ea.resetDeps();
    }
  });
});
