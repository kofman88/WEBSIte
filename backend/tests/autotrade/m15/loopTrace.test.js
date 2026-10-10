/**
 * PLAN_M15 U2 — the trade-ops loop shells and the [BE-SINGLE-LOOP] host against the bot's REAL loop code
 * (fixtures/m15_loop_trace.json.gz, py/gen_m15_loop_trace.py: bot.py's _guarded / _guarded_restart and the
 * swallowing wrappers ast-extracted, auto_trade / trade_anomaly_detector / sl_verifier / orphan_sweeper loop
 * functions and scanner_mid.MidScanner.run_forever as they are, the single passes stubbed to record their
 * instants; CPython 3.11 on the m15_harness virtual clock).
 *
 * The JS side runs the same scripts on the vclock through the site code:
 *   main         services/engine/scheduler.js (the TRADE_LOOP_TASKS rows, RUNNERS, guarded / guardedRestart,
 *                the named task) over services/autotrade/tradeLoops.js + loopShells.js — 6 h of virtual time,
 *                then scheduler.stop() (the bot's shutdown cancel)
 *   cancels      one abort per loop at the bot's anchored instant (in a pass, in the gather, in a sleep, in the
 *                0.3 s pause, in the back-off …): the stopped lines exactly where the bot prints them (C-9)
 *   sweeper_env  ORPHAN_SWEEP_ENABLED 0 / " 0 " / Unicode spaces / false, ORPHAN_SWEEP_INTERVAL_S=60
 *   wrappers     the loop itself raising: the wrappers' crash lines, no 💀 / restart for the swallowed three
 *                (INF-Q-I3), restart + backoff for the verifier row, 💀 without restart for the sweeper row
 *   be           levelsScanner MidScanner.runForever under the scheduler's guardedRestart: one BE loop per
 *                instance across LEVELS restarts, restart of a crashed / finished one, the reused one aborted
 *                at shutdown
 * Compared per task: every stub call (instant, call number, arguments), every log line (instant, level,
 * text, exc_info), the cancel instants, the final task state and the admin alerts.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);
const H = req('./harness.js');
const asyncio = req('../../../services/autotrade/asyncio.js');
const S = req('../../../services/autotrade/loopShells.js');
const { createTradeLoops, LOOP_NAMES } = req('../../../services/autotrade/tradeLoops.js');
const SCH = req('../../../services/engine/scheduler.js');
const { PyError } = req('../../../services/exchanges/pyCompat.js');

const FX = H.loadFixture('m15_loop_trace');
const WALL0 = FX.wall0;
const MONO0 = FX.mono0;
const ROW = Object.fromEntries(SCH.TRADE_LOOP_TASKS.map((r) => [r.name, r]));
const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

class Script {
  constructor(spec = {}) { this.default = spec.default || {}; this.calls = spec.calls || {}; this.n = 0; }
  next() { this.n += 1; return { ...this.default, ...(this.calls[String(this.n)] || {}) }; }
}

/** The vclock world of one scenario: stubs, anchors, recorders (the JS twin of gen_m15_loop_trace's). */
function makeWorld(spec, { recordMetrics = true } = {}) {
  const clk = H.createVClock(WALL0, MONO0);
  const sleepV = H.vclockSleep(clk);
  const rel = () => clk.now() - WALL0;
  const task = () => asyncio.currentTaskName();
  const events = [];
  const cancels = [];
  const alerts = [];
  const logs = [];
  const controllers = {};
  const calln = {};
  const ev = (fn, ...args) => events.push([rel(), task(), fn, clone(args)]);
  const call = (fn) => { calln[fn] = (calln[fn] || 0) + 1; return calln[fn]; };
  const abortTask = (name) => { cancels.push([rel(), name]); controllers[name].abort(); };
  const anchors = (spec.cancels || []).filter((a) => a.fn !== undefined);
  const anchor = (fn, n, when) => {
    for (const a of anchors) {
      if (a.fn === fn && a.call === n && (a.when || 'start') === when) clk.timers.setTimeout(() => abortTask(a.task), a.offset * 1000);
    }
  };
  const behave = async (b) => {
    if (b.dur) await sleepV(b.dur);
    if (b.raise) throw H.mkErr({ type: b.raise[0], msg: b.raise[1] });
  };
  const mk = (level) => (msg, extra) => logs.push([rel(), task(), level, String(msg), extra !== undefined && extra !== null]);
  const log = { debug: mk('DEBUG'), info: mk('INFO'), warning: mk('WARNING'), warn: mk('WARNING'), error: mk('ERROR'), critical: mk('CRITICAL') };
  const bot = { alertAdmins: async (text) => { alerts.push([rel(), task(), 123, text]); return 1; } };
  const sc = spec.scripts || {};
  const SC = {
    reconcile: new Script(sc.reconcile), cleanup: new Script(sc.cleanup), detector: new Script(sc.detector),
    open_trades: new Script(sc.open_trades), users: new Script(sc.users),
  };
  const checks = sc.checks || {};
  const sweeps = sc.sweeps || {};
  const stubbed = (fn, script, body) => async (...a) => {
    const n = call(fn);
    const pre = body.pre(n, ...a);
    anchor(fn, n, 'start');
    const b = script ? script.next() : body.behaviour(...a);
    try {
      await behave(b);
    } finally {
      if (body.post) body.post(n, ...a);
      anchor(fn, n, 'end');
    }
    void pre;
    return body.ret(b);
  };
  const passes = {
    reconcileOnce: stubbed('reconcile', SC.reconcile, { pre: (n) => ev('reconcile', n), ret: () => undefined }),
    cleanupPass: stubbed('cleanup', SC.cleanup, { pre: (n, maxAge) => ev('cleanup', n, maxAge), ret: (b) => clone(b.ret === undefined ? [] : b.ret) }),
    runOnce: stubbed('detector', SC.detector, { pre: (n) => ev('detector', n), ret: (b) => clone(b.stats) }),
    getOpenTradesAll: stubbed('open_trades', SC.open_trades, { pre: (n) => ev('open_trades', n), ret: (b) => clone(b.trades === undefined ? [] : b.trades) }),
    checkSingleTrade: stubbed('check', null, {
      pre: (n, tr) => ev('check', n, tr.trade_id), behaviour: (tr) => ({ ...(checks[tr.trade_id] || {}) }),
      post: (n, tr) => ev('check_end', n, tr.trade_id), ret: () => undefined,
    }),
    getAllUsers: stubbed('users', SC.users, { pre: (n) => ev('users', n), ret: (b) => clone(b.users === undefined ? [] : b.users) }),
    sweepOneUser: stubbed('sweep', null, {
      pre: (n, row) => ev('sweep', n, row.user_id),
      behaviour: (row) => ({ ...(sweeps[String(row.user_id)] || sweeps.default || {}) }),
      post: (n, row) => ev('sweep_end', n, row.user_id), ret: (b) => clone(b.ret),
    }),
  };
  if (recordMetrics) passes.recordMetrics = S.recordMetricsOf(async (name, value) => ev('metrics', name, value), log);
  const outcome = {};
  /** Python's task state: 'cancelled' when CancelledError left the wrapper (the last run ended by it), else 'done'. */
  const tracked = (name, fn) => (ctx) => fn(ctx).then(
    (v) => { outcome[name] = 'done'; return v; },
    (e) => { outcome[name] = asyncio.isCancelledError(e) ? 'cancelled' : 'done'; throw e; },
  );
  const timers = { setTimer: (fn, ms) => clk.timers.setTimeout(fn, ms), clearTimer: (h) => clk.timers.clearTimeout(h) };
  const ctxFor = (name) => {
    const ctrl = new AbortController();
    controllers[name] = ctrl;
    return { signal: ctrl.signal, sleep: SCH.makeSleep(ctrl.signal, timers), log, now: () => clk.now(), mono: () => clk.mono() * 1000, bot };
  };
  return { clk, sleepV, rel, ev, events, cancels, alerts, logs, controllers, passes, log, bot, outcome, tracked, ctxFor, timers, abortTask };
}

const KEY = { state_reconcile: 'stateReconcile', trade_state_cleanup: 'tradeStateCleanup', anomaly_detector: 'anomalyDetector', sl_verifier: 'slVerifier', orphan_sweeper: 'orphanSweeper' };

function facadeOf(w, env, extra = {}) {
  const f = createTradeLoops({}, { env, now: () => w.clk.now(), log: w.log, passes: { ...w.passes, ...extra } });
  const out = { ...f };
  for (const name of LOOP_NAMES) if (f[KEY[name]]) out[KEY[name]] = w.tracked(name, f[KEY[name]]);
  return out;
}

/** Direct wiring: each loop with its own AbortController (the bot cancels one task), the scheduler's wrapper of its row. */
async function runDirect(spec, facade, w) {
  const promises = [];
  for (const name of spec.loops) {
    const row = ROW[name];
    const ctx = w.ctxFor(name);
    const run = () => facade[row.loop](ctx);
    promises.push(asyncio.runAsTask(name, () => (row.restart
      ? SCH.guardedRestart(name, run, ctx, { baseDelay: row.baseDelay })
      : SCH.guarded(name, run, ctx))));
  }
  for (const a of spec.cancels || []) if (a.at !== undefined) w.clk.timers.setTimeout(() => w.abortTask(a.task), a.at * 1000);
  await w.clk.runUntil(MONO0 + spec.horizon);
  const finalCancel = w.rel();
  for (const name of spec.loops) if (!w.controllers[name].signal.aborted) w.controllers[name].abort();
  await Promise.all(promises);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  return finalCancel;
}

/** The main scenario through the real scheduler (TRADE_LOOP_TASKS rows, RUNNERS, one AbortSignal, stop()). */
async function runScheduler(spec, facade, w) {
  const sched = SCH.createScheduler({
    side: 'worker',
    deps: {
      log: w.log, env: {}, now: () => w.clk.now(), mono: () => w.clk.mono() * 1000, ...w.timers, bot: w.bot,
      scanners: { get: () => null, loadModule: () => null, describe: () => ({}) },
      tradeLoops: facade, only: LOOP_NAMES, registry: { forceSave: () => 0 },
    },
  });
  const started = sched.start();
  await w.clk.runUntil(MONO0 + spec.horizon);
  const finalCancel = w.rel();
  const res = await sched.stop();
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  return { started, finalCancel, res, sched };
}

const byTask = (rows, name, f = (r) => r) => rows.filter((r) => r[1] === name).map(f);
const pyLogs = (rows) => rows.map(([t, task, level, msg, exc]) => [t, task, level, msg, exc !== null]);

/**
 * Rows of one task. The SL verifier's gather children are concurrent: when two checks end at the same virtual
 * instant the bot runs both timer callbacks in one loop iteration and the woken semaphore waiters in the next,
 * the vclock fires one timer per turn and lets the woken check run before the second timer — same instants,
 * same slots in FIFO order (the `check` call numbers are the start order), a different interleaving WITHIN
 * the instant (README: microtask vs loop iteration). Its rows are compared in canonical order per instant.
 */
const CONCURRENT = new Set(['sl_verifier']);
const canon = (rows) => rows.slice().sort((a, b) => a[0] - b[0] || (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
const rowsOf = (rows, name) => (CONCURRENT.has(name) ? canon(byTask(rows, name)) : byTask(rows, name));

function compare(py, w, loops) {
  for (const name of loops) {
    expect({ name, events: rowsOf(w.events, name) }).toEqual({ name, events: rowsOf(py.events, name) });
    expect({ name, logs: rowsOf(w.logs, name) }).toEqual({ name, logs: rowsOf(pyLogs(py.logs), name) });
    if (CONCURRENT.has(name)) {
      // the start order of the checks (= who got which slot) is exact
      const starts = (rows) => byTask(rows, name).filter((e) => e[2] === 'check').map((e) => [e[0], ...e[3]]);
      expect(starts(w.events)).toEqual(starts(py.events));
    }
  }
  expect(w.cancels).toEqual(py.cancels);
  expect(w.alerts).toEqual(py.alerts.map(([t, task, uid, text]) => [t, task, uid, text]));
}

describe('M15 U2 loop shells vs the bot (m15_loop_trace.json.gz)', () => {
  it('the fixture: CPython 3.11, bot HEAD 1a47ffc, the five loops and the five bot.py wrappers', () => {
    expect(FX.python).toMatch(/^3\.11\./);
    expect(FX.bot_head).toBe('1a47ffc');
    expect(Object.keys(FX.sources_sha).sort()).toEqual(['_guarded', '_guarded_restart', '_run_anomaly_detector', '_run_state_reconciliation', '_run_trade_state_cleanup']);
    expect(Object.keys(FX.loops_sha).sort()).toEqual(['_record_metrics', 'orphan_sweeper_loop', 'run_detector_loop', 'run_forever', 'sl_verifier_loop', 'state_reconciliation_loop', 'trade_state_cleanup_loop']);
  });

  describe('main: 6 h through the scheduler, then the shutdown cancel', () => {
    const py = FX.main;
    let w;
    let r;
    beforeAll(async () => {
      w = makeWorld(py.spec);
      r = await runScheduler(py.spec, facadeOf(w, {}), w);
    }, 120_000);

    it('the scheduler starts the five rows in the bot gather order', () => {
      expect(r.started).toEqual(['state_reconcile', 'trade_state_cleanup', 'anomaly_detector', 'sl_verifier', 'orphan_sweeper']);
      expect(r.res.pending).toBe(0);
      expect(r.finalCancel).toBe(py.final_cancel);
    });

    it('the trace covers the cases (sanity of the fixture)', () => {
      const msgs = py.logs.map((l) => l[3]);
      for (const re of [/reconciliation error: reconcile boom/, /reconciliation error: $/, /\[STATE-CLEANUP\] pass failed/, /^\[ANOMALY\] pass failed: detector boom/,
        /^sl_verifier_loop: db gone/, /^sl_verify trade: bad sl/, /cannot load users/, /iteration error: 'NoneType' object has no attribute 'get'/,
        /sweep: 'cancelled'/, /unsupported operand type\(s\) for \+=: 'int' and 'str'/, /'NoneType' object is not subscriptable/,
        /^\[ORPHAN-SWEEPER\] cancelled — shutdown$/]) {
        expect(msgs.some((m) => re.test(m)), String(re)).toBe(true);
      }
      expect(py.logs.filter((l) => l[2] === 'WARNING' && l[3].startsWith('[ANOMALY] pass took')).length).toBe(2);
      expect(py.events.filter((e) => e[2] === 'detector').length).toBeGreaterThan(700);
    });

    it('every stub call per task at the same instant with the same arguments; same log lines; no alert', () => {
      compare(py, w, LOOP_NAMES);
      expect(py.alerts).toEqual([]);
    });

    it('the final task states (a cancel in a sleep outside the try ends the task cancelled, silently)', () => {
      expect(w.outcome).toEqual(py.task_states);
    });

    it('the verifier hands Semaphore(5) slots over in the bot order (≤ 5 checks at once)', () => {
      let live = 0;
      let peak = 0;
      for (const e of byTask(w.events, 'sl_verifier')) {
        if (e[2] === 'check') { live += 1; peak = Math.max(peak, live); }
        if (e[2] === 'check_end') live -= 1;
      }
      expect(peak).toBe(5);
    });
  });

  describe('cancels: the stopped line only where the bot is inside its try (C-9)', () => {
    for (const py of FX.cancels) {
      it(py.spec.name, async () => {
        const w = makeWorld(py.spec);
        const fin = await runDirect(py.spec, facadeOf(w, {}), w);
        expect(fin).toBe(py.final_cancel);
        compare(py, w, py.spec.loops);
        expect(w.outcome).toEqual(py.task_states);
      });
    }

    it('which cancel printed a line (pinned)', () => {
      const lines = (name) => FX.cancels.find((c) => c.spec.name === name).logs
        .filter((l) => /stopped|cancelled — shutdown/.test(l[3])).map((l) => l[1]);
      expect(lines('cancel_in_pass').sort()).toEqual(['anomaly_detector', 'orphan_sweeper', 'sl_verifier', 'state_reconcile', 'trade_state_cleanup']);
      expect(lines('cancel_in_sleep')).toEqual(['orphan_sweeper']);              // the sweeper's interval sleep is inside its try
      expect(lines('cancel_special').sort()).toEqual(['orphan_sweeper', 'sl_verifier']);   // 0.3 s pause; "no open trades" sleep
      expect(lines('cancel_backoff')).toEqual([]);                               // first delay; the 3600 s back-off
      expect(lines('cancel_warmup')).toEqual([]);
    });
  });

  describe('sweeper env (import-time ORPHAN_SWEEP_*)', () => {
    for (const py of FX.sweeper_env) {
      it(`${py.spec.name} ${JSON.stringify(py.env)}`, async () => {
        const w = makeWorld(py.spec);
        await runDirect(py.spec, facadeOf(w, py.env), w);
        compare(py, w, ['orphan_sweeper']);
        expect(w.outcome).toEqual(py.task_states);
      });
    }
  });

  describe('wrappers: the loop function itself raising', () => {
    const py = FX.wrappers;
    it('reconcile / cleanup / detector: one crash line, a clean return (no 💀, no restart); verifier: restart + backoff; sweeper: 💀, no restart', async () => {
      const w = makeWorld(py.spec);
      const raising = (label, after, times = null) => {
        let n = 0;
        return (ctx) => asyncio.runInScope(ctx.signal, async () => {
          n += 1;
          w.ev('loop_start', label, n);
          if (times !== null && n > times) { await w.sleepV(1e6); return; }
          await w.sleepV(after);
          w.ev('loop_raise', label, n);
          throw new PyError('RuntimeError', `${label} exploded <#${n}>`);
        });
      };
      const rec = raising('reconcile', 5.0);
      const cln = raising('cleanup', 7.0);
      const det = raising('detector', 9.0);
      const ver = raising('verifier', 11.0, 2);
      const swp = raising('sweeper', 13.0);
      const facade = {
        stateReconcile: w.tracked('state_reconcile', (ctx) => S.runStateReconciliation(ctx.log, () => rec(ctx))),
        tradeStateCleanup: w.tracked('trade_state_cleanup', (ctx) => S.runTradeStateCleanup(ctx.log, () => cln(ctx))),
        anomalyDetector: w.tracked('anomaly_detector', (ctx) => S.runAnomalyDetector(ctx.log, () => det(ctx))),
        slVerifier: w.tracked('sl_verifier', (ctx) => ver(ctx)),
        orphanSweeper: w.tracked('orphan_sweeper', (ctx) => swp(ctx)),
        gcAnomaly: () => ({}), stats: () => ({}),
      };
      const r = await runScheduler(py.spec, facade, w);
      expect(r.started).toEqual(LOOP_NAMES);
      compare(py, w, LOOP_NAMES);
      expect(w.outcome).toEqual(py.task_states);
      expect(py.alerts.map((a) => a[1])).toEqual(['sl_verifier', 'orphan_sweeper', 'sl_verifier']);
    });
  });

  describe('[BE-SINGLE-LOOP 2026-10]: one BE monitor per LEVELS scanner across restarts', () => {
    const { MidScanner } = req('../../../services/engine/levelsScanner.js');
    for (const py of FX.be) {
      it(py.spec.name, async () => {
        const w = makeWorld({});
        const spec = py.spec;
        const st = { scanCalls: 0, subCalls: 0, beStarts: 0, beLive: 0 };
        const loops = {
          async scan() {
            st.scanCalls += 1;
            const n = st.scanCalls;
            w.ev('scan.start', n);
            const crash = spec.scan_crash[String(n)];
            if (crash !== undefined) {
              await w.sleepV(crash);
              w.ev('scan.crash', n);
              throw new PyError('RuntimeError', `scan crash #${n}`);
            }
            await w.sleepV(1e6);
          },
          async sub() { st.subCalls += 1; w.ev('sub.start', st.subCalls); await w.sleepV(1e6); },
          async be() {
            st.beStarts += 1;
            const n = st.beStarts;
            st.beLive += 1;
            w.ev('be.start', n, st.beLive);
            try {
              const b = spec.be[String(n)];
              if (b) {
                await w.sleepV(b.after);
                if (b.what === 'crash') { w.ev('be.crash', n); throw new PyError('RuntimeError', `be crash #${n}`); }
                w.ev('be.return', n);
                return;
              }
              await w.sleepV(1e6);
            } catch (e) {
              if (asyncio.isCancelledError(e)) w.ev('be.cancelled', n);
              throw e;
            } finally {
              st.beLive -= 1;
            }
          },
        };
        // MidScanner.__new__ + the scripted loops (the g5 test pattern)
        const sc = Object.create(MidScanner.prototype);
        sc.log = w.log;
        sc.cfg = { SCAN_WORKERS: 10, API_CONCURRENCY: 12 };
        sc.deps = { wsFeed: { registerOnBarClose() {} } };
        sc._onWsBarCloseCb = () => {};
        sc._warmupCache = async () => {};
        sc._scanLoop = () => loops.scan();
        sc._subCheckLoop = () => loops.sub();
        sc._beMonitorLoop = () => loops.be();
        const ctx = w.ctxFor('scanner');
        const sup = asyncio.runInScope(ctx.signal, () => asyncio.runAsTask('scanner',
          () => SCH.guardedRestart('scanner', () => sc.runForever(), ctx, { baseDelay: 10 })));
        await w.clk.runUntil(MONO0 + spec.horizon);
        w.ev('cancel');
        w.controllers.scanner.abort();
        await sup.catch(() => {});
        for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
        expect(w.events).toEqual(py.events);
        expect(w.logs.filter((l) => l[2] !== 'DEBUG').map(([t, , level, msg, exc]) => [t, level, msg, exc]))
          .toEqual(py.logs.map(([t, level, msg, exc]) => [t, level, msg, exc !== null]));
        expect(w.alerts.map(([t, , uid, text]) => [t, uid, text])).toEqual(py.alerts);
        expect([st.beStarts, st.beLive, st.scanCalls]).toEqual([py.be_starts, py.be_live_after, py.scan_calls]);
      });
    }

    it('pinned: two LEVELS crashes reuse the live BE loop (1 start, 2 [BE-SINGLE-LOOP] lines); start order scan → sub → BE', () => {
      const lc = FX.be.find((b) => b.spec.name === 'levels_crashes');
      expect(lc.be_starts).toBe(1);
      expect(lc.logs.filter((l) => l[2].startsWith('[BE-SINGLE-LOOP]')).length).toBe(3);
      expect(lc.events.slice(0, 3).map((e) => e[2])).toEqual(['scan.start', 'sub.start', 'be.start']);
      expect(FX.be.find((b) => b.spec.name === 'be_crash_then_levels').be_starts).toBe(2);
      expect(FX.be.every((b) => b.be_live_after === 0)).toBe(true);
    });
  });
});
