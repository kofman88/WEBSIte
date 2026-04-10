const db = require('../models/database');

class BacktestService {
  // Создание задачи бэктеста
  createBacktest(userId, backtestData) {
    const {
      name,
      symbol,
      exchangeName,
      timeframe,
      startDate,
      endDate,
      initialCapital,
      strategyConfig,
    } = backtestData;

    const stmt = db.prepare(`
      INSERT INTO backtests (
        user_id, name, symbol, exchange_name, timeframe,
        start_date, end_date, initial_capital, strategy_config, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `);

    const result = stmt.run(
      userId,
      name,
      symbol,
      exchangeName,
      timeframe,
      startDate,
      endDate,
      initialCapital,
      JSON.stringify(strategyConfig || {})
    );

    // Запускаем бэктест в фоне (в реальном проекте - через очередь)
    this.runBacktestAsync(result.lastInsertRowid, userId);

    return this.getBacktestById(result.lastInsertRowid, userId);
  }

  // Получение бэктеста по ID
  getBacktestById(backtestId, userId) {
    return db.prepare(`
      SELECT * FROM backtests 
      WHERE id = ? AND user_id = ?
    `).get(backtestId, userId);
  }

  // Получение всех бэктестов пользователя
  getUserBacktests(userId) {
    return db.prepare(`
      SELECT * FROM backtests 
      WHERE user_id = ? 
      ORDER BY created_at DESC
    `).all(userId);
  }

  // Удаление бэктеста
  deleteBacktest(backtestId, userId) {
    const stmt = db.prepare(`
      DELETE FROM backtests 
      WHERE id = ? AND user_id = ?
    `);
    
    const result = stmt.run(backtestId, userId);
    return result.changes > 0;
  }

  // Асинхронный запуск бэктеста (упрощенная версия)
  async runBacktestAsync(backtestId, userId) {
    try {
      // Обновляем статус на "running"
      db.prepare(`
        UPDATE backtests SET status = 'running' 
        WHERE id = ? AND user_id = ?
      `).run(backtestId, userId);

      const backtest = this.getBacktestById(backtestId, userId);
      if (!backtest) return;

      // Здесь должна быть логика бэктеста из CHM_BREAKER_V4/backtest.py
      // Для примера возвращаем фейковые результаты
      await new Promise(resolve => setTimeout(resolve, 2000)); // Имитация задержки

      const mockResults = {
        totalTrades: Math.floor(Math.random() * 50) + 10,
        winningTrades: Math.floor(Math.random() * 30) + 5,
        losingTrades: Math.floor(Math.random() * 20),
        winRate: (Math.random() * 0.3 + 0.45).toFixed(2), // 45-75%
        totalPnl: (Math.random() * 2000 - 500).toFixed(2),
        totalPnlPct: (Math.random() * 50 - 10).toFixed(2),
        maxDrawdown: (Math.random() * 20).toFixed(2),
        profitFactor: (Math.random() * 2 + 0.5).toFixed(2),
        avgWin: (Math.random() * 200).toFixed(2),
        avgLoss: (Math.random() * 100).toFixed(2),
        sharpeRatio: (Math.random() * 2).toFixed(2),
      };

      // Сохраняем результаты
      db.prepare(`
        UPDATE backtests 
        SET status = 'completed', results = ?, completed_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ?
      `).run(JSON.stringify(mockResults), backtestId, userId);

      console.log(`✅ Бэктест ${backtestId} завершен`);
    } catch (error) {
      console.error(`❌ Ошибка бэктеста ${backtestId}:`, error.message);
      db.prepare(`
        UPDATE backtests SET status = 'failed', results = ?
        WHERE id = ? AND user_id = ?
      `).run(JSON.stringify({ error: error.message }), backtestId, userId);
    }
  }

  // Статистика бэктестов пользователя
  getUserBacktestsStats(userId) {
    const backtests = this.getUserBacktests(userId);
    
    let total = backtests.length;
    let completed = backtests.filter(b => b.status === 'completed').length;
    let running = backtests.filter(b => b.status === 'running').length;
    let pending = backtests.filter(b => b.status === 'pending').length;
    let failed = backtests.filter(b => b.status === 'failed').length;

    return { total, completed, running, pending, failed };
  }
}

module.exports = new BacktestService();
