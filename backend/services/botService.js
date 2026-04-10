const db = require('../models/database');

class BotService {
  // Создание нового торгового бота
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
    } = botData;

    const stmt = db.prepare(`
      INSERT INTO trading_bots (
        user_id, name, exchange_name, symbol, strategy_type,
        leverage, position_size_usd, stop_loss_pct, take_profit_pct, trailing_stop
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      trailingStop ? 1 : 0
    );

    return this.getBotById(result.lastInsertRowid, userId);
  }

  // Получение бота по ID
  getBotById(botId, userId) {
    return db.prepare(`
      SELECT * FROM trading_bots 
      WHERE id = ? AND user_id = ?
    `).get(botId, userId);
  }

  // Получение всех ботов пользователя
  getUserBots(userId) {
    return db.prepare(`
      SELECT * FROM trading_bots 
      WHERE user_id = ? 
      ORDER BY created_at DESC
    `).all(userId);
  }

  // Обновление бота
  updateBot(botId, userId, updates) {
    const allowedFields = ['name', 'leverage', 'position_size_usd', 'stop_loss_pct', 'take_profit_pct', 'trailing_stop', 'is_active'];
    const setClauses = [];
    const values = [];

    for (const [key, value] of Object.entries(updates)) {
      const dbKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
      if (allowedFields.includes(dbKey)) {
        setClauses.push(`${dbKey} = ?`);
        values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
      }
    }

    if (setClauses.length === 0) {
      throw new Error('Нет допустимых полей для обновления');
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

  // Удаление бота
  deleteBot(botId, userId) {
    const stmt = db.prepare(`
      DELETE FROM trading_bots 
      WHERE id = ? AND user_id = ?
    `);
    
    const result = stmt.run(botId, userId);
    return result.changes > 0;
  }

  // Активация/деактивация бота
  toggleBot(botId, userId, isActive) {
    return this.updateBot(botId, userId, { isActive });
  }

  // Получение истории сделок бота
  getBotTrades(botId, userId) {
    const bot = this.getBotById(botId, userId);
    if (!bot) {
      throw new Error('Бот не найден');
    }

    return db.prepare(`
      SELECT * FROM bot_trades 
      WHERE bot_id = ? 
      ORDER BY opened_at DESC
    `).all(botId);
  }

  // Статистика по ботам пользователя
  getUserBotsStats(userId) {
    const bots = this.getUserBots(userId);
    
    let totalBots = bots.length;
    let activeBots = bots.filter(b => b.is_active).length;
    let totalPnl = 0;
    let totalTrades = 0;

    for (const bot of bots) {
      const trades = db.prepare(`
        SELECT pnl FROM bot_trades WHERE bot_id = ? AND status = 'closed'
      `).all(bot.id);

      totalTrades += trades.length;
      totalPnl += trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
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
