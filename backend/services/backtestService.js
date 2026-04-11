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

      // Fetch real candle data from OKX (single fast request)
      const { fetchCandles } = require('./scannerEngine');
      const candles = await fetchCandles(backtest.symbol, backtest.timeframe || '1H', 300);

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
   * Backtest simulation with strategy-specific logic.
   * Each strategy has unique entry/exit rules.
   */
  _runSimulation(candles, config) {
    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const volumes = candles.map(c => c.volume);
    const capital = config.initial_capital || 10000;
    const riskPct = 0.02;

    // Detect strategy from strategy_config or name
    let strategy = 'levels';
    try {
      const sc = JSON.parse(config.strategy_config || '{}');
      if (sc.strategy) strategy = sc.strategy;
    } catch (_) {}
    if (strategy === 'levels') {
      // Fallback: parse from name
      const name = (config.name || '').toLowerCase();
      if (name.includes('scalp')) strategy = 'scalping';
      else if (name.includes('smc')) strategy = 'smc';
      else if (name.includes('gerchik')) strategy = 'gerchik';
    }
    console.log(`[BACKTEST] Strategy: ${strategy}, Symbol: ${config.symbol}, TF: ${config.timeframe}`);

    // ── Indicators ──
    const ema = (data, period) => {
      const k = 2 / (period + 1), r = [data[0]];
      for (let i = 1; i < data.length; i++) r.push(data[i] * k + r[i - 1] * (1 - k));
      return r;
    };

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

    const atrCalc = (c, period = 14) => {
      const trs = [];
      for (let i = 1; i < c.length; i++) {
        trs.push(Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i-1].close), Math.abs(c[i].low - c[i-1].close)));
      }
      return ema(trs, period);
    };

    const macdCalc = (data) => {
      const f = ema(data, 12), s = ema(data, 26);
      const m = f.map((v, i) => v - s[i]);
      const sig = ema(m, 9);
      return { line: m, signal: sig, hist: m.map((v, i) => v - sig[i]) };
    };

    const volMA = ema(volumes, 20);
    const rsi = rsiCalc(closes);
    const atr = atrCalc(candles);

    const trades = [];
    let inTrade = false, entryPrice = 0, slPrice = 0, tpPrice = 0, direction = '';
    let balance = capital, maxBal = capital, maxDD = 0;

    const startIdx = 30;

    for (let i = startIdx; i < candles.length - 1; i++) {
      const c = candles[i], price = closes[i];

      if (!inTrade) {
        let signal = null;

        // ── LEVELS: Pivot-based support/resistance ──
        if (strategy === 'levels') {
          const pivotStr = 5;
          let isSupport = true, isResist = true;
          for (let j = 1; j <= pivotStr && i - j >= 0 && i + j < candles.length; j++) {
            if (lows[i - j] <= lows[i] || lows[i + j] <= lows[i]) isSupport = false;
            if (highs[i - j] >= highs[i] || highs[i + j] >= highs[i]) isResist = false;
          }
          if (rsi[i] < 35 && price < ema(closes, 50)[i]) {
            signal = { dir: 'long', sl: price - atr[i-1] * 2, tp: price + atr[i-1] * 3 };
          } else if (rsi[i] > 65 && price > ema(closes, 50)[i]) {
            signal = { dir: 'short', sl: price + atr[i-1] * 2, tp: price - atr[i-1] * 3 };
          }
        }

        // ── SMC: Order Block + Liquidity Sweep ──
        else if (strategy === 'smc') {
          // Look for large candle (OB) in recent bars
          for (let j = i - 8; j < i - 2 && j >= startIdx; j++) {
            const body = Math.abs(candles[j].close - candles[j].open);
            const avgBody = candles.slice(Math.max(0, j - 10), j).reduce((s, x) => s + Math.abs(x.close - x.open), 0) / 10;
            if (body > avgBody * 2.5) {
              const isBullOB = candles[j].close > candles[j].open;
              // Check if price returned to OB zone
              if (isBullOB && price <= candles[j].close && price >= candles[j].open && rsi[i] < 45) {
                signal = { dir: 'long', sl: candles[j].low - atr[i-1] * 0.5, tp: price + (price - candles[j].low) * 2.5 };
                break;
              } else if (!isBullOB && price >= candles[j].close && price <= candles[j].open && rsi[i] > 55) {
                signal = { dir: 'short', sl: candles[j].high + atr[i-1] * 0.5, tp: price - (candles[j].high - price) * 2.5 };
                break;
              }
            }
          }
        }

        // ── GERCHIK: Strong level bounce with confirmation ──
        else if (strategy === 'gerchik') {
          // Find levels with 3+ touches in last 50 bars
          const window = candles.slice(Math.max(0, i - 50), i);
          const zones = {};
          window.forEach(bar => {
            const key = Math.round(bar.low / (atr[i-1] || 1)) * (atr[i-1] || 1);
            zones[key] = (zones[key] || 0) + 1;
          });
          const strongLevels = Object.entries(zones).filter(([, cnt]) => cnt >= 3).map(([p]) => +p);

          for (const level of strongLevels) {
            const dist = Math.abs(price - level) / price * 100;
            if (dist < 1.0) {
              // Bounce confirmation: current candle has long wick
              const wick = price > level ? (c.low < level ? c.close - c.low : 0) : (c.high > level ? c.high - c.close : 0);
              if (wick > Math.abs(c.close - c.open) * 0.5) {
                if (price > level && rsi[i] < 50) {
                  signal = { dir: 'long', sl: level - atr[i-1], tp: price + atr[i-1] * 4 };
                } else if (price < level && rsi[i] > 50) {
                  signal = { dir: 'short', sl: level + atr[i-1], tp: price - atr[i-1] * 4 };
                }
              }
            }
          }
        }

        // ── SCALPING: MACD + RSI + Volume ──
        else if (strategy === 'scalping') {
          const m = macdCalc(closes);
          const prevHist = m.hist[i - 1], currHist = m.hist[i];
          const volSpike = volumes[i] > volMA[i] * 1.2;

          if (prevHist < 0 && currHist > 0 && rsi[i] < 45 && volSpike) {
            signal = { dir: 'long', sl: price - atr[i-1] * 1.5, tp: price + atr[i-1] * 2 };
          } else if (prevHist > 0 && currHist < 0 && rsi[i] > 55 && volSpike) {
            signal = { dir: 'short', sl: price + atr[i-1] * 1.5, tp: price - atr[i-1] * 2 };
          }
        }

        if (signal) {
          inTrade = true;
          entryPrice = price;
          direction = signal.dir;
          slPrice = signal.sl;
          tpPrice = signal.tp;
        }
      } else {
        // Check SL/TP
        const hit_sl = direction === 'long' ? lows[i] <= slPrice : highs[i] >= slPrice;
        const hit_tp = direction === 'long' ? highs[i] >= tpPrice : lows[i] <= tpPrice;

        if (hit_sl || hit_tp) {
          const exitPrice = hit_sl ? slPrice : tpPrice;
          const pnlPct = direction === 'long'
            ? (exitPrice - entryPrice) / entryPrice * 100
            : (entryPrice - exitPrice) / entryPrice * 100;
          const pnl = balance * riskPct * (pnlPct / Math.abs((entryPrice - slPrice) / entryPrice * 100));
          balance += pnl;
          maxBal = Math.max(maxBal, balance);
          maxDD = Math.max(maxDD, (maxBal - balance) / maxBal * 100);
          trades.push({ dir: direction, entry: entryPrice, exit: exitPrice, pnl: +pnl.toFixed(2), pnlPct: +pnlPct.toFixed(2), result: hit_tp ? 'win' : 'loss' });
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
      strategy,
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
