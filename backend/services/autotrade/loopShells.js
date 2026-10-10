'use strict';
/**
 * loopShells.js — the bot's trade-ops loop functions with their single passes injected (PLAN_M15 U2),
 * line for line, plus the swallowing bot.py wrappers. Bot HEAD 1a47ffc:
 *
 *   stateReconciliationLoop   auto_trade.state_reconciliation_loop      (auto_trade.py:4275-4293)
 *   tradeStateCleanupLoop     auto_trade.trade_state_cleanup_loop        (auto_trade.py:4306-4368, the pass = U3)
 *   runDetectorLoop           trade_anomaly_detector.run_detector_loop   (trade_anomaly_detector.py:1650-1686)
 *     recordMetricsOf         trade_anomaly_detector._record_metrics     (:1616-1647; metrics are D23 no-ops)
 *   slVerifierLoop            sl_verifier.sl_verifier_loop               (sl_verifier.py:354-387)
 *   orphanSweeperLoop         orphan_sweeper.orphan_sweeper_loop         (orphan_sweeper.py:311-389)
 *     orphanSweepConfig       orphan_sweeper.py:53-56 (the env, int() at import — D24)
 *   runStateReconciliation / runTradeStateCleanup / runAnomalyDetector   bot.py:1506-1535 (swallow + return)
 *
 * The passes (reconcileOnce, cleanupPass, runOnce, checkSingleTrade, sweepOneUser) are injected so the
 * real U3-U6 ports plug in without touching the shells; the readers the loops call themselves
 * (db_get_open_trades_all, db_get_all_users) are injected the same way.
 *
 * Cancellation (the bot's task.cancel() at shutdown = the scheduler's AbortSignal):
 *   * every shell runs inside asyncio.runInScope(ctx.signal, …): an in-flight trader request / in-pass
 *     sleep raises CancelledError at its await and no further request leaves;
 *   * the shells' own sleeps raise CancelledError too (`loopSleep`), so the bot's try boundaries decide the
 *     shutdown line: a cancel that lands INSIDE a try prints the bot's "stopped" line, one outside it
 *     (the first delay, the sleep after the try, the sweeper's 3600 s back-off) is silent — per loop:
 *       reconcile / cleanup / detector   pass → line; first delay and interval sleep → silent
 *       SL verifier                      reads, the "no open trades" 180 s sleep and the gather → line;
 *                                        first delay and the normal 180 s sleep → silent (C-9)
 *       orphan sweeper                   the whole cycle incl. the 0.3 s pauses and the interval sleep → line;
 *                                        the 120 s warm-up and the 3600 s back-off → silent (C-9)
 *   * C-5: after every awaited call of the shell that is not a cancellation point on the site (a pass that
 *     finished, a DB read, the metrics hook) `checkCancelled()` runs inside the same try — an abort that came
 *     while the shell waited there is the bot's CancelledError at that await (the shutdown line, nothing after it);
 *   * C-15: only CancelledError is a cancellation; any other error — TimeoutError of an inner wait_for or
 *     anything else — takes the bot's `except Exception` branch.
 *
 * ctx (the scheduler's): { signal, sleep(ms) (resolves early on abort), log, now() (s) }. Long sleeps are
 * chunked under the Node timer limit (2^31 − 1 ms): ORPHAN_SWEEP_INTERVAL_S may exceed 24.8 days.
 * `stats` (optional) = the heartbeat counters of tradeLoops.js: start() / end(ok) around each iteration.
 */

const asyncio = require('./asyncio');
const { pf } = require('./pyfmt');
const { pyGet, pyIndex, pyTruthy, pyOr, pyStr, pyTypeName, pyFloat, TypeError: PyTypeErrorOf } = require('../exchanges/pyCompat');
const { pyInt } = require('../engine/pycoerce');
const { pyStrip, pyStrRepr } = require('../../strategies/common/pyUnicode');

// auto_trade.py
const RECONCILE_FIRST_S = 60;
const RECONCILE_INTERVAL_S = 120;                 // _RECONCILE_INTERVAL
const STATE_CLEANUP_FIRST_S = 60;
const STATE_CLEANUP_INTERVAL_S = 1800;            // _STATE_CLEANUP_INTERVAL_S
const STUCK_PLACING_MAX_AGE_S = 1800;             // _STUCK_PLACING_MAX_AGE_S
// trade_anomaly_detector.py
const DETECTOR_FIRST_S = 60;
const DETECTOR_INTERVAL_S = 30;                   // _DETECTOR_INTERVAL_S
const DETECTOR_GRACE_WINDOW_S = 10;               // _GRACE_WINDOW_S (only printed by the loop)
// sl_verifier.py
const VERIFIER_FIRST_S = 60;
const VERIFY_INTERVAL_S = 180;                    // _VERIFY_INTERVAL
const VERIFIER_CONCURRENCY = 5;                   // asyncio.Semaphore(5)
// orphan_sweeper.py
const SWEEPER_FIRST_S = 120;
const SWEEPER_USER_PAUSE_S = 0.3;
const SWEEPER_BACKOFF_S = 3600;
const ORPHAN_SWEEP_INT_ENV = Object.freeze([
  ['ORPHAN_SWEEP_INTERVAL_S', '300', 'intervalS'],
  ['ORPHAN_SWEEP_MIN_ORDER_AGE_S', '120', 'minOrderAgeS'],
  ['ORPHAN_SWEEP_RECENT_OPEN_S', '300', 'recentOpenS'],
]);

const MAX_TIMER_MS = 2 ** 31 - 1;
const NO_STATS = Object.freeze({ start() {}, end() {} });

/** The stack of an error for a log line the bot writes with exc_info=True (`log.error(msg, stack)`). */
function excInfo(e) {
  if (e && e.stack) return String(e.stack);
  return e && e.message !== undefined ? String(e.message) : String(e);
}

/** asyncio.sleep(s) of a loop shell: CancelledError on abort (a cancellation point), chunked past the timer limit. */
function loopSleep(ctx) {
  return async (s) => {
    asyncio.checkCancelled();
    let ms = Number(s) * 1000;
    if (!(ms > MAX_TIMER_MS)) {
      await asyncio.guardCancel(ctx.sleep(ms));
      asyncio.checkCancelled();
      return;
    }
    while (ms > 0) {
      const chunk = Math.min(ms, MAX_TIMER_MS);
      await asyncio.guardCancel(ctx.sleep(chunk));
      asyncio.checkCancelled();
      ms -= chunk;
    }
  };
}

/** `total += x` of Python ints (bool counts 0/1, a float makes it a float, anything else raises TypeError). */
function pyIadd(total, x) {
  if (typeof x === 'boolean') return total + (x ? 1 : 0);
  if (typeof x === 'number') return total + x;
  const left = Number.isInteger(total) ? 'int' : 'float';
  throw PyTypeErrorOf(`unsupported operand type(s) for +=: '${left}' and '${pyTypeName(x)}'`);
}

// ═══════════════════════════════════════════════════════════════════════
//  orphan_sweeper.py:53-56 — the env, parsed once (D24)
// ═══════════════════════════════════════════════════════════════════════

class OrphanSweepEnvError extends Error {
  constructor(name, raw, reason) {
    super(`${name}=${pyStrRepr(raw)}: ${reason}`);
    this.name = 'OrphanSweepEnvError';
    this.envName = name;
    this.envValue = raw;
  }
}

/**
 * ORPHAN_SWEEP_INTERVAL_S / _MIN_ORDER_AGE_S / _RECENT_OPEN_S = int(os.environ.get(NAME, default)) — CPython
 * int() of the text (surrounding Unicode whitespace, a sign, PEP 515 underscores, Unicode decimal digits;
 * '' / '5.0' / '0x10' raise), in the bot's order, the first failure wins — and ORPHAN_SWEEP_ENABLED =
 * os.environ.get(…, "1").strip() != "0" (only "0" after strip disables; "false" keeps it on).
 * A malformed int throws OrphanSweepEnvError (D24: the trade runtime does not start; the bot dies at
 * start-up) — also when the sweeper is disabled (C-16, the bot parses before the ENABLED check). Site
 * rule on top (D24): an int outside ±(2^53 − 1) is refused as well (JS timers / numbers cannot hold it).
 */
function orphanSweepConfig(env = process.env) {
  const out = {};
  for (const [name, dflt, key] of ORPHAN_SWEEP_INT_ENV) {
    const v = env[name];
    const raw = v === undefined || v === null ? dflt : String(v);
    let n;
    try {
      n = pyInt(raw);
    } catch (e) {
      throw new OrphanSweepEnvError(name, raw, e && e.message !== undefined ? e.message : String(e));
    }
    if (!Number.isSafeInteger(n)) throw new OrphanSweepEnvError(name, raw, 'out of the range the site accepts (±9007199254740991)');
    out[key] = n;
  }
  const en = env.ORPHAN_SWEEP_ENABLED;
  out.enabled = pyStrip(en === undefined || en === null ? '1' : String(en)) !== '0';
  return Object.freeze(out);
}

// ═══════════════════════════════════════════════════════════════════════
//  the loops
// ═══════════════════════════════════════════════════════════════════════

/** auto_trade.state_reconciliation_loop() — `reconcileOnce()` = _reconcile_once (U3). */
function stateReconciliationLoop(ctx, { reconcileOnce, stats = NO_STATS }) {
  const { log } = ctx;
  const sleep = loopSleep(ctx);
  return asyncio.runInScope(ctx.signal, async () => {
    log.info(pf('[AUDIT-FIX] State reconciliation loop started (interval=%ds)', RECONCILE_INTERVAL_S));
    await sleep(RECONCILE_FIRST_S);                 // даём боту стартовать (outside the try)
    for (;;) {
      try {
        stats.start();
        await reconcileOnce();
        asyncio.checkCancelled();
        stats.end(true);
      } catch (e) {
        if (asyncio.isCancelledError(e)) {
          log.info('[AUDIT-FIX] State reconciliation loop stopped.');
          return;
        }
        stats.end(false);
        log.error(pf('[AUDIT-FIX] reconciliation error: %s', e), excInfo(e));
      }
      await sleep(RECONCILE_INTERVAL_S);
    }
  });
}

/** auto_trade.trade_state_cleanup_loop() — `cleanupPass(maxAgeS)` = the try body (U3: db_cleanup_stuck_placing + lines). */
function tradeStateCleanupLoop(ctx, { cleanupPass, stats = NO_STATS }) {
  const { log } = ctx;
  const sleep = loopSleep(ctx);
  return asyncio.runInScope(ctx.signal, async () => {
    log.info(pf('[STATE-CLEANUP] loop started (interval=%ds, max_age=%ds)', STATE_CLEANUP_INTERVAL_S, STUCK_PLACING_MAX_AGE_S));
    await sleep(STATE_CLEANUP_FIRST_S);
    for (;;) {
      try {
        stats.start();
        await cleanupPass(STUCK_PLACING_MAX_AGE_S);
        asyncio.checkCancelled();
        stats.end(true);
      } catch (e) {
        if (asyncio.isCancelledError(e)) {
          log.info('[STATE-CLEANUP] loop stopped.');
          return;
        }
        stats.end(false);
        log.error(pf('[STATE-CLEANUP] pass failed: %s', e), excInfo(e));
      }
      await sleep(STATE_CLEANUP_INTERVAL_S);
    }
  });
}

/**
 * trade_anomaly_detector._record_metrics(stats): the two gauge samples, each failure swallowed at DEBUG.
 * `record(name, value)` = metrics.record (D23: the site has no metrics store — tradeLoops.js keeps the
 * samples in the heartbeat counters).
 */
function recordMetricsOf(record, log) {
  return async (stats) => {
    try {
      await record('anomaly_missing_sl_observed', pyFloat(pyGet(stats, 'missing_sl_found', 0)));
    } catch (e) {
      if (asyncio.isCancelledError(e)) throw e;
      log.debug(pf('[ANOMALY] record missing_sl sample: %s', e));
    }
    try {
      await record('anomaly_price_past_sl_observed', pyFloat(pyGet(stats, 'price_past_sl_found', 0)));
    } catch (e) {
      if (asyncio.isCancelledError(e)) throw e;
      log.debug(pf('[ANOMALY] record price_past_sl sample: %s', e));
    }
  };
}

/**
 * trade_anomaly_detector.run_detector_loop(bot) — `runOnce()` = _run_once(bot) (U5) → the stats dict,
 * `recordMetrics(stats)` = _record_metrics. The pass line is a WARNING when the pass found a missing SL or a
 * price past the SL, else DEBUG.
 */
function runDetectorLoop(ctx, { runOnce, recordMetrics, stats = NO_STATS }) {
  const { log } = ctx;
  const sleep = loopSleep(ctx);
  return asyncio.runInScope(ctx.signal, async () => {
    log.info(pf('[ANOMALY] loop started (interval=%ds, grace=%ds)', DETECTOR_INTERVAL_S, DETECTOR_GRACE_WINDOW_S));
    await sleep(DETECTOR_FIRST_S);                  // grace for bot init
    for (;;) {
      try {
        stats.start();
        const t0 = ctx.now();
        const res = await runOnce();
        asyncio.checkCancelled();
        const dt = ctx.now() - t0;
        await recordMetrics(res);
        asyncio.checkCancelled();
        const found = pyTruthy(pyGet(res, 'missing_sl_found', 0)) || pyTruthy(pyGet(res, 'price_past_sl_found', 0));
        if (found) log.warning(pf('[ANOMALY] pass took %.1fs: %s', dt, res));
        else log.debug(pf('[ANOMALY] pass took %.1fs: %s', dt, res));
        stats.end(true, res);
      } catch (e) {
        if (asyncio.isCancelledError(e)) {
          log.info('[ANOMALY] loop stopped.');
          return;
        }
        stats.end(false);
        log.error(pf('[ANOMALY] pass failed: %s', e), excInfo(e));
      }
      await sleep(DETECTOR_INTERVAL_S);
    }
  });
}

/**
 * sl_verifier.sl_verifier_loop(bot, um) — `getOpenTradesAll()` = db_get_open_trades_all (U1),
 * `checkSingleTrade(trade)` = _check_single_trade(bot, um, trade) (U4). Every cycle a fresh Semaphore(5)
 * and gather(return_exceptions=True) of one `_safe_check` per row in the reader's order.
 */
function slVerifierLoop(ctx, { getOpenTradesAll, checkSingleTrade, stats = NO_STATS }) {
  const { log } = ctx;
  const sleep = loopSleep(ctx);
  return asyncio.runInScope(ctx.signal, async () => {
    log.info(pf('🛡 SL-Verifier loop started (interval=%ds)', VERIFY_INTERVAL_S));
    await sleep(VERIFIER_FIRST_S);                  // даём боту прогреться
    for (;;) {
      try {
        stats.start();
        const openTrades = await getOpenTradesAll();
        asyncio.checkCancelled();
        if (!pyTruthy(openTrades)) {
          stats.end(true);
          await sleep(VERIFY_INTERVAL_S);           // inside the try: a cancel here prints the stopped line
          continue;
        }
        const sem = asyncio.createSemaphore(VERIFIER_CONCURRENCY);
        const safeCheck = (tr) => sem.run(async () => {
          try {
            await checkSingleTrade(tr);
            asyncio.checkCancelled();
          } catch (e) {
            if (asyncio.isCancelledError(e)) throw e;
            log.debug(pf('sl_verify trade: %s', e));
          }
        });
        // asyncio.gather(*[_safe_check(tr) for tr in open_trades], return_exceptions=True)
        await Promise.all(Array.from(openTrades, (tr) => safeCheck(tr).then(() => undefined, (e) => e)));
        asyncio.checkCancelled();                   // the loop task was cancelled while it awaited the gather
        stats.end(true);
      } catch (e) {
        if (asyncio.isCancelledError(e)) {
          log.info('🛡 SL-Verifier loop stopped.');
          return;
        }
        stats.end(false);
        log.warning(pf('sl_verifier_loop: %s', e));
      }
      await sleep(VERIFY_INTERVAL_S);
    }
  });
}

/**
 * orphan_sweeper.orphan_sweeper_loop(bot) — `config` = orphanSweepConfig(env) (parsed when the runtime is
 * built: the bot's import-time read), `getAllUsers()` = db_get_all_users (U1, rows with keys),
 * `sweepOneUser(row)` = _sweep_one_user (U6). The key pre-filter (`<trade_exchange>_api_key`, the raw
 * case-sensitive column; '' / None → bybit) and the 0.3 s pause after every pre-filtered user are the loop's.
 * The bot's `[HEALTH-MON]` heartbeat ('ORPHAN') is dead (no `health` on the bot module, Q-S12): not ported —
 * the site never heartbeats ORPHAN.
 */
function orphanSweeperLoop(ctx, { config, getAllUsers, sweepOneUser, stats = NO_STATS }) {
  const { log } = ctx;
  const sleep = loopSleep(ctx);
  return asyncio.runInScope(ctx.signal, async () => {
    if (!config.enabled) {
      log.info('[ORPHAN-SWEEPER] disabled via env ORPHAN_SWEEP_ENABLED=0');
      return;
    }
    log.info(pf('[ORPHAN-SWEEPER] started (interval=%ds min_order_age=%ds recent_open_window=%ds)',
      config.intervalS, config.minOrderAgeS, config.recentOpenS));
    await sleep(SWEEPER_FIRST_S);                   // Initial delay — даём боту прогреться (outside the try)
    for (;;) {
      try {
        log.info('[ORPHAN-SWEEP-START] cycle starting');
        stats.start();
        const cycleStart = ctx.now();
        let users;
        try {
          users = await getAllUsers();
          asyncio.checkCancelled();
        } catch (e) {
          if (asyncio.isCancelledError(e)) throw e;
          log.warning(pf('[ORPHAN-SWEEPER] cannot load users: %s', e));
          users = [];
        }
        let totalChecked = 0;
        let totalCancelled = 0;
        let totalErrors = 0;
        let nUsers = 0;
        for (const uRow of pyOr(users, [])) {
          // Skip if no API key for current exchange
          const exch = pyOr(pyGet(uRow, 'trade_exchange', 'bybit'), 'bybit');
          const apiField = `${pyStr(exch)}_api_key`;
          if (!pyTruthy(pyGet(uRow, apiField, null))) continue;
          nUsers += 1;
          try {
            const res = await sweepOneUser(uRow);
            asyncio.checkCancelled();
            totalChecked = pyIadd(totalChecked, pyIndex(res, 'checked'));
            totalCancelled = pyIadd(totalCancelled, pyIndex(res, 'cancelled'));
            totalErrors = pyIadd(totalErrors, pyIndex(res, 'errors'));
          } catch (e) {
            if (asyncio.isCancelledError(e)) throw e;
            log.debug(pf('[ORPHAN-SWEEP] uid=%s sweep: %s', pyGet(uRow, 'user_id', null), e));
            totalErrors += 1;
          }
          // Rate-limit: 0.3s между юзерами (не флудим биржу)
          await sleep(SWEEPER_USER_PAUSE_S);
        }
        const cycleDur = ctx.now() - cycleStart;
        log.info(pf('[ORPHAN-SWEEP-CYCLE] users=%d orders_checked=%d cancelled=%d errors=%d duration=%.1fs',
          nUsers, totalChecked, totalCancelled, totalErrors, cycleDur));
        stats.end(true, { users: nUsers, orders_checked: totalChecked, cancelled: totalCancelled, errors: totalErrors });
        await sleep(config.intervalS);
      } catch (e) {
        if (asyncio.isCancelledError(e)) {
          log.info('[ORPHAN-SWEEPER] cancelled — shutdown');
          return;
        }
        stats.end(false);
        log.warning(pf('[ORPHAN-SWEEPER] iteration error: %s', e));
        await sleep(SWEEPER_BACKOFF_S);             // back off на час при crash (outside the try: silent)
      }
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════
//  bot.py:1506-1535 — the wrappers that swallow everything and RETURN
// ═══════════════════════════════════════════════════════════════════════
// So the scheduler's guarded / guardedRestart never sees an error from these three loops: no 💀 alert, no
// restart (INF-Q-I3, REC-Q30, ANM-Q1); a cancel ends them with a normal return.

function swallowing(label) {
  return async (log, loop) => {
    try {
      await loop();
    } catch (e) {
      if (asyncio.isCancelledError(e)) return;
      log.error(pf(label, e));
    }
  };
}

/** _run_state_reconciliation() */
const runStateReconciliation = swallowing('[AUDIT-FIX] state_reconciliation_loop crashed: %s');
/** _run_trade_state_cleanup() */
const runTradeStateCleanup = swallowing('[STATE-CLEANUP] loop crashed: %s');
/** _run_anomaly_detector() */
const runAnomalyDetector = swallowing('[ANOMALY] loop crashed: %s');

module.exports = {
  RECONCILE_FIRST_S, RECONCILE_INTERVAL_S, STATE_CLEANUP_FIRST_S, STATE_CLEANUP_INTERVAL_S, STUCK_PLACING_MAX_AGE_S,
  DETECTOR_FIRST_S, DETECTOR_INTERVAL_S, DETECTOR_GRACE_WINDOW_S, VERIFIER_FIRST_S, VERIFY_INTERVAL_S, VERIFIER_CONCURRENCY,
  SWEEPER_FIRST_S, SWEEPER_USER_PAUSE_S, SWEEPER_BACKOFF_S, ORPHAN_SWEEP_INT_ENV, MAX_TIMER_MS,
  OrphanSweepEnvError, orphanSweepConfig, loopSleep, pyIadd, excInfo, recordMetricsOf,
  stateReconciliationLoop, tradeStateCleanupLoop, runDetectorLoop, slVerifierLoop, orphanSweeperLoop,
  runStateReconciliation, runTradeStateCleanup, runAnomalyDetector,
};
