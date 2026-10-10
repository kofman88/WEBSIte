/**
 * PLAN_M15 U2 — the trade runtime in the engine worker (D21 / D22 / D24, Critic C-5 C-7 C-8 C-9 C-15 C-16,
 * INF-S-1):
 *   switches       TRADE_LOOPS_ENABLED × AUTOTRADE_ENABLED → executor / loops / ERROR (workerTradeRuntime)
 *   D24            the ORPHAN_SWEEP_* env against the bot's own import-time int() / strip() (fixture env_parse:
 *                  orphan_sweeper reloaded per value) and the runtime refusing a malformed int — ENABLED=0 too
 *   D5             the runtime's key reads (getApiKeys, tdb.getUserWithKeys) honour AUTOTRADE_EXCHANGES
 *   C-8            protect-only mode: restore at start, the GC of the shared registries, the auth-reset route
 *   C-7            no LEVELS scanner (the BE host) → the executor is not used; [M15-LOOPS-REQUIRED] any trade
 *                  loop not wired → the executor is not used either (protect only: the BE gap is a WARNING)
 *   the worker     registry load() before the scheduler starts (its line after 'ready'), heartbeat `loops`,
 *                  loop logs forwarded to main, no ORPHAN heartbeat, the shutdown abort cancelling an in-flight
 *                  trader request (no further request, < 4 s), a stray rejection in a loop not ending the thread
 *   shells         C-5 (an abort while a pass awaits a non-cancellable call → the stopped line, nothing more),
 *                  C-15 (an inner TimeoutError is an ordinary error), timers past 2^31 ms, the BE hook of the
 *                  LEVELS scanner (restoreHintThrottle handed to the BE monitor)
 */
import { describe, it, expect, afterAll } from 'vitest';
import path from 'path';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);
const H = req('./harness.js');
const site = H.setupSiteDb('runtime');
const { db } = site;
const asyncio = req('../../../services/autotrade/asyncio.js');
const AT = req('../../../services/autotrade/index.js');
const S = req('../../../services/autotrade/loopShells.js');
const { createTradeLoops } = req('../../../services/autotrade/tradeLoops.js');
const SCH = req('../../../services/engine/scheduler.js');
const EW = req('../../../workers/engineWorker.js');
const mdLog = req('../../../services/marketData/mdLog.js');
const { pyStrRepr } = req('../../../strategies/common/pyUnicode.js');
const FX = H.loadFixture('m15_loop_trace');

afterAll(() => { mdLog.setLogger(null); site.cleanup(); });

function capture() {
  const lines = [];
  const mk = (level) => (msg, extra) => lines.push([level, String(msg), extra === undefined ? null : extra]);
  return { lines, log: { debug: mk('DEBUG'), info: mk('INFO'), warning: mk('WARNING'), warn: mk('WARNING'), error: mk('ERROR'), critical: mk('CRITICAL') } };
}
async function withMdLog(fn) {
  const cap = capture();
  mdLog.setLogger({ debug: cap.log.debug, info: cap.log.info, warn: cap.log.warning, error: cap.log.error });
  try { return [await fn(), cap]; } finally { mdLog.setLogger(null); }
}
const turn = () => new Promise((r) => setImmediate(r));
const until = async (cond, ms = 5000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 2));
  }
};
const fastTimers = { setTimer: (fn, ms) => setTimeout(fn, ms / 1000), clearTimer: (h) => clearTimeout(h) };   // 1 s = 1 ms
const fakeScanners = { get: () => null, loadModule: () => null, describe: () => ({}) };
const cacheStub = { getCache: () => ({}), initCache: () => {}, getCandles: () => null, getCoins: () => null };
const exSymbols = { startBackgroundRefresh: async () => ({ stop() {} }), getStats: () => ({}) };

describe('D22 switches', () => {
  it('TRADE_LOOPS_ENABLED: 1 on, 0 off (after trim), anything else follows AUTOTRADE_ENABLED', () => {
    for (const at of [undefined, '', '0', '1', ' 1 ', 'true']) {
      for (const lp of [undefined, '', '0', '1', ' 1 ', ' 0 ', 'yes', 'true']) {
        const env = {};
        if (at !== undefined) env.AUTOTRADE_ENABLED = at;
        if (lp !== undefined) env.TRADE_LOOPS_ENABLED = lp;
        const atOn = at !== undefined && at.trim() === '1';
        const want = lp !== undefined && lp.trim() === '1' ? true : (lp !== undefined && lp.trim() === '0' ? false : atOn);
        expect({ env, on: AT.tradeLoopsEnabled(env) }).toEqual({ env, on: want });
        expect(AT.autoTradeEnabled(env)).toBe(atOn);
      }
    }
  });

  it('workerTradeRuntime: the matrix (executor needs loops; protect only without the executor; both unset = nothing)', async () => {
    const bot = { alertAdmins: async () => 0 };
    const rows = [
      [{}, false, false, null],
      [{ AUTOTRADE_ENABLED: '0' }, false, false, null],
      [{ TRADE_LOOPS_ENABLED: '0' }, false, false, null],
      [{ AUTOTRADE_ENABLED: '1' }, true, true, null],
      [{ AUTOTRADE_ENABLED: ' 1 ', TRADE_LOOPS_ENABLED: 'yes' }, true, true, null],
      [{ AUTOTRADE_ENABLED: '1', TRADE_LOOPS_ENABLED: '1' }, true, true, null],
      [{ AUTOTRADE_ENABLED: '1', TRADE_LOOPS_ENABLED: '0' }, false, false,
        '[AUTO-TRADE] not started: TRADE_LOOPS_ENABLED=0 — open positions would have no BE monitor / reconcile'],
      [{ AUTOTRADE_ENABLED: '1', TRADE_LOOPS_ENABLED: ' 0 ' }, false, false,
        '[AUTO-TRADE] not started: TRADE_LOOPS_ENABLED=0 — open positions would have no BE monitor / reconcile'],
      [{ TRADE_LOOPS_ENABLED: '1' }, false, true, null],
      [{ AUTOTRADE_ENABLED: 'true', TRADE_LOOPS_ENABLED: '1' }, false, true, null],
    ];
    for (const [env0, wantExec, wantLoops, err] of rows) {
      const env = { AUTOTRADE_EXCHANGES: 'bybit', ...env0 };
      const [r, cap] = await withMdLog(() => EW.workerTradeRuntime(bot, env));
      expect({ env, exec: Boolean(r.autoTrade), loops: Boolean(r.tradeLoops), runtime: Boolean(r.runtime) })
        .toEqual({ env, exec: wantExec, loops: wantLoops, runtime: wantLoops });
      const errors = cap.lines.filter((l) => l[0] === 'ERROR').map((l) => l[1]);
      expect(errors).toEqual(err ? [err] : []);
      if (wantExec) {
        expect(r.autoTrade.runtime).toBe(r.runtime);                  // ONE runtime: the executor's parts are the loops'
        expect(r.autoTrade._parts.cooldowns).toBe(r.runtime.cooldowns);
        expect(r.autoTrade._parts.idempotency).toBe(r.runtime.idempotency);
        expect(r.autoTrade._parts.traderFor).toBe(r.runtime.traderFor);
        expect(cap.lines.map((l) => l[1])).toContain('[AUTO-TRADE] enabled, exchanges=bybit');
      }
      if (wantLoops) {
        const info = cap.lines.filter((l) => l[0] === 'INFO').map((l) => l[1]);
        expect(info).toContain(`[TRADE-LOOPS] enabled (${wantExec ? 'with auto-trade' : 'protect only — no new placements'}), exchanges=bybit, wired: -`);
        // U2: no pass is ported yet → every loop entry is null (the scheduler skips it with one INFO line)
        for (const k of ['stateReconcile', 'tradeStateCleanup', 'anomalyDetector', 'slVerifier', 'orphanSweeper', 'beMonitorLoop']) expect(r.tradeLoops[k]).toBe(null);
      }
      if (r.runtime) await r.runtime.drain();
    }
    // the M13 entry point is unchanged
    expect(await EW.workerAutoTrade(bot, {})).toBe(null);
    expect((await EW.workerAutoTrade(bot, { AUTOTRADE_ENABLED: '1', AUTOTRADE_EXCHANGES: 'bingx' })).exchanges()).toEqual(['bingx']);
  });
});

describe('D24: ORPHAN_SWEEP_* with the bot\'s int() / strip() rules', () => {
  const SITE_RANGE = new Set(['99999999999999999999', '9007199254740992']);   // valid Python ints the site refuses (> 2^53 − 1)
  it(`the bot's import-time parse of ${FX.env_parse.length} env sets (orphan_sweeper reloaded per value)`, () => {
    const ORDER = S.ORPHAN_SWEEP_INT_ENV.map((r) => r[0]);
    let siteOnly = 0;
    for (const row of FX.env_parse) {
      const raws = ORDER.filter((n) => row.env[n] !== undefined).map((n) => row.env[n]);
      const outOfRange = raws.some((r) => SITE_RANGE.has(r));
      let got;
      try { got = { ok: true, cfg: S.orphanSweepConfig(row.env) }; } catch (e) { got = { ok: false, e }; }
      if (row.ok && outOfRange) {
        siteOnly += 1;
        expect(got.ok).toBe(false);
        expect(got.e.message).toMatch(/out of the range the site accepts/);
        continue;
      }
      expect({ env: row.env, ok: got.ok }).toEqual({ env: row.env, ok: row.ok });
      if (row.ok) {
        expect({ env: row.env, cfg: got.cfg }).toEqual({
          env: row.env,
          cfg: { intervalS: Number(row.interval_s), minOrderAgeS: Number(row.min_order_age_s), recentOpenS: Number(row.recent_open_s), enabled: row.enabled },
        });
      } else {
        const first = ORDER.find((n) => row.env[n] !== undefined && !(() => { try { S.orphanSweepConfig({ [n]: row.env[n] }); return true; } catch (_e) { return false; } })());
        expect(got.e.name).toBe('OrphanSweepEnvError');
        expect({ env: row.env, msg: got.e.message }).toEqual({ env: row.env, msg: `${first}=${pyStrRepr(row.env[first])}: ${row.msg}` });
      }
    }
    expect(siteOnly).toBe(6);                                        // 2 values × 3 names
    // the cases the plan names
    const ok = (raw) => FX.env_parse.find((r) => r.env.ORPHAN_SWEEP_INTERVAL_S === raw && Object.keys(r.env).length === 1);
    expect([ok(' 60 ').interval_s, ok('+5').interval_s, ok('1_000').interval_s, ok('\t42\n').interval_s]).toEqual(['60', '5', '1000', '42']);
    expect(ok('0x10').ok).toBe(false);
    expect(ok('').msg).toBe("invalid literal for int() with base 10: ''");
    expect(FX.env_parse.find((r) => r.env.ORPHAN_SWEEP_ENABLED === '0' && r.env.ORPHAN_SWEEP_INTERVAL_S === 'abc').ok).toBe(false);   // C-16
  });

  it('a malformed int keeps the whole trade runtime off (ERROR with the value), the sweeper disabled or not', async () => {
    const bot = { alertAdmins: async () => 0 };
    for (const extra of [{}, { ORPHAN_SWEEP_ENABLED: '0' }, { AUTOTRADE_ENABLED: '1' }]) {
      const env = { TRADE_LOOPS_ENABLED: '1', ORPHAN_SWEEP_INTERVAL_S: 'abc', ...extra };
      const [r, cap] = await withMdLog(() => EW.workerTradeRuntime(bot, env));
      expect([r.runtime, r.autoTrade, r.tradeLoops]).toEqual([null, null, null]);
      expect(cap.lines.filter((l) => l[0] === 'ERROR').map((l) => l[1])).toEqual([
        "[TRADE-RUNTIME] not started: ORPHAN_SWEEP_INTERVAL_S='abc': invalid literal for int() with base 10: 'abc' "
          + '(orphan_sweeper reads it with int() at start-up) — auto-trade and the trade loops stay off',
      ]);
    }
    expect(AT.tradeRuntimeEnvError({ ORPHAN_SWEEP_RECENT_OPEN_S: '1_200', ORPHAN_SWEEP_MIN_ORDER_AGE_S: ' +90 ' })).toBe(null);
    // with both switches unset nothing is parsed or built (the default deploy)
    const [r0, cap0] = await withMdLog(() => EW.workerTradeRuntime(bot, { ORPHAN_SWEEP_INTERVAL_S: 'abc' }));
    expect(r0.runtime).toBe(null);
    expect(cap0.lines).toEqual([]);
  });
});

describe('D5: the runtime reads keys of the AUTOTRADE_EXCHANGES set only', () => {
  it('getApiKeys / tdb.getUserWithKeys: an exchange outside the set is "no keys"', async () => {
    H.insertSiteUser(db, 7001);
    db.prepare('INSERT OR IGNORE INTO trader_settings (user_id) VALUES (?)').run(7001);
    H.insertSiteKey(db, 7001, 'bybit', 'BYKEY', 'BYSEC');
    H.insertSiteKey(db, 7001, 'bingx', 'BXKEY', 'BXSEC');
    const one = AT.createTradeRuntime({ env: { AUTOTRADE_EXCHANGES: 'bybit' }, log: capture().log });
    expect(one.getApiKeys({ user_id: 7001 }, 'bybit')).toEqual({ apiKey: 'BYKEY', apiSecret: 'BYSEC', passphrase: '' });
    expect(one.getApiKeys({ user_id: 7001 }, 'bingx')).toBe(null);
    const u1 = await one.tdb.getUserWithKeys(7001);
    expect([u1.bybit_api_key, u1.bingx_api_key, u1.bingx_api_secret]).toEqual(['BYKEY', '', '']);
    const both = AT.createTradeRuntime({ env: { AUTOTRADE_EXCHANGES: 'bybit,bingx' }, log: capture().log });
    expect(both.getApiKeys({ user_id: 7001 }, 'bingx')).toEqual({ apiKey: 'BXKEY', apiSecret: 'BXSEC', passphrase: '' });
    const u2 = await both.tdb.getUserWithKeys(7001);
    expect([u2.bybit_api_key, u2.bingx_api_key]).toEqual(['BYKEY', 'BXKEY']);
    // the sweeper's pre-filter reads the same rows (getAllUsersOrdered): bingx key '' with bybit only
    const rows = await one.tdb.getAllUsersOrdered();
    expect(rows.find((r) => r.user_id === 7001).bingx_api_key).toBe('');
  });
});

describe('C-8: protect only (loops without the executor)', () => {
  it('restore at start, the GC of the shared registries, the auth reset from main', async () => {
    let t = 1_800_000_000;
    db.prepare('INSERT OR REPLACE INTO engine_kv (key, value, updated_at) VALUES (?, ?, 0)').run('idemp_v1_live1', JSON.stringify({ status: 'done', ts: t - 30, order_id: 'O1' }));
    db.prepare('INSERT OR REPLACE INTO engine_kv (key, value, updated_at) VALUES (?, ?, 0)').run('zb_cooldown_7001_bybit', String(t + 600));
    const bot = { alertAdmins: async () => 0 };
    const [r, cap] = await withMdLog(() => EW.workerTradeRuntime(bot, { TRADE_LOOPS_ENABLED: '1' }, { runtimeDeps: { now: () => t } }));
    expect(r.autoTrade).toBe(null);
    expect(r.runtime.idempotency.registry.has('live1')).toBe(true);
    expect(r.runtime.cooldowns._zeroBalanceUntil.get('7001|bybit')).toBe(t + 600);
    expect(cap.lines.map((l) => l[1])).toContain('[IDEMPOTENCY-RESTORE] restored 1 active entries from kv');
    // the BE monitor's auth failure (scanner_mid → record_auth_failure) lands in the runtime's breaker
    await r.runtime.cooldowns.recordAuthFailure(7001, 'bybit', null, new Error('ErrCode: 10003 API key is invalid'));
    expect(r.runtime.cooldowns._authFailLog.has('7001|bybit')).toBe(true);
    // cache_gc without the executor: the runtime's table (and nothing of the executor's)
    t += 700;
    const gcCtx = {
      now: () => t, log: capture().log, smcInstance: () => null, scanners: { loadModule: () => null },
      confluence: () => ({ gcRecent: () => 0 }), balanceCache: () => ({ gcCache: () => 0 }), freeReport: () => ({ previewSent: new Map() }),
      tradeRuntime: r.runtime, tradeLoops: r.tradeLoops,
    };
    t += 600;   // the idempotency entry is 30 + 1300 s old by now (TTL 600 s)
    const freed = SCH.cacheGcOnce(gcCtx);
    expect(Object.keys(freed)).toEqual(['auto_trade._idempotency', 'auto_trade._auth_fail', 'auto_trade._zero_balance']);
    // main → engine reset_auth_failures reaches the runtime's breaker (runWorker.autoTradeControl)
    await r.runtime.cooldowns.recordAuthFailure(7001, 'bybit', null, new Error('ErrCode: 10003 API key is invalid'));
    const { MessageChannel } = req('worker_threads');
    const ch = new MessageChannel();
    const w = EW.runWorker(ch.port1, {
      logs: false,
      deps: { log: capture().log, cache: cacheStub, fetcher: {}, registry: { forceSave: () => 0, load: () => 0 }, exchangeSymbols: exSymbols, scanners: fakeScanners,
        autoTrade: null, tradeLoops: r.tradeLoops, tradeRuntime: r.runtime },
    });
    await w.start({ only: [] });
    expect(w.autoTradeControl({ type: 'autotrade', op: 'reset_auth_failures', userId: 7001, exchange: 'bybit' })).toBe(true);
    expect(r.runtime.cooldowns._authFailLog.has('7001|bybit')).toBe(false);
    await w.stop();
    ch.port1.close();
    ch.port2.close();
    await r.runtime.drain();
  });
});

describe('C-7: the BE monitor host', () => {
  const at = { executeAutoTrade: async () => ({}), getApiKeys: () => null, getBalance: async () => null, gc: {} };
  // every loop wired, so the C-7 rule (not [M15-LOOPS-REQUIRED]) is what drops the executor here
  const noop = async () => {};
  const ALL_PASSES = {
    beMonitorLoop: noop, reconcileOnce: noop, cleanupPass: noop, runOnce: noop,
    checkSingleTrade: noop, getOpenTradesAll: () => [], sweepOneUser: noop, getAllUsers: () => [],
  };
  it('no LEVELS scanner while the loops run → ERROR, the executor is not used by any scanner', () => {
    const cap = capture();
    const loops = createTradeLoops({}, { env: {}, log: cap.log, passes: ALL_PASSES });
    const s = SCH.createScheduler({ side: 'worker', deps: { scanners: fakeScanners, bot: {}, log: cap.log, autoTrade: at, tradeLoops: loops, only: [] } });
    expect(s.ctx.smcDeps.executeAutoTrade).toBe(at.executeAutoTrade);
    s.start();
    expect(cap.lines.filter((l) => l[0] === 'ERROR').map((l) => l[1])).toEqual([
      '[AUTO-TRADE] not started: the LEVELS scanner (the BE monitor host) is not built — open positions would have no BE monitor',
    ]);
    expect(s.ctx.autoTrade).toBe(null);
    expect(s.ctx.smcDeps.executeAutoTrade).toBe(undefined);
    expect(s.ctx.scannerDeps('VOLUME').executeAutoTrade).toBe(null);
  });

  it('a MidScanner whose constructor throws: the same', () => {
    const cap = capture();
    const loops = createTradeLoops({}, { env: {}, log: cap.log, passes: ALL_PASSES });
    class Boom { constructor() { throw new Error('ctor boom'); } }
    const scanners = { get: (n) => (n === 'MidScanner' ? Boom : null), loadModule: () => null, describe: () => ({}) };
    const s = SCH.createScheduler({ side: 'worker', deps: { scanners, bot: {}, log: cap.log, autoTrade: at, tradeLoops: loops, only: [] } });
    s.start();
    expect(cap.lines.filter((l) => l[0] === 'ERROR').map((l) => l[1])).toEqual([
      'MidScanner init failed: ctor boom',
      '[AUTO-TRADE] not started: the LEVELS scanner (the BE monitor host) is not built — open positions would have no BE monitor',
    ]);
    expect(s.ctx.autoTrade).toBe(null);
  });

  it('[M15-LOOPS-REQUIRED] the executor runs only with every trade loop wired; protect-only keeps the BE WARNING', () => {
    class Mid { constructor(c, b, u, se, deps) { this.deps = deps; } }
    const scanners = { get: (n) => (n === 'MidScanner' ? Mid : null), loadModule: () => null, describe: () => ({}) };
    const ALL5 = ['state_reconcile', 'trade_state_cleanup', 'anomaly_detector', 'sl_verifier', 'orphan_sweeper'];
    // nothing wired: the executor is dropped before the scanners are built (their deps capture it)
    const cap = capture();
    const s1 = SCH.createScheduler({ side: 'worker', deps: { scanners, bot: {}, log: cap.log, autoTrade: at, tradeLoops: createTradeLoops({}, { env: {}, passes: {} }), only: [] } });
    s1.start();
    expect(s1.ctx.autoTrade).toBe(null);
    expect(s1.ctx.levels.deps.executeAutoTrade).toBe(null);
    expect(cap.lines.map((l) => l.slice(0, 2))).toEqual([
      ['ERROR', `[AUTO-TRADE] not started: trade loops not wired (be_monitor, ${ALL5.join(', ')}) — open positions would have no BE monitor / reconcile`],
      ['WARNING', '[TRADE-LOOPS] BE monitor not wired (not ported yet) — open positions get no BU / trailing / close notice'],
    ]);
    // the BE monitor alone is not enough
    const be = async () => {};
    const loops = createTradeLoops({}, { env: {}, passes: { beMonitorLoop: be } });
    const cap2 = capture();
    const s2 = SCH.createScheduler({ side: 'worker', deps: { scanners, bot: {}, log: cap2.log, autoTrade: at, tradeLoops: loops, only: [] } });
    s2.start();
    expect(s2.ctx.autoTrade).toBe(null);
    expect(cap2.lines.map((l) => l.slice(0, 2))).toEqual([
      ['ERROR', `[AUTO-TRADE] not started: trade loops not wired (${ALL5.join(', ')}) — open positions would have no BE monitor / reconcile`],
    ]);
    expect(typeof s2.ctx.levels.deps.beMonitorLoop).toBe('function');
    expect(loops.wired()).toEqual(['be_monitor']);
    // every loop wired: the executor stays and the LEVELS deps carry both hooks
    const noop = async () => {};
    const full = createTradeLoops({}, { env: {}, passes: {
      beMonitorLoop: be, reconcileOnce: noop, cleanupPass: noop, runOnce: noop,
      checkSingleTrade: noop, getOpenTradesAll: () => [], sweepOneUser: noop, getAllUsers: () => [],
    } });
    expect(full.wired()).toEqual(['be_monitor', ...ALL5]);
    const cap4 = capture();
    const s4 = SCH.createScheduler({ side: 'worker', deps: { scanners, bot: {}, log: cap4.log, autoTrade: at, tradeLoops: full, only: [] } });
    s4.start();
    expect(s4.ctx.autoTrade).toBe(at);
    expect(cap4.lines).toEqual([]);
    expect(typeof s4.ctx.levels.deps.executeAutoTrade).toBe('function');
    // protect only (no executor): nothing is dropped, the BE gap stays a WARNING
    const cap5 = capture();
    const s5 = SCH.createScheduler({ side: 'worker', deps: { scanners, bot: {}, log: cap5.log, autoTrade: null, tradeLoops: createTradeLoops({}, { env: {}, passes: {} }), only: [] } });
    s5.start();
    expect(cap5.lines.map((l) => l.slice(0, 2))).toEqual([
      ['WARNING', '[TRADE-LOOPS] BE monitor not wired (not ported yet) — open positions get no BU / trailing / close notice'],
    ]);
    // without trade loops (the M13 wiring / the scheduler tests) nothing changes
    const cap3 = capture();
    const s3 = SCH.createScheduler({ side: 'worker', deps: { scanners: fakeScanners, bot: {}, log: cap3.log, autoTrade: at, only: [] } });
    s3.start();
    expect(s3.ctx.autoTrade).toBe(at);
    expect(cap3.lines).toEqual([]);
    expect(s3.tasks).toEqual([]);
  });

  it('the plan: TRADE_LOOP_TASKS in the bot gather order only with loops; an unwired loop is skipped with one INFO', () => {
    expect(SCH.ALL_TASKS.map((t) => t.name)).toEqual([
      'scanner', 'smc_coin_warmup', 'cache_gc', 'genome_maintenance', 'health_monitor', 'coin_quality', 'regime_loop', 'momentum_loop',
      'ghost_cleanup', 'state_reconcile', 'trade_state_cleanup', 'anomaly_detector', 'genome_evolution', 'candle_prefetch', 'sl_verifier',
      'ws_feed', 'cache_warmer', 'smc_scanner', 'volume_scanner', 'free_report', 'trend_monitor', 'orphan_sweeper', 'signal_tracker',
    ]);
    expect(SCH.TRADE_LOOP_TASKS.filter((t) => t.restart).map((t) => [t.name, t.baseDelay])).toEqual([['anomaly_detector', 10], ['sl_verifier', 10]]);
    const cap = capture();
    const loops = createTradeLoops({}, { env: {}, log: cap.log, passes: { reconcileOnce: async () => {} } });
    const ctrlSched = SCH.createScheduler({ side: 'worker', deps: { scanners: fakeScanners, bot: {}, log: cap.log, tradeLoops: loops, only: ['state_reconcile', 'trade_state_cleanup', 'anomaly_detector', 'sl_verifier', 'orphan_sweeper'] } });
    expect(ctrlSched.tasks).toEqual(['state_reconcile', 'trade_state_cleanup', 'anomaly_detector', 'sl_verifier', 'orphan_sweeper']);
    expect(ctrlSched.start()).toEqual(['state_reconcile']);
    expect(cap.lines.filter((l) => l[0] === 'INFO').map((l) => l[1])).toEqual([
      '[ENGINE] trade loop "trade_state_cleanup" not wired (its pass is not ported yet) — task not started',
      '[ENGINE] trade loop "anomaly_detector" not wired (its pass is not ported yet) — task not started',
      '[ENGINE] trade loop "sl_verifier" not wired (its pass is not ported yet) — task not started',
      '[ENGINE] trade loop "orphan_sweeper" not wired (its pass is not ported yet) — task not started',
    ]);
    return ctrlSched.stop();
  });
});

describe('the engine worker with the trade loops', () => {
  it('registry load before the start (its line after ready), heartbeat loops, loop logs to main, no ORPHAN heartbeat', async () => {
    const { MessageChannel } = req('worker_threads');
    const ch = new MessageChannel();
    const seen = [];
    ch.port2.on('message', (m) => seen.push(m));
    const order = [];
    const registry = {
      load() { order.push('load'); mdLog.log.info('FIX-AUDIT-26: signal_registry загружен (0 записей)'); return 0; },
      forceSave() { return 0; },
    };
    const passes = () => ({
      reconcileOnce: async () => { order.push('reconcile'); },
      getAllUsers: async () => [{ user_id: 1, trade_exchange: 'bybit', bybit_api_key: 'k' }],
      sweepOneUser: async () => ({ checked: 2, cancelled: 0, errors: 0 }),
    });
    const w = EW.runWorker(ch.port1, {
      logs: true,
      deps: {
        cache: cacheStub, fetcher: {}, registry, exchangeSymbols: exSymbols, scanners: fakeScanners, ...fastTimers,
        env: { TRADE_LOOPS_ENABLED: '1', AUTOTRADE_EXCHANGES: 'bybit' }, tradeLoopsDeps: { passes },
      },
    });
    await w.start({ only: ['state_reconcile', 'orphan_sweeper'] });
    const sched = w.scheduler();
    const hb = [];
    const realBeat = sched.ctx.health.heartbeat.bind(sched.ctx.health);
    sched.ctx.health.heartbeat = (name) => { hb.push(name); return realBeat(name); };
    expect(order[0]).toBe('load');
    await until(() => seen.some((m) => m.type === 'log' && /\[ORPHAN-SWEEP-CYCLE\]/.test(m.msg)));
    await until(() => order.includes('reconcile'));
    const types = seen.map((m) => m.type);
    const iHb = types.indexOf('heartbeat');
    const iReady = types.indexOf('ready');
    const iLoad = seen.findIndex((m) => m.type === 'log' && m.msg.startsWith('FIX-AUDIT-26'));
    expect(iHb < iReady && iReady < iLoad).toBe(true);
    const ready = seen[iReady];
    expect(ready.tasks).toEqual(['state_reconcile', 'orphan_sweeper']);
    const beat = seen[iHb];
    expect(Object.keys(beat.loops)).toEqual(['state_reconcile', 'trade_state_cleanup', 'anomaly_detector', 'sl_verifier', 'orphan_sweeper']);
    expect(beat.loops.state_reconcile).toEqual({ passes: 0, errors: 0, lastStart: null, lastEnd: null, last: null });
    const logs = seen.filter((m) => m.type === 'log').map((m) => m.msg);
    expect(logs).toContain('[AUDIT-FIX] State reconciliation loop started (interval=120s)');
    expect(logs).toContain('[ORPHAN-SWEEPER] started (interval=300s min_order_age=120s recent_open_window=300s)');
    expect(logs).toContain('[ORPHAN-SWEEP-START] cycle starting');
    expect(logs.some((m) => /^\[TRADE-LOOPS\] enabled \(protect only — no new placements\), exchanges=bybit, wired: state_reconcile, orphan_sweeper$/.test(m))).toBe(true);
    expect(sched.ctx.tradeLoops.stats().orphan_sweeper.passes).toBeGreaterThanOrEqual(1);
    expect(sched.ctx.tradeLoops.stats().orphan_sweeper.last).toEqual({ users: 1, orders_checked: 2, cancelled: 0, errors: 0 });
    expect(hb).not.toContain('ORPHAN');
    expect(seen.filter((m) => m.type === 'health').map((m) => m.name)).not.toContain('ORPHAN');
    await w.stop();
    mdLog.setLogger(null);
    ch.port1.close();
    ch.port2.close();
  });

  it('shutdown aborts an in-flight trader request of a loop pass at once: no further request, stopped < 4 s', async () => {
    const { MessageChannel } = req('worker_threads');
    const ch = new MessageChannel();
    const seen = [];
    ch.port2.on('message', (m) => seen.push(m));
    const requests = [];
    const hang = (rq) => { requests.push(rq && rq.url ? String(rq.url).replace(/\?.*$/, '') : String(rq)); return new Promise(() => {}); };
    const passes = (rt) => ({
      reconcileOnce: async () => {
        const h = rt.traderFor('bingx');
        await h.getPositions('KEY', 'SECRET');
        await h.getPositions('KEY', 'SECRET');
      },
    });
    const cap = capture();
    const w = EW.runWorker(ch.port1, {
      logs: false,
      deps: {
        log: cap.log, cache: cacheStub, fetcher: {}, registry: { forceSave: () => 0, load: () => 0 }, exchangeSymbols: exSymbols, scanners: fakeScanners,
        ...fastTimers, env: { TRADE_LOOPS_ENABLED: '1', AUTOTRADE_EXCHANGES: 'bingx' },
        tradeRuntimeDeps: { traderRuntime: { transport: hang } }, tradeLoopsDeps: { passes },
      },
    });
    await w.start({ only: ['state_reconcile'] });
    await until(() => requests.length === 1);
    const t0 = Date.now();
    const res = await w.stop();
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(res.pending).toBe(0);
    await new Promise((r) => setTimeout(r, 100));
    expect(requests.length).toBe(1);
    expect(requests[0]).toMatch(/\/openApi\/swap\/v2\/user\/positions$/);
    expect(cap.lines.map((l) => l[1])).toContain('[AUDIT-FIX] State reconciliation loop stopped.');   // cancelled inside the pass
    expect(seen.some((m) => m.type === 'stopped')).toBe(true);
    ch.port1.close();
    ch.port2.close();
  });

  it('a stray rejection in a loop pass does not end the thread (the engine worker\'s handlers); without them it does', async () => {
    const { Worker } = req('worker_threads');
    const file = path.join(path.dirname(new URL(import.meta.url).pathname), 'strayWorker.js');
    const runIt = (handlers) => new Promise((resolve) => {
      const w = new Worker(file, { workerData: { handlers }, env: { ...process.env, MARKET_LOG_LEVEL: 'silent' } });
      const msgs = [];
      let error = null;
      w.on('message', (m) => msgs.push(m));
      w.on('error', (e) => { error = e; });
      w.on('exit', (code) => resolve({ code, msgs, error }));
    });
    const ok = await runIt(true);
    expect(ok.code).toBe(0);
    expect(ok.error).toBe(null);
    expect(ok.msgs.filter((m) => m.type === 'pass').map((m) => m.n)).toEqual([1, 2, 3]);
    const logs = ok.msgs.filter((m) => m.type === 'log').map((m) => [m.level, m.msg]);
    expect(logs).toContainEqual(['error', 'Task exception was never retrieved']);
    expect(logs).toContainEqual(['info', '[AUDIT-FIX] State reconciliation loop stopped.']);
    expect(ok.msgs[ok.msgs.length - 1]).toEqual({ type: 'loop-done' });
    const bad = await runIt(false);
    expect(bad.code).not.toBe(0);
    expect(bad.error && bad.error.message).toBe('stray rejection in a loop pass');
    expect(bad.msgs.filter((m) => m.type === 'pass').map((m) => m.n)).toEqual([1]);
  }, 30_000);
});

describe('loop shells: JS-side rules', () => {
  const mkCtx = (clk, signal) => ({ signal, sleep: SCH.makeSleep(signal, { setTimer: (fn, ms) => clk.timers.setTimeout(fn, ms), clearTimer: (h) => clk.timers.clearTimeout(h) }), now: () => clk.now() });

  it('C-5: an abort while the pass awaits a NON-cancellable call → the stopped line when it returns, nothing after it', async () => {
    const clk = H.createVClock(1767225600.0);
    const ctrl = new AbortController();
    const cap = capture();
    const ctx = { ...mkCtx(clk, ctrl.signal), log: cap.log };
    const after = [];
    let passes = 0;
    const reconcileOnce = async () => {
      passes += 1;
      await new Promise((r) => clk.timers.setTimeout(r, 5000));   // e.g. a delivery RPC: not a cancellation point on the site
      after.push('pass returned');
    };
    const p = S.runStateReconciliation(cap.log, () => S.stateReconciliationLoop(ctx, { reconcileOnce }));
    clk.timers.setTimeout(() => ctrl.abort(), 62_000);              // 2 s into the first pass (60 s first delay)
    await clk.runUntil(1000 + 400);
    await p;
    expect(passes).toBe(1);
    expect(after).toEqual(['pass returned']);
    expect(cap.lines.map((l) => l[1])).toEqual(['[AUDIT-FIX] State reconciliation loop started (interval=120s)', '[AUDIT-FIX] State reconciliation loop stopped.']);
  });

  it('C-15: a TimeoutError raised inside a pass is an ordinary error (the loop goes on), never a cancellation', async () => {
    const clk = H.createVClock(1767225600.0);
    const ctrl = new AbortController();
    const cap = capture();
    const ctx = { ...mkCtx(clk, ctrl.signal), log: cap.log };
    let n = 0;
    const p = S.runStateReconciliation(cap.log, () => S.stateReconciliationLoop(ctx, {
      reconcileOnce: async () => {
        n += 1;
        if (n === 1) await asyncio.waitFor(() => asyncio.guardCancel(new Promise(() => {})), 1, { timers: clk.timers });   // an inner wait_for(…, 1) timing out
      },
    }));
    await clk.runUntil(1000 + 400);                                 // passes at 60 (+1 s timeout), 181, 301
    ctrl.abort();
    await p;
    expect(n).toBe(3);
    expect(cap.lines.map((l) => l.slice(0, 2))).toEqual([
      ['INFO', '[AUDIT-FIX] State reconciliation loop started (interval=120s)'],
      ['ERROR', '[AUDIT-FIX] reconciliation error: '],
    ]);
    expect(typeof cap.lines[1][2]).toBe('string');                  // exc_info (the stack)
  });

  it('sleeps past the Node timer limit (2^31 − 1 ms) are chunked: ORPHAN_SWEEP_INTERVAL_S=3000000 waits 34.7 days', async () => {
    const clk = H.createVClock(1767225600.0);
    const ctrl = new AbortController();
    const cap = capture();
    const ctx = { ...mkCtx(clk, ctrl.signal), log: cap.log };
    const cycles = [];
    const p = S.orphanSweeperLoop(ctx, {
      config: S.orphanSweepConfig({ ORPHAN_SWEEP_INTERVAL_S: '3000000' }),
      getAllUsers: async () => { cycles.push(clk.mono() - 1000); return []; },
      sweepOneUser: async () => ({ checked: 0, cancelled: 0, errors: 0 }),
    });
    await clk.runUntil(1000 + 3_000_200);
    ctrl.abort();
    await p;
    expect(cycles).toEqual([120, 3_000_120]);
  });

  it('the LEVELS BE hook: restoreHintThrottle is handed to the wired BE monitor (one try with the cooldown restore); unwired restores alone', async () => {
    const LV = req('../../../services/engine/levelsScanner.js');
    LV._resetModuleStateForTests();
    const t = 1_800_000_000;
    const kv = { get: async (k) => (k === LV.KV_HINT_LAST_TS ? JSON.stringify({ 42: t - 10 }) : null), set: async () => true };
    const mk = (deps) => {
      const sc = Object.create(LV.MidScanner.prototype);
      sc.deps = deps;
      sc.log = capture().log;
      sc._now = () => t;
      return sc;
    };
    const calls = [];
    const wired = mk({ kv, beMonitorLoop: async (scanner, hooks) => { calls.push([scanner, Object.keys(hooks), LV._userHintLastTs.size]); calls.push(await hooks.restoreHintThrottle()); } });
    await wired._beMonitorLoop();
    expect(calls[0][0]).toBe(wired);
    expect(calls[0][1]).toEqual(['restoreHintThrottle']);
    expect(calls[0][2]).toBe(0);                                    // the scanner did not restore by itself
    expect(calls[1]).toBe(1);
    expect(LV._userHintLastTs.get(42)).toBe(t - 10);
    LV._resetModuleStateForTests();
    await mk({ kv, beMonitorLoop: null })._beMonitorLoop();         // unwired: the throttle restore alone (unchanged)
    expect(LV._userHintLastTs.get(42)).toBe(t - 10);
    LV._resetModuleStateForTests();
  });

  it('a pass hook throws synchronously in the facade → the bot\'s except branch, the loop goes on (stats count it)', async () => {
    const clk = H.createVClock(1767225600.0);
    const ctrl = new AbortController();
    const cap = capture();
    let n = 0;
    const loops = createTradeLoops({}, { env: {}, now: () => clk.now(), log: cap.log, passes: { reconcileOnce: () => { n += 1; if (n === 1) throw new Error('sync boom'); return Promise.resolve(); } } });
    const ctx = { ...mkCtx(clk, ctrl.signal), log: cap.log };
    const p = loops.stateReconcile(ctx);
    await clk.runUntil(1000 + 200);
    ctrl.abort();
    await p;
    expect(cap.lines.filter((l) => l[0] === 'ERROR').map((l) => l[1])).toEqual(['[AUDIT-FIX] reconciliation error: sync boom']);
    expect(loops.stats().state_reconcile).toMatchObject({ passes: 1, errors: 1 });
    await turn();
  });
});
