const db = require('../models/database');

class BotService {
  // ── Create a new trading bot ────────────────────────────────────────
  createBot(userId, botData) {
    const {
      name,
      exchangeName,
      symbol,
      strategyType,
      leverage = 1,
      positionSizeUsd,
      stopLossPct,
      takeProfitPct,
      trailingStop = false,
      strategyConfig = '{}',
      timeframe = '1H',
      direction = 'both',
    } = botData;

    const stmt = db.prepare(`
      INSERT INTO trading_bots (
        user_id, name, exchange_name, symbol, strategy_type,
        leverage, position_size_usd, stop_loss_pct, take_profit_pct,
        trailing_stop, strategy_config, timeframe, direction
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      userId,
      name,
      exchangeName,
      symbol,
      strategyType,
      leverage,
      positionSizeUsd,
      stopLossPct || null,
      takeProfitPct || null,
      trailingStop ? 1 : 0,
      typeof strategyConfig === 'string' ? strategyConfig : JSON.stringify(strategyConfig),
      timeframe,
      direction
    );

    return this.getBotById(result.lastInsertRowid, userId);
  }

  // ── Get bot by ID ───────────────────────────────────────────────────
  getBotById(botId, userId) {
    const bot = db.prepare(`
      SELECT * FROM trading_bots
      WHERE id = ? AND user_id = ?
    `).get(botId, userId);

    if (!bot) return null;

    // Attach recent 5 matched signals
    try {
      bot.recent_signals = db.prepare(`
        SELECT * FROM signal_history
        WHERE symbol = ? AND strategy = ?
        ORDER BY created_at DESC
        LIMIT 5
      `).all(bot.symbol, bot.strategy_type);
    } catch (_) {
      bot.recent_signals = [];
    }

    // Attach trade summary
    try {
      const summary = db.prepare(`
        SELECT
          COUNT(*) as trade_count,
          COALESCE(SUM(CASE WHEN status = 'closed' THEN pnl ELSE 0 END), 0) as realized_pnl,
          COALESCE(SUM(CASE WHEN status = 'closed' AND pnl > 0 THEN 1 ELSE 0 END), 0) as winning,
          COALESCE(SUM(CASE WHEN status = 'closed' AND pnl <= 0 THEN 1 ELSE 0 END), 0) as losing
        FROM bot_trades WHERE bot_id = ?
      `).get(botId);
      bot.trade_summary = summary;
    } catch (_) {
      bot.trade_summary = { trade_count: 0, realized_pnl: 0, winning: 0, losing: 0 };
    }

    return bot;
  }

  // ── Get all bots for a user (with inline stats) ─────────────────────
  getUserBots(userId) {
    const bots = db.prepare(`
      SELECT * FROM trading_bots
      WHERE user_id = ?
      ORDER BY created_at DESC
    `).all(userId);

    // Enrich each bot with live stats
    for (const bot of bots) {
      try {
        const stats = db.prepare(`
          SELECT
            COUNT(*) as trade_count,
            COALESCE(SUM(CASE WHEN status = 'closed' THEN pnl ELSE 0 END), 0) as realized_pnl,
            COALESCE(SUM(CASE WHEN status = 'closed' AND pnl > 0 THEN 1 ELSE 0 END), 0) as winning,
            COALESCE(SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END), 0) as closed_count
          FROM bot_trades WHERE bot_id = ?
        `).get(bot.id);

        bot.total_trades = stats.trade_count || bot.total_trades || 0;
        bot.total_pnl = stats.realized_pnl || bot.total_pnl || 0;
        bot.win_rate = stats.closed_count > 0
          ? +((stats.winning / stats.closed_count) * 100).toFixed(1)
          : (bot.win_rate || 0);
      } catch (_) {
        // Use cached values from the table columns
      }

      // Count matched signals
      try {
        const sigCount = db.prepare(`
          SELECT COUNT(*) as cnt FROM signal_history
          WHERE symbol = ? AND strategy = ?
        `).get(bot.symbol, bot.strategy_type);
        bot.total_signals = sigCount.cnt || bot.total_signals || 0;
      } catch (_) {}

      // Last signal time
      try {
        const lastSig = db.prepare(`
          SELECT created_at FROM signal_history
          WHERE symbol = ? AND strategy = ?
          ORDER BY created_at DESC LIMIT 1
        `).get(bot.symbol, bot.strategy_type);
        bot.last_signal_at = lastSig ? lastSig.created_at : bot.last_signal_at;
      } catch (_) {}
    }

    return bots;
  }

  // ── Update bot ──────────────────────────────────────────────────────
  updateBot(botId, userId, updates) {
    const allowedFields = [
      'name', 'leverage', 'position_size_usd', 'stop_loss_pct',
      'take_profit_pct', 'trailing_stop', 'is_active',
      'strategy_config', 'timeframe', 'direction'
    ];
    const setClauses = [];
    const values = [];

    for (const [key, value] of Object.entries(updates)) {
      const dbKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
      if (allowedFields.includes(dbKey)) {
        setClauses.push(`${dbKey} = ?`);
        if (typeof value === 'boolean') {
          values.push(value ? 1 : 0);
        } else if (typeof value === 'object') {
          values.push(JSON.stringify(value));
        } else {
          values.push(value);
        }
      }
    }

    if (setClauses.length === 0) {
      throw new Error('No valid fields to update');
    }

    values.push(botId);
    values.push(userId);

    const stmt = db.prepare(`
      UPDATE trading_bots
      SET ${setClauses.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?
    `);

    stmt.run(...values);

    return this.getBotById(botId, userId);
  }

  // ── Delete bot ──────────────────────────────────────────────────────
  deleteBot(botId, userId) {
    const stmt = db.prepare(`
      DELETE FROM trading_bots
      WHERE id = ? AND user_id = ?
    `);
    const result = stmt.run(botId, userId);
    return result.changes > 0;
  }

  // ── Toggle bot active/inactive ──────────────────────────────────────
  toggleBot(botId, userId, isActive) {
    return this.updateBot(botId, userId, { isActive });
  }

  // ── Get trade history (enriched) ────────────────────────────────────
  getBotTrades(botId, userId) {
    const bot = this.getBotById(botId, userId);
    if (!bot) {
      throw new Error('Bot not found');
    }

    return db.prepare(`
      SELECT * FROM bot_trades
      WHERE bot_id = ?
      ORDER BY opened_at DESC
    `).all(botId);
  }

  // ── Get signals matched to this bot ─────────────────────────────────
  getBotSignals(botId, userId) {
    const bot = this.getBotById(botId, userId);
    if (!bot) {
      throw new Error('Bot not found');
    }

    return db.prepare(`
      SELECT * FROM signal_history
      WHERE symbol = ? AND strategy = ?
      ORDER BY created_at DESC
      LIMIT 50
    `).all(bot.symbol, bot.strategy_type);
  }

  // ── Record a signal matched to a bot ────────────────────────────────
  recordBotSignal(botId, signal) {
    const bot = db.prepare('SELECT * FROM trading_bots WHERE id = ?').get(botId);
    if (!bot) throw new Error('Bot not found');

    // Update cached stats
    db.prepare(`
      UPDATE trading_bots
      SET total_signals = total_signals + 1,
          last_signal_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(botId);

    return { success: true };
  }

  // ── Record a trade with full metadata ───────────────────────────────
  recordBotTrade(botId, trade) {
    const {
      tradeType,
      entryPrice,
      exitPrice,
      quantity,
      pnl,
      pnlPct,
      openedAt,
      closedAt,
      status = 'open',
      signalId,
      strategy,
      timeframe,
      stopLoss,
      takeProfit,
      result = '',
      durationSec,
      rrRatio,
    } = trade;

    const stmt = db.prepare(`
      INSERT INTO bot_trades (
        bot_id, trade_type, entry_price, exit_price, quantity,
        pnl, pnl_pct, opened_at, closed_at, status,
        signal_id, strategy, timeframe, stop_loss, take_profit,
        result, duration_sec, rr_ratio
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const res = stmt.run(
      botId, tradeType, entryPrice || null, exitPrice || null, quantity || null,
      pnl || null, pnlPct || null, openedAt || null, closedAt || null, status,
      signalId || null, strategy || null, timeframe || null,
      stopLoss || null, takeProfit || null, result, durationSec || null, rrRatio || null
    );

    // If trade is closed, update bot stats
    if (status === 'closed') {
      this.updateBotStats(botId);
    }

    return { id: res.lastInsertRowid };
  }

  // ── Recalculate and cache bot stats ─────────────────────────────────
  updateBotStats(botId) {
    const stats = db.prepare(`
      SELECT
        COUNT(*) as total_trades,
        COALESCE(SUM(CASE WHEN status = 'closed' THEN pnl ELSE 0 END), 0) as total_pnl,
        COALESCE(SUM(CASE WHEN status = 'closed' AND pnl > 0 THEN 1 ELSE 0 END), 0) as winning,
        COALESCE(SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END), 0) as closed_count
      FROM bot_trades WHERE bot_id = ?
    `).get(botId);

    const winRate = stats.closed_count > 0
      ? +((stats.winning / stats.closed_count) * 100).toFixed(1)
      : 0;

    db.prepare(`
      UPDATE trading_bots
      SET total_trades = ?, total_pnl = ?, win_rate = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(stats.total_trades, stats.total_pnl, winRate, botId);

    return { total_trades: stats.total_trades, total_pnl: stats.total_pnl, win_rate: winRate };
  }

  // ── Find active bots for a given symbol (used by scanner) ───────────
  getActiveBotsBySymbol(symbol) {
    return db.prepare(`
      SELECT * FROM trading_bots
      WHERE symbol = ? AND is_active = 1
      ORDER BY created_at DESC
    `).all(symbol);
  }

  // ── Get bot performance details ─────────────────────────────────────
  getBotPerformance(botId, userId) {
    const bot = this.getBotById(botId, userId);
    if (!bot) throw new Error('Bot not found');

    const trades = db.prepare(`
      SELECT * FROM bot_trades
      WHERE bot_id = ? AND status = 'closed'
      ORDER BY opened_at ASC
    `).all(botId);

    if (!trades.length) {
      return {
        total_trades: 0, winning_trades: 0, losing_trades: 0,
        win_rate: 0, total_pnl: 0, profit_factor: 0,
        avg_trade_duration: 0, max_drawdown: 0, sharpe_estimate: 0,
        avg_win: 0, avg_loss: 0, best_trade: 0, worst_trade: 0,
      };
    }

    let totalPnl = 0, grossProfit = 0, grossLoss = 0;
    let winCount = 0, loseCount = 0;
    let totalDuration = 0, durationCount = 0;
    let peak = 0, maxDD = 0, equity = 0;
    const returns = [];
    let bestTrade = -Infinity, worstTrade = Infinity;

    for (const t of trades) {
      const pnl = t.pnl || 0;
      totalPnl += pnl;
      equity += pnl;
      returns.push(pnl);

      if (pnl > 0) { grossProfit += pnl; winCount++; }
      else { grossLoss += Math.abs(pnl); loseCount++; }

      if (pnl > bestTrade) bestTrade = pnl;
      if (pnl < worstTrade) worstTrade = pnl;

      if (equity > peak) peak = equity;
      const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
      if (dd > maxDD) maxDD = dd;

      if (t.duration_sec) { totalDuration += t.duration_sec; durationCount++; }
    }

    const profitFactor = grossLoss > 0 ? +(grossProfit / grossLoss).toFixed(2) : grossProfit > 0 ? 999 : 0;
    const winRate = trades.length > 0 ? +((winCount / trades.length) * 100).toFixed(1) : 0;
    const avgDuration = durationCount > 0 ? Math.round(totalDuration / durationCount) : 0;

    // Sharpe estimate (simplified: mean/std of trade returns)
    const mean = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const variance = returns.length > 1
      ? returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1)
      : 0;
    const stdDev = Math.sqrt(variance);
    const sharpe = stdDev > 0 ? +(mean / stdDev).toFixed(2) : 0;

    return {
      total_trades: trades.length,
      winning_trades: winCount,
      losing_trades: loseCount,
      win_rate: winRate,
      total_pnl: +totalPnl.toFixed(2),
      profit_factor: profitFactor,
      avg_trade_duration: avgDuration,
      max_drawdown: +maxDD.toFixed(2),
      sharpe_estimate: sharpe,
      avg_win: winCount > 0 ? +(grossProfit / winCount).toFixed(2) : 0,
      avg_loss: loseCount > 0 ? +(grossLoss / loseCount).toFixed(2) : 0,
      best_trade: bestTrade === -Infinity ? 0 : +bestTrade.toFixed(2),
      worst_trade: worstTrade === Infinity ? 0 : +worstTrade.toFixed(2),
    };
  }

  // ── Aggregated stats across all user bots ───────────────────────────
  getUserBotsStats(userId) {
    const bots = this.getUserBots(userId);

    let totalBots = bots.length;
    let activeBots = bots.filter(b => b.is_active).length;
    let totalPnl = 0;
    let totalTrades = 0;

    for (const bot of bots) {
      totalTrades += bot.total_trades || 0;
      totalPnl += bot.total_pnl || 0;
    }

    return {
      totalBots,
      activeBots,
      totalTrades,
      totalPnl: totalPnl.toFixed(2),
    };
  }
}

module.exports = new BotService();
