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

      // Fetch real candle data from OKX
      const { fetchCandles } = require('./scannerEngine');
      const candles = await fetchCandles(backtest.symbol, backtest.timeframe || '1H', 500);

      if (!candles || candles.length < 30) {
        throw new Error('Not enough candle data for backtest');
      }

      // Run simple backtest simulation
      const results = this._runSimulation(candles, backtest);

      // Save results
      db.prepare(`
        UPDATE backtests
        SET status = 'completed', results = ?, completed_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ?
      `).run(JSON.stringify(results), backtestId, userId);

      console.log(`✅ Бэктест ${backtestId} завершен`);
    } catch (error) {
      console.error(`❌ Ошибка бэктеста ${backtestId}:`, error.message);
      db.prepare(`
        UPDATE backtests SET status = 'failed', results = ?
        WHERE id = ? AND user_id = ?
      `).run(JSON.stringify({ error: error.message }), backtestId, userId);
    }
  }

  /**
   * Simple backtest simulation on real candle data.
   * Uses EMA crossover + RSI filter — works for any strategy type.
   */
  _runSimulation(candles, config) {
    const closes = candles.map(c => c.close);
    const capital = config.initial_capital || 10000;
    const riskPct = 0.02; // 2% risk per trade

    // Calculate EMA
    const ema = (data, period) => {
      const k = 2 / (period + 1);
      const r = [data[0]];
      for (let i = 1; i < data.length; i++) r.push(data[i] * k + r[i - 1] * (1 - k));
      return r;
    };

    // Calculate RSI
    const rsiCalc = (data, period = 14) => {
      const r = Array(period).fill(50);
      let ag = 0, al = 0;
      for (let i = 1; i <= period; i++) { const d = data[i] - data[i - 1]; if (d > 0) ag += d; else al -= d; }
      ag /= period; al /= period;
      r.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
      for (let i = period + 1; i < data.length; i++) {
        const d = data[i] - data[i - 1];
        ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
        al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
        r.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
      }
      return r;
    };

    const emaFast = ema(closes, 9);
    const emaSlow = ema(closes, 21);
    const rsi = rsiCalc(closes, 14);

    const trades = [];
    let inTrade = false, entryPrice = 0, direction = '', balance = capital, maxBal = capital, maxDD = 0;

    for (let i = 22; i < candles.length - 1; i++) {
      if (!inTrade) {
        // Entry: EMA cross + RSI filter
        if (emaFast[i] > emaSlow[i] && emaFast[i - 1] <= emaSlow[i - 1] && rsi[i] < 65) {
          inTrade = true; entryPrice = closes[i]; direction = 'long';
        } else if (emaFast[i] < emaSlow[i] && emaFast[i - 1] >= emaSlow[i - 1] && rsi[i] > 35) {
          inTrade = true; entryPrice = closes[i]; direction = 'short';
        }
      } else {
        // Exit: opposite cross or 3% SL or 5% TP
        const pnlPct = direction === 'long'
          ? (closes[i] - entryPrice) / entryPrice * 100
          : (entryPrice - closes[i]) / entryPrice * 100;

        const exit = pnlPct <= -3 || pnlPct >= 5 ||
          (direction === 'long' && emaFast[i] < emaSlow[i]) ||
          (direction === 'short' && emaFast[i] > emaSlow[i]);

        if (exit) {
          const pnl = balance * riskPct * (pnlPct / 3); // normalized by SL
          balance += pnl;
          maxBal = Math.max(maxBal, balance);
          const dd = (maxBal - balance) / maxBal * 100;
          maxDD = Math.max(maxDD, dd);
          trades.push({ dir: direction, entry: entryPrice, exit: closes[i], pnl: +pnl.toFixed(2), pnlPct: +pnlPct.toFixed(2) });
          inTrade = false;
        }
      }
    }

    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

    return {
      totalTrades: trades.length,
      winningTrades: wins.length,
      losingTrades: losses.length,
      winRate: trades.length ? +(wins.length / trades.length * 100).toFixed(1) : 0,
      totalPnl: +totalPnl.toFixed(2),
      totalPnlPct: +((balance - capital) / capital * 100).toFixed(2),
      maxDrawdown: +maxDD.toFixed(2),
      profitFactor: grossLoss > 0 ? +(grossProfit / grossLoss).toFixed(2) : grossProfit > 0 ? 99 : 0,
      sharpeRatio: trades.length > 1 ? +((totalPnl / trades.length) / (Math.sqrt(trades.reduce((s, t) => s + Math.pow(t.pnl - totalPnl / trades.length, 2), 0) / trades.length) || 1)).toFixed(2) : 0,
      avgWin: wins.length ? +(grossProfit / wins.length).toFixed(2) : 0,
      avgLoss: losses.length ? +(grossLoss / losses.length).toFixed(2) : 0,
      finalBalance: +balance.toFixed(2),
    };
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
