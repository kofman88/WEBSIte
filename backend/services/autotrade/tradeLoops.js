'use strict';
/**
 * tradeLoops.js — the scheduler-facing facade of the M15 trade-ops loops (PLAN_M15 §1.2, D21): the five loop
 * shells of loopShells.js bound to their single passes on ONE trade runtime (services/autotrade/index.js
 * createTradeRuntime — the executor, when built, shares it), the BE monitor host hook and the heartbeat counters.
 *
 *   createTradeLoops(runtime, { env, orphanSweep, passes, log, now }) → {
 *     stateReconcile(ctx)      bot.py _run_state_reconciliation() over state_reconciliation_loop()
 *     tradeStateCleanup(ctx)   _run_trade_state_cleanup() over trade_state_cleanup_loop()
 *     anomalyDetector(ctx)     _run_anomaly_detector() over run_detector_loop(bot)
 *     slVerifier(ctx)          sl_verifier_loop(bot, um)        (no swallowing wrapper in the bot)
 *     orphanSweeper(ctx)       orphan_sweeper_loop(bot)         (no swallowing wrapper in the bot)
 *     beMonitorLoop(scanner, hooks)   MidScanner._be_monitor_loop — the LEVELS scanner's hook (U7)
 *     gcAnomaly(now)           cache_gc's trade_anomaly_detector block → {key: freed} (U5)
 *     stats()                  {loop: {passes, errors, lastStart, lastEnd, last}} for the engine heartbeat
 *     wired()                  the names of the loops whose passes exist
 *     orphanSweep              the parsed ORPHAN_SWEEP_* config (D24)
 *   }
 *   Each loop entry is `null` while its pass is not ported (U3-U10): the scheduler skips such a task with one
 *   INFO line — nothing pretends to protect a position. `passes` (an object, or runtime → object; tests and
 *   the later units) supplies them:
 *     reconcileOnce()               _reconcile_once                      (U3)
 *     cleanupPass(maxAgeS)          the trade_state_cleanup_loop try body (U3)
 *     runOnce()                     trade_anomaly_detector._run_once      (U5)
 *     recordMetrics(stats)          _record_metrics (default: the D23 no-op metrics → these counters)
 *     getOpenTradesAll()            db_get_open_trades_all               (U1, runtime.tdb)
 *     checkSingleTrade(trade)       sl_verifier._check_single_trade        (U4)
 *     getAllUsers()                 db_get_all_users                      (U1, runtime.tdb)
 *     sweepOneUser(row)             orphan_sweeper._sweep_one_user         (U6)
 *     beMonitorLoop(scanner, hooks) the BE monitor loop                   (U7)
 *     beStats(scanner)              its counters (_be_monitor_cycles / _errors) for the heartbeat (U7)
 *     gcAnomaly(now)                (U5)
 *
 * Bot semantics (bot.py:1506-1535, 1647-1652, 1704): reconcile / cleanup / detector run under wrappers that
 * swallow every error and return (the scheduler's 💀 alert and restart never fire for them); the verifier
 * and the sweeper catch everything inside. No loop consults the killswitch (D22); every key read goes through
 * the runtime's D5 set. The loops take no per-user lock (§1.3).
 */

const S = require('./loopShells');

const LOOP_NAMES = Object.freeze(['state_reconcile', 'trade_state_cleanup', 'anomaly_detector', 'sl_verifier', 'orphan_sweeper']);

/** The heartbeat counters of one loop (observability only — D23: the bot's metrics / SLI are not ported). */
function createLoopStats(now) {
  const all = {};
  const of = (name) => {
    const s = { passes: 0, errors: 0, lastStart: null, lastEnd: null, last: null };
    all[name] = s;
    return {
      start() { s.lastStart = now(); },
      end(ok, last = null) {
        s.lastEnd = now();
        if (ok) s.passes += 1;
        else s.errors += 1;
        if (last !== null && last !== undefined) s.last = last;
      },
    };
  };
  const snapshot = () => {
    const out = {};
    for (const [k, v] of Object.entries(all)) out[k] = { ...v, last: v.last && typeof v.last === 'object' ? { ...v.last } : v.last };
    return out;
  };
  return { of, snapshot };
}

function createTradeLoops(runtime, deps = {}) {
  const rt = runtime || {};
  const env = deps.env || rt.env || process.env;
  const now = deps.now || rt.now || (() => Date.now() / 1000);
  const log = deps.log || rt.log || require('../marketData/mdLog').log;
  const orphanSweep = deps.orphanSweep || S.orphanSweepConfig(env);
  const tdb = rt.tdb || null;
  const counters = createLoopStats(now);

  const metricSamples = {};
  const P = {
    reconcileOnce: null,
    cleanupPass: null,
    runOnce: null,
    // D23: metrics.record → the heartbeat (latest gauge sample per name)
    recordMetrics: null,
    getOpenTradesAll: tdb ? () => tdb.getOpenTradesAll() : null,
    checkSingleTrade: null,
    getAllUsers: tdb ? () => tdb.getAllUsersOrdered() : null,
    sweepOneUser: null,
    beMonitorLoop: null,
    beStats: null,
    gcAnomaly: null,
    // `passes` may be a function of the runtime (the passes are built on its trader set / tdb / alerts)
    ...((typeof deps.passes === 'function' ? deps.passes(rt) : deps.passes) || {}),
  };
  if (!P.recordMetrics) {
    P.recordMetrics = S.recordMetricsOf(async (name, value) => { metricSamples[name] = value; }, log);
  }

  const st = {
    state_reconcile: counters.of('state_reconcile'),
    trade_state_cleanup: counters.of('trade_state_cleanup'),
    anomaly_detector: counters.of('anomaly_detector'),
    sl_verifier: counters.of('sl_verifier'),
    orphan_sweeper: counters.of('orphan_sweeper'),
  };

  const loops = {
    stateReconcile: P.reconcileOnce
      ? (ctx) => S.runStateReconciliation(ctx.log, () => S.stateReconciliationLoop(ctx, { reconcileOnce: P.reconcileOnce, stats: st.state_reconcile }))
      : null,
    tradeStateCleanup: P.cleanupPass
      ? (ctx) => S.runTradeStateCleanup(ctx.log, () => S.tradeStateCleanupLoop(ctx, { cleanupPass: P.cleanupPass, stats: st.trade_state_cleanup }))
      : null,
    anomalyDetector: P.runOnce
      ? (ctx) => S.runAnomalyDetector(ctx.log, () => S.runDetectorLoop(ctx, { runOnce: P.runOnce, recordMetrics: P.recordMetrics, stats: st.anomaly_detector }))
      : null,
    slVerifier: P.checkSingleTrade && P.getOpenTradesAll
      ? (ctx) => S.slVerifierLoop(ctx, { getOpenTradesAll: P.getOpenTradesAll, checkSingleTrade: P.checkSingleTrade, stats: st.sl_verifier })
      : null,
    orphanSweeper: P.sweepOneUser && P.getAllUsers
      ? (ctx) => S.orphanSweeperLoop(ctx, { config: orphanSweep, getAllUsers: P.getAllUsers, sweepOneUser: P.sweepOneUser, stats: st.orphan_sweeper })
      : null,
  };
  const KEY_OF = {
    state_reconcile: 'stateReconcile', trade_state_cleanup: 'tradeStateCleanup', anomaly_detector: 'anomalyDetector',
    sl_verifier: 'slVerifier', orphan_sweeper: 'orphanSweeper',
  };

  let beScanner = null;
  const beMonitorLoop = typeof P.beMonitorLoop === 'function'
    ? (scanner, hooks) => { beScanner = scanner; return P.beMonitorLoop(scanner, hooks); }
    : null;

  return {
    ...loops,
    beMonitorLoop,
    /** cache_gc._cleanup_once's trade_anomaly_detector block (U5); nothing to free while the detector is not ported. */
    gcAnomaly(t) {
      return typeof P.gcAnomaly === 'function' ? (P.gcAnomaly(t) || {}) : {};
    },
    stats() {
      const out = counters.snapshot();
      if (Object.keys(metricSamples).length) out.anomaly_detector.metrics = { ...metricSamples };
      if (typeof P.beStats === 'function' && beScanner) {
        try { out.be_monitor = P.beStats(beScanner); } catch (_e) { out.be_monitor = null; }
      }
      return out;
    },
    wired() {
      const names = LOOP_NAMES.filter((n) => loops[KEY_OF[n]]);
      if (beMonitorLoop) names.unshift('be_monitor');
      return names;
    },
    orphanSweep,
    runtime: rt,
    LOOP_NAMES,
    _passes: P,
  };
}

module.exports = { LOOP_NAMES, createTradeLoops, createLoopStats };
