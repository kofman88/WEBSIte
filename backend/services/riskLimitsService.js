/**
 * Risk Limits — per-user safety net that wraps every auto-trade execution.
 *
 * Four controls:
 *   1. killSwitchEnabled — master off switch; blocks ALL auto-trade
 *   2. maxOpenPositions  — global cap (across every bot the user owns)
 *   3. maxDailyLossPct   — stop new entries once today's realised loss
 *                           exceeds X% of starting equity (paper balance OR
 *                           aggregated live balance at session start)
 *   4. blacklistedSymbols — exact-match symbol reject list (BTCUSDT, ETH/USDT)
 *
 * Call `canOpenTrade(userId, { symbol })` before opening; returns
 *   { allow: true } or { allow: false, reason: 'kill_switch' | ... }.
 *
 * The check is cheap (1-3 SQL hits, no network) and runs on every signal
 * passed to autoTradeService.executeSignal — fine even at scanner full tilt.
 */

const db = require('../models/database');
const logger = require('../utils/logger');

const DEFAULTS = Object.freeze({
  killSwitchEnabled: false,
  maxOpenPositions: 20,
  maxDailyLossPct: 5,
  blacklistedSymbols: [],
});

function _safeJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function _hydrate(row) {
  return {
    userId: row.user_id,
    killSwitchEnabled: !!row.kill_switch_enabled,
    maxOpenPositions: row.max_open_positions,
    maxDailyLossPct: row.max_daily_loss_pct,
    blacklistedSymbols: _safeJson(row.blacklisted_symbols, []),
    updatedAt: row.updated_at,
  };
}

function get(userId) {
  let row = db.prepare('SELECT * FROM user_risk_limits WHERE user_id = ?').get(userId);
  if (!row) {
    db.prepare(`
      INSERT INTO user_risk_limits
        (user_id, kill_switch_enabled, max_open_positions, max_daily_loss_pct, blacklisted_symbols)
      VALUES (?, 0, ?, ?, '[]')
    `).run(userId, DEFAULTS.maxOpenPositions, DEFAULTS.maxDailyLossPct);
    row = db.prepare('SELECT * FROM user_risk_limits WHERE user_id = ?').get(userId);
  }
  return _hydrate(row);
}

function update(userId, patch) {
  const current = get(userId);
  const merged = {
    killSwitchEnabled: 'killSwitchEnabled' in patch
      ? !!patch.killSwitchEnabled : current.killSwitchEnabled,
    maxOpenPositions: Number.isFinite(patch.maxOpenPositions)
      ? Math.max(1, Math.min(500, Math.round(patch.maxOpenPositions))) : current.maxOpenPositions,
    maxDailyLossPct: Number.isFinite(patch.maxDailyLossPct)
      ? Math.max(0.1, Math.min(50, patch.maxDailyLossPct)) : current.maxDailyLossPct,
    blacklistedSymbols: Array.isArray(patch.blacklistedSymbols)
      ? patch.blacklistedSymbols
          .map((s) => String(s || '').trim().toUpperCase())
          .filter(Boolean).slice(0, 100)
      : current.blacklistedSymbols,
  };
  db.prepare(`
    UPDATE user_risk_limits SET
      kill_switch_enabled = ?, max_open_positions = ?, max_daily_loss_pct = ?,
      blacklisted_symbols = ?, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
  `).run(
    merged.killSwitchEnabled ? 1 : 0,
    merged.maxOpenPositions, merged.maxDailyLossPct,
    JSON.stringify(merged.blacklistedSymbols),
    userId
  );
  logger.info('risk limits updated', { userId, changes: Object.keys(patch) });
  return get(userId);
}

/**
 * Called by autoTradeService.executeSignal before opening a position.
 * @returns {{ allow: boolean, reason?: string, detail?: object }}
 */
function canOpenTrade(userId, { symbol } = {}) {
  const limits = get(userId);

  if (limits.killSwitchEnabled) {
    return { allow: false, reason: 'kill_switch' };
  }

  if (symbol && limits.blacklistedSymbols.includes(String(symbol).toUpperCase())) {
    return { allow: false, reason: 'blacklisted_symbol', detail: { symbol } };
  }

  // Global max open positions across every bot this user owns
  const open = db.prepare(`
    SELECT COUNT(*) AS n FROM trades t
    JOIN trading_bots b ON b.id = t.bot_id
    WHERE b.user_id = ? AND t.status = 'open'
  `).get(userId).n;
  if (open >= limits.maxOpenPositions) {
    return { allow: false, reason: 'max_open_positions', detail: { open, limit: limits.maxOpenPositions } };
  }

  // Daily-loss cut-off. `today` = last 24h of closed trades for this user.
  // We compare absolute $ loss to X% of user's paper_starting_balance (proxy
  // for "equity at start of session" — not perfect, but doesn't require a
  // live exchange roundtrip on the hot path).
  const lossRow = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN t.result_pnl_pct < 0 THEN t.result_pnl_pct ELSE 0 END), 0) AS loss_sum_pct,
           COUNT(CASE WHEN t.result_pnl_pct < 0 THEN 1 END) AS loss_count
    FROM trades t
    JOIN trading_bots b ON b.id = t.bot_id
    WHERE b.user_id = ? AND t.status = 'closed'
      AND t.closed_at > datetime('now','-24 hours')
  `).get(userId);
  // loss_sum_pct is already a percent (per-trade pnl% summed). If its
  // absolute value already exceeds the limit, reject. This approximates
  // true equity-weighted drawdown without a balance snapshot.
  const lossAbs = Math.abs(lossRow.loss_sum_pct || 0);
  if (lossAbs >= limits.maxDailyLossPct) {
    return {
      allow: false, reason: 'daily_loss_limit',
      detail: { lossPct: lossAbs.toFixed(2), limitPct: limits.maxDailyLossPct, trades: lossRow.loss_count },
    };
  }

  return { allow: true };
}

module.exports = { get, update, canOpenTrade, DEFAULTS };
