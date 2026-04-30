/**
 * Backtest service — CRUD + queuing.
 *
 * Uses backtestEngine.runBacktest() behind an async p-queue (concurrency
 * tunable via BACKTEST_CONCURRENCY env, default 2). Per-user caps enforced
 * here: daily cap by plan + max in-flight (running+pending) so one user
 * can't monopolise the queue.
 *
 * On startup we recover from a hard restart by:
 *   - marking any leftover status='running' as 'failed' (interrupted)
 *   - re-enqueueing leftover status='pending' so jobs aren't lost forever
 */

const PQueue = require('p-queue').default;
const db = require('../models/database');
const engine = require('./backtestEngine');
const plans = require('../config/plans');
const logger = require('../utils/logger');

const GLOBAL_CONCURRENCY = Number(process.env.BACKTEST_CONCURRENCY) || 2;
// Cap per-user queue depth — a user with a high daily limit could otherwise
// stuff dozens of jobs in front of everyone else's. Counts both 'running'
// and 'pending' so a slow run still leaves capacity for others.
const PER_USER_INFLIGHT_CAP = Number(process.env.BACKTEST_PER_USER_INFLIGHT) || 3;
const runQueue = new PQueue({ concurrency: GLOBAL_CONCURRENCY });

function _enqueue(id) {
  runQueue.add(async () => {
    try {
      await engine.runBacktest(id);
    } catch (err) {
      logger.warn('bt queue runner: failure', { id, err: err.message });
      // runBacktest already persists status='failed'
    }
  });
}

// Run once at module-load (server start). Fires synchronously so by the time
// /api/backtests handlers are ready, recovery has already updated the DB.
function _recoverOnStartup() {
  try {
    const stuck = db.prepare(`
      UPDATE backtests
         SET status = 'failed',
             error_message = 'Interrupted by server restart',
             completed_at = CURRENT_TIMESTAMP
       WHERE status = 'running'
    `).run();
    if (stuck.changes) logger.info('bt: marked interrupted runs as failed', { count: stuck.changes });

    const pending = db.prepare(`SELECT id FROM backtests WHERE status = 'pending' ORDER BY id ASC`).all();
    for (const row of pending) _enqueue(row.id);
    if (pending.length) logger.info('bt: re-enqueued pending runs', { count: pending.length });
  } catch (err) {
    logger.warn('bt: startup recovery failed', { err: err.message });
  }
}
// Skip recovery in test env so tests don't pick up rows from a previous run.
if (process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true') _recoverOnStartup();

function createBacktest(userId, cfg) {
  // Plan gating — daily cap
  const planRow = db.prepare(`SELECT plan FROM subscriptions WHERE user_id = ?`).get(userId);
  const plan = (planRow && planRow.plan) || 'free';
  const limits = plans.getLimits(plan);
  if (limits.backtestsPerDay !== Infinity) {
    const countToday = db.prepare(`
      SELECT COUNT(*) as n FROM backtests
      WHERE user_id = ? AND DATE(created_at) = DATE('now')
    `).get(userId).n;
    if (countToday >= limits.backtestsPerDay) {
      const err = new Error(
        `Your plan allows ${limits.backtestsPerDay} backtests per day.`
      );
      err.statusCode = 403;
      err.code = 'BACKTEST_LIMIT_REACHED';
      // Suggest the next tier with a higher quota — free→starter (1/day),
      // starter→pro (10/day), pro→elite (∞).
      err.requiredPlan = plan === 'free' ? 'starter' : plan === 'starter' ? 'pro' : 'elite';
      throw err;
    }
  }

  // In-flight cap — protects shared queue from one greedy user
  const inflight = db.prepare(`
    SELECT COUNT(*) as n FROM backtests
    WHERE user_id = ? AND status IN ('pending', 'running')
  `).get(userId).n;
  if (inflight >= PER_USER_INFLIGHT_CAP) {
    const err = new Error(
      `You already have ${inflight} backtests running or pending. Wait for them to finish.`,
    );
    err.statusCode = 429;
    err.code = 'BACKTEST_INFLIGHT_LIMIT';
    throw err;
  }

  // Strategy gating
  if (!plans.canUseStrategy(plan, cfg.strategy)) {
    const err = new Error(`Strategy "${cfg.strategy}" not available on ${plan}`);
    err.statusCode = 403;
    err.code = 'UPGRADE_REQUIRED';
    err.requiredPlan = plans.requiredPlanForStrategy(cfg.strategy);
    throw err;
  }

  const result = db.prepare(`
    INSERT INTO backtests
      (user_id, name, strategy, exchange, symbols, timeframe,
       start_date, end_date, initial_capital,
       strategy_config, risk_config, status, progress_pct)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0)
  `).run(
    userId,
    cfg.name,
    cfg.strategy,
    cfg.exchange,
    JSON.stringify(cfg.symbols),
    cfg.timeframe,
    cfg.startDate,
    cfg.endDate,
    cfg.initialCapital,
    JSON.stringify(cfg.strategyConfig || {}),
    JSON.stringify(cfg.riskConfig || {}),
  );
  const id = result.lastInsertRowid;

  // Enqueue async run (fire-and-forget; the engine persists status itself)
  _enqueue(id);

  return getBacktest(id, userId);
}

function getBacktest(id, userId) {
  const row = db.prepare(`
    SELECT * FROM backtests WHERE id = ? AND user_id = ?
  `).get(id, userId);
  return row ? hydrate(row) : null;
}

function listForUser(userId, { limit = 50, offset = 0 } = {}) {
  const rows = db.prepare(`
    SELECT * FROM backtests WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(userId, limit, offset);
  return rows.map(hydrate);
}

function getTradesForBacktest(backtestId, userId, { limit = 500, offset = 0 } = {}) {
  const bt = db.prepare(`SELECT id FROM backtests WHERE id = ? AND user_id = ?`).get(backtestId, userId);
  if (!bt) return null;
  const rows = db.prepare(`
    SELECT * FROM backtest_trades WHERE backtest_id = ?
    ORDER BY entry_time ASC
    LIMIT ? OFFSET ?
  `).all(backtestId, limit, offset);
  return rows.map(hydrateTrade);
}

function deleteBacktest(id, userId) {
  const info = db.prepare(
    `DELETE FROM backtests WHERE id = ? AND user_id = ?`
  ).run(id, userId);
  if (info.changes === 0) {
    const err = new Error('Backtest not found'); err.statusCode = 404; throw err;
  }
  return { deleted: true };
}

function stats(userId) {
  const rows = db.prepare(`SELECT status FROM backtests WHERE user_id = ?`).all(userId);
  const total = rows.length;
  const completed = rows.filter((r) => r.status === 'completed').length;
  const running = rows.filter((r) => r.status === 'running').length;
  const pending = rows.filter((r) => r.status === 'pending').length;
  const failed = rows.filter((r) => r.status === 'failed').length;
  return { total, completed, running, pending, failed };
}

function hydrate(row) {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    strategy: row.strategy,
    exchange: row.exchange,
    symbols: safeJson(row.symbols, []),
    timeframe: row.timeframe,
    startDate: row.start_date,
    endDate: row.end_date,
    initialCapital: row.initial_capital,
    strategyConfig: safeJson(row.strategy_config, {}),
    riskConfig: safeJson(row.risk_config, {}),
    status: row.status,
    progressPct: row.progress_pct,
    results: safeJson(row.results, null),
    errorMessage: row.error_message,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function hydrateTrade(row) {
  return {
    id: row.id,
    backtestId: row.backtest_id,
    symbol: row.symbol,
    side: row.side,
    entryTime: row.entry_time,
    entryPrice: row.entry_price,
    exitTime: row.exit_time,
    exitPrice: row.exit_price,
    quantity: row.quantity,
    stopLoss: row.stop_loss,
    tp1: row.take_profit_1,
    tp2: row.take_profit_2,
    tp3: row.take_profit_3,
    pnlPct: row.pnl_pct,
    pnlUsd: row.pnl_usd,
    closeReason: row.close_reason,
    equityAfter: row.equity_after,
  };
}

function safeJson(s, fb) { if (!s) return fb; try { return JSON.parse(s); } catch { return fb; } }

module.exports = {
  createBacktest,
  getBacktest,
  listForUser,
  getTradesForBacktest,
  deleteBacktest,
  stats,
  _queue: runQueue,
};
