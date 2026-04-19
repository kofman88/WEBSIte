/**
 * Circuit breaker — daily loss guard.
 *
 * If a user's realized PnL in the last 24h drops below -threshold (default 10%
 * of nominal starting balance), ALL their active bots are auto-paused and
 * they receive an alert event. The breaker is "tripped" for the remainder
 * of the day; it resets at UTC midnight.
 *
 * A manual override (admin or user through settings) can reset the flag.
 *
 * Keys in system_kv:
 *   breaker:user:<id>  — { trippedAt: ISO, reason: string }
 */

const db = require('../models/database');
const logger = require('../utils/logger');

const DEFAULT_DAILY_LOSS_PCT = 10; // 10% of reference balance
const DEFAULT_REFERENCE_BALANCE = 10_000; // used when user hasn't specified

function computeDailyPnl(userId, tradingMode = null) {
  const filter = tradingMode ? `AND trading_mode = ?` : '';
  const params = tradingMode ? [userId, tradingMode] : [userId];
  const row = db.prepare(`
    SELECT COALESCE(SUM(realized_pnl), 0) as pnl
    FROM trades
    WHERE user_id = ?
      AND status = 'closed'
      AND closed_at >= datetime('now', '-1 day')
      ${filter}
  `).get(...params);
  return Number(row.pnl) || 0;
}

function getBreakerState(userId) {
  const row = db.prepare(`SELECT value FROM system_kv WHERE key = ?`).get('breaker:user:' + userId);
  if (!row) return null;
  try {
    const val = JSON.parse(row.value);
    // Auto-reset if older than 24h
    if (val.trippedAt && Date.now() - new Date(val.trippedAt).getTime() > 24 * 3600 * 1000) {
      reset(userId);
      return null;
    }
    return val;
  } catch (_e) { return null; }
}

function trip(userId, { dailyPnl, threshold, reason }) {
  const payload = {
    trippedAt: new Date().toISOString(),
    dailyPnl,
    threshold,
    reason: reason || 'daily_loss_limit',
  };
  db.prepare(`
    INSERT OR REPLACE INTO system_kv (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
  `).run('breaker:user:' + userId, JSON.stringify(payload));

  // Auto-pause all active bots of this user
  const pauseInfo = db.prepare(`
    UPDATE trading_bots SET is_active = 0, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ? AND is_active = 1
  `).run(userId);

  // Audit log
  db.prepare(`
    INSERT INTO audit_log (user_id, action, entity_type, metadata)
    VALUES (?, 'circuit_breaker_tripped', 'user', ?)
  `).run(userId, JSON.stringify({ ...payload, botsPaused: pauseInfo.changes }));

  logger.warn('circuit breaker tripped', { userId, dailyPnl, botsPaused: pauseInfo.changes });
  return { tripped: true, botsPaused: pauseInfo.changes, ...payload };
}

function reset(userId) {
  db.prepare(`DELETE FROM system_kv WHERE key = ?`).run('breaker:user:' + userId);
  db.prepare(`
    INSERT INTO audit_log (user_id, action, entity_type) VALUES (?, 'circuit_breaker_reset', 'user')
  `).run(userId);
  return { reset: true };
}

/**
 * Pre-execution check. Call this before placing ANY new trade.
 * Returns { allow: true } or { allow: false, reason, ... }.
 */
function check(userId, {
  referenceBalance = DEFAULT_REFERENCE_BALANCE,
  dailyLossPct = DEFAULT_DAILY_LOSS_PCT,
  tradingMode = null,
} = {}) {
  const existing = getBreakerState(userId);
  if (existing) {
    return {
      allow: false,
      reason: 'CIRCUIT_BREAKER_TRIPPED',
      trippedAt: existing.trippedAt,
      dailyPnl: existing.dailyPnl,
    };
  }

  const dailyPnl = computeDailyPnl(userId, tradingMode);
  const threshold = -referenceBalance * (dailyLossPct / 100);

  if (dailyPnl < threshold) {
    trip(userId, { dailyPnl, threshold, reason: 'daily_loss_exceeded' });
    return {
      allow: false,
      reason: 'CIRCUIT_BREAKER_TRIPPED',
      dailyPnl,
      threshold,
    };
  }

  return { allow: true, dailyPnl, threshold };
}

module.exports = {
  check,
  trip,
  reset,
  getBreakerState,
  computeDailyPnl,
  DEFAULT_DAILY_LOSS_PCT,
};
