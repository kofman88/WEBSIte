/**
 * Backtest service — CRUD + queuing.
 *
 * Uses backtestEngine.runBacktest() behind an async p-queue (concurrency 2
 * server-wide to prevent CPU saturation). Per-user caps enforced here.
 */

const PQueue = require('p-queue').default;
const db = require('../models/database');
const engine = require('./backtestEngine');
const plans = require('../config/plans');
const logger = require('../utils/logger');

const GLOBAL_CONCURRENCY = 2;
const runQueue = new PQueue({ concurrency: GLOBAL_CONCURRENCY });

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
      err.requiredPlan = limits.backtestsPerDay === 0 ? 'pro' : 'elite';
      throw err;
    }
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
  runQueue.add(async () => {
    try {
      await engine.runBacktest(id);
    } catch (err) {
      logger.warn('bt queue runner: failure', { id, err: err.message });
      // runBacktest already persists status='failed'
    }
  });

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
