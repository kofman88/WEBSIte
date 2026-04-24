/**
 * Bot service — CRUD for trading_bots + per-bot statistics.
 * Rewritten for v3 schema (exchange, symbols JSON, strategy_config JSON).
 */

const db = require('../models/database');
const plans = require('../config/plans');
const logger = require('../utils/logger');

function _safeJson(s, fb) { if (!s) return fb; try { return JSON.parse(s); } catch { return fb; } }

// ── Market Scanner gate (Elite-only) ─────────────────────────────────
// Market-wide scan + multi-strategy combo are Elite features. A single
// helper keeps the rule in one place so create/update can both use it.
function _validateEliteFeatures(plan, bot) {
  const scope = bot.scope || 'pair';
  const multi = Array.isArray(bot.strategiesMulti) ? bot.strategiesMulti.filter(Boolean) : null;

  if (scope === 'market' && plan !== 'elite') {
    const err = new Error('Market scanner is available on Elite plan only.');
    err.statusCode = 403; err.code = 'UPGRADE_REQUIRED'; err.requiredPlan = 'elite';
    throw err;
  }
  if (multi && multi.length > 1 && plan !== 'elite') {
    const err = new Error('Multi-strategy combo is available on Elite plan only.');
    err.statusCode = 403; err.code = 'UPGRADE_REQUIRED'; err.requiredPlan = 'elite';
    throw err;
  }
  if (scope === 'market') {
    const exs = Array.isArray(bot.marketExchanges) ? bot.marketExchanges.filter(Boolean) : [];
    if (!exs.length) {
      const err = new Error('Market bot requires at least one exchange in marketExchanges.');
      err.statusCode = 400; err.code = 'VALIDATION_ERROR';
      throw err;
    }
  }
}

function createBot(userId, bot) {
  const planRow = db.prepare('SELECT plan FROM subscriptions WHERE user_id = ?').get(userId);
  const plan = (planRow && planRow.plan) || 'free';
  const limits = plans.getLimits(plan);

  const openCount = db.prepare('SELECT COUNT(*) as n FROM trading_bots WHERE user_id = ?').get(userId).n;
  if (limits.maxBots !== Infinity && openCount >= limits.maxBots) {
    const err = new Error(`Your plan allows ${limits.maxBots} bots. Upgrade for more.`);
    err.statusCode = 403; err.code = 'BOT_LIMIT_REACHED';
    throw err;
  }

  _validateEliteFeatures(plan, bot);

  if (!plans.canUseStrategy(plan, bot.strategy)) {
    const err = new Error(`Strategy "${bot.strategy}" requires a higher plan.`);
    err.statusCode = 403; err.code = 'UPGRADE_REQUIRED';
    err.requiredPlan = plans.requiredPlanForStrategy(bot.strategy);
    throw err;
  }

  if (bot.autoTrade && !plans.canUseFeature(plan, 'autoTrade')) {
    const err = new Error('Auto-trade requires Pro plan.');
    err.statusCode = 403; err.code = 'UPGRADE_REQUIRED'; err.requiredPlan = 'pro';
    throw err;
  }

  const leverage = Math.min(bot.leverage || 1, limits.maxLeverage || 5);
  const tradingMode = plans.canUseFeature(plan, 'paperTradingOnly')
    ? 'paper'
    : (bot.tradingMode || 'paper');

  const scope = bot.scope === 'market' ? 'market' : 'pair';
  const marketExchanges = scope === 'market' ? JSON.stringify(bot.marketExchanges || []) : null;
  const strategiesMulti = Array.isArray(bot.strategiesMulti) && bot.strategiesMulti.length > 0
    ? JSON.stringify(bot.strategiesMulti)
    : null;

  const info = db.prepare(`
    INSERT INTO trading_bots
      (user_id, name, exchange, exchange_key_id, symbols, strategy, timeframe,
       direction, leverage, risk_pct, max_open_trades, auto_trade, trading_mode,
       strategy_config, risk_config, is_active,
       scope, market_exchanges, strategies_multi)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `).run(
    userId, bot.name, bot.exchange, bot.exchangeKeyId || null,
    JSON.stringify(bot.symbols || []), bot.strategy, bot.timeframe,
    bot.direction || 'both', leverage, bot.riskPct || 1,
    bot.maxOpenTrades || 3, bot.autoTrade ? 1 : 0, tradingMode,
    JSON.stringify(bot.strategyConfig || {}),
    JSON.stringify(bot.riskConfig || {}),
    scope, marketExchanges, strategiesMulti
  );

  db.prepare(`
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
    VALUES (?, 'bot.create', 'bot', ?, ?)
  `).run(userId, info.lastInsertRowid, JSON.stringify({
    strategy: bot.strategy, tradingMode, scope,
    ...(scope === 'market' ? { marketExchanges: bot.marketExchanges, strategiesMulti: bot.strategiesMulti || null } : {}),
  }));

  return getBot(info.lastInsertRowid, userId);
}

function updateBot(botId, userId, patch) {
  const existing = getBot(botId, userId);
  if (!existing) { const err = new Error('Bot not found'); err.statusCode = 404; throw err; }

  const planRow = db.prepare('SELECT plan FROM subscriptions WHERE user_id = ?').get(userId);
  const plan = (planRow && planRow.plan) || 'free';

  if (patch.strategy && !plans.canUseStrategy(plan, patch.strategy)) {
    const err = new Error(`Strategy "${patch.strategy}" requires a higher plan.`);
    err.statusCode = 403; err.code = 'UPGRADE_REQUIRED';
    err.requiredPlan = plans.requiredPlanForStrategy(patch.strategy);
    throw err;
  }
  if (patch.autoTrade && !plans.canUseFeature(plan, 'autoTrade')) {
    const err = new Error('Auto-trade requires Pro plan.');
    err.statusCode = 403; err.code = 'UPGRADE_REQUIRED'; err.requiredPlan = 'pro';
    throw err;
  }

  // Elite-only feature gate on updates (scope/strategies_multi changes)
  if (patch.scope !== undefined || patch.strategiesMulti !== undefined || patch.marketExchanges !== undefined) {
    _validateEliteFeatures(plan, {
      scope:           patch.scope           !== undefined ? patch.scope           : existing.scope,
      strategiesMulti: patch.strategiesMulti !== undefined ? patch.strategiesMulti : existing.strategiesMulti,
      marketExchanges: patch.marketExchanges !== undefined ? patch.marketExchanges : existing.marketExchanges,
    });
  }

  const fields = [];
  const values = [];
  const mapping = {
    name: 'name', exchange: 'exchange', exchangeKeyId: 'exchange_key_id',
    strategy: 'strategy', timeframe: 'timeframe', direction: 'direction',
    leverage: 'leverage', riskPct: 'risk_pct', maxOpenTrades: 'max_open_trades',
    autoTrade: 'auto_trade', tradingMode: 'trading_mode',
    scope: 'scope',
  };
  for (const [k, col] of Object.entries(mapping)) {
    if (patch[k] !== undefined) {
      fields.push(`${col} = ?`);
      values.push(k === 'autoTrade' ? (patch[k] ? 1 : 0) : patch[k]);
    }
  }
  if (patch.symbols !== undefined)         { fields.push('symbols = ?');         values.push(JSON.stringify(patch.symbols)); }
  if (patch.strategyConfig !== undefined)  { fields.push('strategy_config = ?'); values.push(JSON.stringify(patch.strategyConfig)); }
  if (patch.marketExchanges !== undefined) { fields.push('market_exchanges = ?'); values.push(JSON.stringify(patch.marketExchanges || [])); }
  if (patch.strategiesMulti !== undefined) {
    fields.push('strategies_multi = ?');
    values.push(Array.isArray(patch.strategiesMulti) && patch.strategiesMulti.length > 0 ? JSON.stringify(patch.strategiesMulti) : null);
  }
  if (patch.riskConfig !== undefined)      { fields.push('risk_config = ?');     values.push(JSON.stringify(patch.riskConfig)); }

  if (!fields.length) return existing;
  fields.push('updated_at = CURRENT_TIMESTAMP');

  db.prepare(`UPDATE trading_bots SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`)
    .run(...values, botId, userId);

  db.prepare(`
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
    VALUES (?, 'bot.update', 'bot', ?, ?)
  `).run(userId, botId, JSON.stringify(patch));

  return getBot(botId, userId);
}

function toggleActive(botId, userId) {
  const existing = getBot(botId, userId);
  if (!existing) { const err = new Error('Bot not found'); err.statusCode = 404; throw err; }
  const newVal = existing.isActive ? 0 : 1;

  // When turning a bot ON, enforce plan entitlements: valid subscription +
  // active-bot limit. This closes the gap where users could keep trading
  // after downgrade / expiry by toggling bots back on.
  if (newVal === 1) {
    const plans = require('../config/plans');
    const sub = db.prepare('SELECT plan, expires_at FROM subscriptions WHERE user_id = ?').get(userId);
    const plan = (sub && sub.plan) || 'free';
    if (sub && sub.expires_at && new Date(sub.expires_at).getTime() < Date.now() && plan !== 'free') {
      const err = new Error('Subscription expired — renew to enable bots');
      err.statusCode = 402; err.code = 'SUBSCRIPTION_EXPIRED';
      throw err;
    }
    const limits = plans.getLimits(plan);
    if (limits.maxBots !== Infinity) {
      const activeCount = db.prepare('SELECT COUNT(*) as n FROM trading_bots WHERE user_id = ? AND is_active = 1')
        .get(userId).n;
      if (activeCount >= limits.maxBots) {
        const err = new Error('Active-bot limit reached for current plan (' + plan + ')');
        err.statusCode = 403; err.code = 'BOT_LIMIT';
        throw err;
      }
    }
  }

  db.prepare('UPDATE trading_bots SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')
    .run(newVal, botId, userId);

  db.prepare(`
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
    VALUES (?, 'bot.toggle', 'bot', ?, ?)
  `).run(userId, botId, JSON.stringify({ active: !!newVal }));

  return getBot(botId, userId);
}

function deleteBot(botId, userId) {
  const openLive = db.prepare(`
    SELECT COUNT(*) as n FROM trades
    WHERE bot_id = ? AND status = 'open' AND trading_mode = 'live'
  `).get(botId).n;
  if (openLive > 0) {
    const err = new Error('Close open live trades before deleting the bot');
    err.statusCode = 400; err.code = 'BOT_HAS_OPEN_TRADES';
    throw err;
  }

  const info = db.prepare('DELETE FROM trading_bots WHERE id = ? AND user_id = ?').run(botId, userId);
  if (info.changes === 0) {
    const err = new Error('Bot not found'); err.statusCode = 404; throw err;
  }
  db.prepare(`DELETE FROM system_kv WHERE key = ?`).run('paper_equity:bot:' + botId);

  db.prepare(`
    INSERT INTO audit_log (user_id, action, entity_type, entity_id)
    VALUES (?, 'bot.delete', 'bot', ?)
  `).run(userId, botId);

  return { deleted: true };
}

function getBot(botId, userId) {
  const row = db.prepare('SELECT * FROM trading_bots WHERE id = ? AND user_id = ?').get(botId, userId);
  return row ? hydrate(row) : null;
}

function listForUser(userId) {
  const rows = db.prepare(`
    SELECT * FROM trading_bots WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(userId);
  return rows.map(hydrate);
}

function getBotTrades(botId, userId, { limit = 100, offset = 0, status = null } = {}) {
  const bot = getBot(botId, userId);
  if (!bot) return null;
  const parts = ['bot_id = ?'];
  const params = [botId];
  if (status) { parts.push('status = ?'); params.push(status); }
  return db.prepare(`
    SELECT * FROM trades WHERE ${parts.join(' AND ')}
    ORDER BY opened_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
}

function getBotStats(botId, userId) {
  const bot = getBot(botId, userId);
  if (!bot) return null;
  const s = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open,
      SUM(CASE WHEN status = 'closed' AND realized_pnl > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN status = 'closed' AND realized_pnl < 0 THEN 1 ELSE 0 END) as losses,
      COALESCE(SUM(realized_pnl), 0) as total_pnl,
      COALESCE(AVG(realized_pnl_pct), 0) as avg_pnl_pct,
      COALESCE(SUM(CASE WHEN realized_pnl > 0 THEN realized_pnl ELSE 0 END), 0) as gross_profit,
      COALESCE(SUM(CASE WHEN realized_pnl < 0 THEN -realized_pnl ELSE 0 END), 0) as gross_loss
    FROM trades WHERE bot_id = ?
  `).get(botId);
  const closed = (s.wins || 0) + (s.losses || 0);
  const profitFactor = s.gross_loss > 0 ? s.gross_profit / s.gross_loss : null;

  // Sharpe-ish ratio + max drawdown from the equity curve below.
  const eq = _equitySeries(botId);
  const pnlSeries = eq.map((p) => p.pnl);
  let sharpe = null;
  if (pnlSeries.length >= 2) {
    const n = pnlSeries.length;
    // Returns = diff of cumulative pnl
    const rets = [];
    for (let i = 1; i < n; i++) rets.push(pnlSeries[i] - pnlSeries[i - 1]);
    const mean = rets.reduce((a, v) => a + v, 0) / rets.length;
    const variance = rets.reduce((a, v) => a + (v - mean) ** 2, 0) / rets.length;
    const std = Math.sqrt(variance);
    sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : null;   // annualised (252 trade-days)
  }
  let maxDd = 0;
  let peak = 0;
  for (const p of pnlSeries) {
    if (p > peak) peak = p;
    const dd = peak - p;
    if (dd > maxDd) maxDd = dd;
  }

  const paperStart = 10_000;
  const roiPct = (s.total_pnl / paperStart) * 100;

  return {
    botId,
    totalTrades: s.total || 0,
    openTrades: s.open || 0,
    wins: s.wins || 0,
    losses: s.losses || 0,
    winRate: closed > 0 ? (s.wins / closed) : null,
    totalPnl: s.total_pnl || 0,
    avgPnlPct: s.avg_pnl_pct || 0,
    profitFactor,
    sharpe,
    maxDrawdown: maxDd,
    roiPct,
  };
}

// Build a cumulative-PnL time series from closed trades for a bot. Used
// for card sparkline + detail-drawer equity chart. Downsamples to at
// most `maxPoints` data points by sampling evenly.
function getBotEquity(botId, userId, { maxPoints = 120 } = {}) {
  const bot = getBot(botId, userId);
  if (!bot) return null;
  const full = _equitySeries(botId);
  if (full.length <= maxPoints) return { botId, points: full };
  const step = Math.ceil(full.length / maxPoints);
  const sampled = full.filter((_p, i) => i % step === 0 || i === full.length - 1);
  return { botId, points: sampled };
}

function _equitySeries(botId) {
  const trades = db.prepare(`
    SELECT closed_at, realized_pnl
    FROM trades
    WHERE bot_id = ? AND status = 'closed' AND closed_at IS NOT NULL
    ORDER BY closed_at ASC
  `).all(botId);
  const out = [];
  let cum = 0;
  for (const t of trades) {
    cum += Number(t.realized_pnl) || 0;
    out.push({ at: t.closed_at, pnl: cum });
  }
  return out;
}

function userSummary(userId) {
  const row = db.prepare(`
    SELECT
      COUNT(*) as total_bots,
      SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active_bots
    FROM trading_bots WHERE user_id = ?
  `).get(userId);

  const trades = db.prepare(`
    SELECT
      COUNT(*) as total_trades,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open_trades,
      COALESCE(SUM(CASE WHEN status = 'closed' THEN realized_pnl ELSE 0 END), 0) as total_pnl
    FROM trades WHERE user_id = ?
  `).get(userId);

  return {
    totalBots: row.total_bots || 0,
    activeBots: row.active_bots || 0,
    totalTrades: trades.total_trades || 0,
    openTrades: trades.open_trades || 0,
    totalPnl: trades.total_pnl || 0,
  };
}

function hydrate(r) {
  if (!r) return null;
  const parseJson = (s, fb) => { if (!s) return fb; try { return JSON.parse(s); } catch { return fb; } };
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    exchange: r.exchange,
    exchangeKeyId: r.exchange_key_id,
    symbols: parseJson(r.symbols, []),
    strategy: r.strategy,
    timeframe: r.timeframe,
    direction: r.direction,
    leverage: r.leverage,
    riskPct: r.risk_pct,
    maxOpenTrades: r.max_open_trades,
    autoTrade: Boolean(r.auto_trade),
    tradingMode: r.trading_mode,
    strategyConfig: parseJson(r.strategy_config, null),
    riskConfig: parseJson(r.risk_config, null),
    scope: r.scope || 'pair',
    marketExchanges: parseJson(r.market_exchanges, null),
    strategiesMulti: parseJson(r.strategies_multi, null),
    isActive: Boolean(r.is_active),
    lastRunAt: r.last_run_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

module.exports = {
  createBot,
  updateBot,
  toggleActive,
  deleteBot,
  getBot,
  listForUser,
  getBotTrades,
  getBotStats,
  getBotEquity,
  userSummary,
  _validateEliteFeatures, // exposed for tests
};
