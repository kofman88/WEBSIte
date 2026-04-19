/**
 * Signal service — DB layer for signals.
 *
 * Uses the new `signals` table (per Phase 1 schema). Deprecates the legacy
 * `signal_history` table from the pre-v3 codebase.
 *
 * All inserts enforce idempotency via signalRegistry fingerprint dedup.
 */

const db = require('../models/database');
const registry = require('./signalRegistry');
const logger = require('../utils/logger');
const plans = require('../config/plans');

function insert(sig) {
  const fp = registry.fingerprint({
    exchange: sig.exchange,
    symbol: sig.symbol,
    strategy: sig.strategy,
    side: sig.side,
    entry: sig.entry,
    timeframe: sig.timeframe,
  });

  if (registry.isDuplicate(fp)) {
    logger.debug('signal dup rejected', { fp, symbol: sig.symbol, strategy: sig.strategy });
    return null;
  }

  const result = db.prepare(`
    INSERT INTO signals
      (user_id, bot_id, exchange, symbol, strategy, timeframe, side,
       entry_price, stop_loss, take_profit_1, take_profit_2, take_profit_3,
       risk_reward, confidence, quality, reason, metadata, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sig.userId || null,
    sig.botId || null,
    sig.exchange,
    sig.symbol,
    sig.strategy,
    sig.timeframe,
    sig.side,
    sig.entry,
    sig.stopLoss,
    sig.tp1 ?? null,
    sig.tp2 ?? null,
    sig.tp3 ?? null,
    sig.riskReward ?? null,
    sig.confidence ?? null,
    sig.quality ?? null,
    sig.reason ?? null,
    sig.metadata ? JSON.stringify(sig.metadata) : null,
    sig.expiresAt || null
  );

  const signalId = result.lastInsertRowid;
  registry.register(fp, signalId);
  return getById(signalId);
}

function getById(id) {
  const row = db.prepare(`SELECT * FROM signals WHERE id = ?`).get(id);
  return row ? hydrate(row) : null;
}

function listForUser(userId, { limit = 50, offset = 0, strategy = null, symbol = null } = {}) {
  const parts = ['(user_id IS NULL OR user_id = ?)'];
  const params = [userId];
  if (strategy) { parts.push('strategy = ?'); params.push(strategy); }
  if (symbol)   { parts.push('symbol = ?');   params.push(symbol); }
  const where = parts.join(' AND ');
  const rows = db.prepare(`
    SELECT * FROM signals
    WHERE ${where}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  return rows.map(hydrate);
}

function listPublic({ limit = 20, strategy = null } = {}) {
  const parts = ['user_id IS NULL'];
  const params = [];
  if (strategy) { parts.push('strategy = ?'); params.push(strategy); }
  const where = parts.join(' AND ');
  const rows = db.prepare(`
    SELECT * FROM signals
    WHERE ${where}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params, limit);
  return rows.map(hydrate);
}

function stats(userId = null) {
  const where = userId ? 'WHERE user_id = ? OR user_id IS NULL' : '';
  const params = userId ? [userId] : [];
  const totals = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN result = 'win'       THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN result = 'loss'      THEN 1 ELSE 0 END) as losses,
      SUM(CASE WHEN result = 'breakeven' THEN 1 ELSE 0 END) as breakevens,
      SUM(CASE WHEN result = 'pending'   THEN 1 ELSE 0 END) as pending,
      AVG(confidence) as avg_confidence,
      AVG(quality) as avg_quality
    FROM signals
    ${where}
  `).get(...params);
  const closed = (totals.wins || 0) + (totals.losses || 0);
  return {
    total: totals.total || 0,
    wins: totals.wins || 0,
    losses: totals.losses || 0,
    breakevens: totals.breakevens || 0,
    pending: totals.pending || 0,
    winRate: closed > 0 ? totals.wins / closed : null,
    avgConfidence: totals.avg_confidence,
    avgQuality: totals.avg_quality,
  };
}

function recordResult(signalId, { result, resultPrice, resultPnlPct }) {
  const info = db.prepare(`
    UPDATE signals
    SET result = ?, result_price = ?, result_pnl_pct = ?, closed_at = CURRENT_TIMESTAMP
    WHERE id = ? AND result = 'pending'
  `).run(result, resultPrice ?? null, resultPnlPct ?? null, signalId);
  return info.changes > 0;
}

function getPrefs(userId) {
  let row = db.prepare(`SELECT * FROM user_signal_prefs WHERE user_id = ?`).get(userId);
  if (!row) {
    db.prepare(`INSERT INTO user_signal_prefs (user_id) VALUES (?)`).run(userId);
    row = db.prepare(`SELECT * FROM user_signal_prefs WHERE user_id = ?`).get(userId);
  }
  return {
    userId: row.user_id,
    enabledStrategies: safeJson(row.enabled_strategies, ['levels']),
    watchedSymbols: safeJson(row.watched_symbols, []),
    blacklistedSymbols: safeJson(row.blacklisted_symbols, []),
    minConfidence: row.min_confidence,
    minRr: row.min_rr,
    timeframes: safeJson(row.timeframes, ['1h', '4h']),
    directions: safeJson(row.directions, ['long', 'short']),
    notificationsWeb: Boolean(row.notifications_web),
    notificationsEmail: Boolean(row.notifications_email),
    notificationsTelegram: Boolean(row.notifications_telegram),
    telegramChatId: row.telegram_chat_id,
  };
}

function updatePrefs(userId, patch) {
  const current = getPrefs(userId);
  const merged = { ...current, ...patch };
  db.prepare(`
    UPDATE user_signal_prefs SET
      enabled_strategies = ?, watched_symbols = ?, blacklisted_symbols = ?,
      min_confidence = ?, min_rr = ?,
      timeframes = ?, directions = ?,
      notifications_web = ?, notifications_email = ?, notifications_telegram = ?,
      telegram_chat_id = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
  `).run(
    JSON.stringify(merged.enabledStrategies),
    JSON.stringify(merged.watchedSymbols),
    JSON.stringify(merged.blacklistedSymbols),
    merged.minConfidence,
    merged.minRr,
    JSON.stringify(merged.timeframes),
    JSON.stringify(merged.directions),
    merged.notificationsWeb ? 1 : 0,
    merged.notificationsEmail ? 1 : 0,
    merged.notificationsTelegram ? 1 : 0,
    merged.telegramChatId || null,
    userId
  );
  return getPrefs(userId);
}

function trackView(userId, signalId) {
  db.prepare(`INSERT INTO signal_views (user_id, signal_id) VALUES (?, ?)`)
    .run(userId, signalId);
}

function viewsToday(userId) {
  const row = db.prepare(`
    SELECT COUNT(*) as n FROM signal_views
    WHERE user_id = ? AND DATE(viewed_at) = DATE('now')
  `).get(userId);
  return row.n || 0;
}

function freeDailyLimitHit(userId, plan) {
  const limits = plans.getLimits(plan);
  if (limits.signalsPerDay === Infinity) return false;
  return viewsToday(userId) >= limits.signalsPerDay;
}

function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    botId: row.bot_id,
    exchange: row.exchange,
    symbol: row.symbol,
    strategy: row.strategy,
    timeframe: row.timeframe,
    side: row.side,
    entry: row.entry_price,
    stopLoss: row.stop_loss,
    tp1: row.take_profit_1,
    tp2: row.take_profit_2,
    tp3: row.take_profit_3,
    riskReward: row.risk_reward,
    confidence: row.confidence,
    quality: row.quality,
    reason: row.reason,
    metadata: safeJson(row.metadata, null),
    result: row.result,
    resultPrice: row.result_price,
    resultPnlPct: row.result_pnl_pct,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    closedAt: row.closed_at,
  };
}

function safeJson(str, fallback) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch (_e) { return fallback; }
}

module.exports = {
  insert,
  getById,
  listForUser,
  listPublic,
  stats,
  recordResult,
  getPrefs,
  updatePrefs,
  trackView,
  viewsToday,
  freeDailyLimitHit,
};
