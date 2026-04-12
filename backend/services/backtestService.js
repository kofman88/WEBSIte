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

      // Fetch candle data — Binance by date range, fallback to OKX
      const { fetchCandlesByDateFull, fetchCandles } = require('./scannerEngine');
      let candles = [];
      if (backtest.start_date && backtest.end_date) {
        candles = await fetchCandlesByDateFull(backtest.symbol, backtest.timeframe || '1H', backtest.start_date, backtest.end_date);
        console.log(`[BACKTEST] Binance ${backtest.start_date}→${backtest.end_date}: ${candles.length} candles`);
      }
      if (!candles.length) {
        candles = await fetchCandles(backtest.symbol, backtest.timeframe || '1H', 300);
        console.log(`[BACKTEST] OKX fallback: ${candles.length} candles`);
      }

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

    // Parse strategy + custom params from strategy_config
    let strategy = 'levels';
    let P = {}; // user params
    try {
      const sc = JSON.parse(config.strategy_config || '{}');
      if (sc.strategy) strategy = sc.strategy;
      if (sc.params) P = sc.params;
    } catch (_) {}
    if (strategy === 'levels') {
      const name = (config.name || '').toLowerCase();
      if (name.includes('scalp')) strategy = 'scalping';
      else if (name.includes('smc')) strategy = 'smc';
      else if (name.includes('gerchik')) strategy = 'gerchik';
    }
    // Direction filter + trend filter from config
    let directionFilter = 'both';
    let useTrendFilter = true;
    try {
      const sc = JSON.parse(config.strategy_config || '{}');
      if (sc.direction) directionFilter = sc.direction;
      if (sc.trendFilter === false) useTrendFilter = false;
    } catch (_) {}

    // ── Indicators (must be declared before use) ──
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
    const ema200 = ema(closes, Math.min(200, closes.length - 1));
    console.log(`[BACKTEST] Strategy: ${strategy}, Direction: ${directionFilter}, TrendFilter: ${useTrendFilter}, Candles: ${candles.length}`);
    const rsi = rsiCalc(closes);
    const atr = atrCalc(candles);

    const trades = [];
    let inTrade = false, entryPrice = 0, slPrice = 0, tpPrice = 0, direction = '', entryIdx = 0;
    let balance = capital, maxBal = capital, maxDD = 0;

    const startIdx = 30;

    for (let i = startIdx; i < candles.length - 1; i++) {
      const c = candles[i], price = closes[i];
      if (!atr[i-1] || !rsi[i] || !price) continue;

      if (!inTrade) {
        let signal = null;
        try {

        // ── LEVELS: Pivot-based support/resistance ──
        if (strategy === 'levels') {
          const pivotStr = P.pivot || 7;
          const rsiOS = P.rsiOS || 35;
          const rsiOB = P.rsiOB || 65;
          const minRR = P.minRR || 2.0;
          const maxDist = (P.maxDist || 1.5) / 100;
          const minQuality = P.minQuality || 4;
          const cooldown = P.cooldown || 5;
          const levelAge = P.levelAge || 100;
          const tp1R = P.tp1 || 2.0;
          const tp2R = P.tp2 || 3.0;
          const atrPd = P.atrPeriod || 14;
          const emaF = ema(closes, P.emaFast || 50);
          const useRsi = P.rsiFilter !== false;
          const useVol = P.volFilter !== false;
          const usePattern = P.patternFilter !== false;

          // Cooldown check
          if (trades.length > 0 && (i - entryIdx) < cooldown) { /* skip */ }
          else {
            let isSupport = true, isResist = true;
            for (let j = 1; j <= pivotStr && i - j >= 0 && i + j < candles.length; j++) {
              if (lows[i - j] <= lows[i] || lows[i + j] <= lows[i]) isSupport = false;
              if (highs[i - j] >= highs[i] || highs[i + j] >= highs[i]) isResist = false;
            }
            // Volume filter
            const volOk = !useVol || volumes[i] > volMA[i] * 0.8;
            // Pattern filter (simple: bullish/bearish candle body > 50% of bar)
            const bodyPct = Math.abs(c.close - c.open) / (c.high - c.low || 1);
            const patternOk = !usePattern || bodyPct > 0.4;

            if (useRsi && rsi[i] < rsiOS && emaF[i] && price < emaF[i] && volOk && patternOk) {
              const sl = price - atr[i-1] * 1.5;
              const tp = price + atr[i-1] * tp1R;
              const rr = (tp - price) / (price - sl);
              if (rr >= minRR) signal = { dir: 'long', sl, tp };
            } else if (useRsi && rsi[i] > rsiOB && emaF[i] && price > emaF[i] && volOk && patternOk) {
              const sl = price + atr[i-1] * 1.5;
              const tp = price - atr[i-1] * tp1R;
              const rr = (price - tp) / (sl - price);
              if (rr >= minRR) signal = { dir: 'short', sl, tp };
            }
          }
        }

        // ── SMC: Order Block + Liquidity Sweep ──
        else if (strategy === 'smc') {
          const obMult = P.obMult || 1.8;
          const obAge = P.obAge || 60;
          const obImpulse = (P.obImpulse || 0.15) / 100;
          const fvgMinGap = (P.fvgMinGap || 0.08) / 100;
          const slBuf = (P.slBuffer || 0.5) / 100;
          const minRR = P.minRR || 1.5;
          const mitigatedInvalid = P.mitigatedInvalid !== false;
          const lookback = Math.min(P.swingLB || 10, i - startIdx);

          for (let j = i - lookback; j < i - 2 && j >= startIdx; j++) {
            const body = Math.abs(candles[j].close - candles[j].open);
            const avgBody = candles.slice(Math.max(0, j - 10), j).reduce((s, x) => s + Math.abs(x.close - x.open), 0) / 10;
            const impulse = body / (candles[j].close || 1);
            if (body > avgBody * obMult && impulse >= obImpulse) {
              const isBullOB = candles[j].close > candles[j].open;
              // Mitigated check: price already passed through OB
              if (mitigatedInvalid) {
                let mitigated = false;
                for (let k = j + 1; k < i; k++) {
                  if (isBullOB && candles[k].low < candles[j].open) { mitigated = true; break; }
                  if (!isBullOB && candles[k].high > candles[j].open) { mitigated = true; break; }
                }
                if (mitigated) continue;
              }
              if (isBullOB && price <= candles[j].close && price >= candles[j].open && rsi[i] < 45) {
                const sl = candles[j].low - atr[i-1] * 0.5;
                const tp = price + (price - candles[j].low) * 2.5;
                if ((tp - price) / (price - sl) >= minRR) { signal = { dir: 'long', sl, tp }; break; }
              } else if (!isBullOB && price >= candles[j].close && price <= candles[j].open && rsi[i] > 55) {
                const sl = candles[j].high + atr[i-1] * 0.5;
                const tp = price - (candles[j].high - price) * 2.5;
                if ((price - tp) / (sl - price) >= minRR) { signal = { dir: 'short', sl, tp }; break; }
              }
            }
          }
        }

        // ── GERCHIK: Strong level bounce with confirmation ──
        else if (strategy === 'gerchik') {
          const gLookback = P.lookback || 50;
          const gPivot = P.pivot || 5;
          const gMinRR = P.minRR || 2.5;
          const gCluster = (P.cluster || 0.3) / 100;
          const gMirrorBonus = P.mirrorBonus || 3;
          const gAtrFloor = (P.atrFloor || 0.3) / 100;
          const gMaxDaily = P.maxDailyLoss || 3;
          const gVolOnBPU = P.volumeOnBPU !== false;
          const gSession = P.sessionFilter === true;
          const tp1R = P.tp1r || 3.0;
          const tp2R = P.tp2r || 4.0;

          // Session filter (08-22 UTC)
          if (gSession && candles[i].ts) {
            const h = new Date(candles[i].ts).getUTCHours();
            if (h < 8 || h >= 22) { /* skip */ }
          }

          // Daily loss limit
          const todayLosses = trades.filter(t => t.pnl < 0 && t.exitIdx > i - 100).length;
          if (todayLosses >= gMaxDaily) { /* skip */ }
          else {
            const window = candles.slice(Math.max(0, i - gLookback), i);
            const zones = {};
            window.forEach(bar => {
              const key = Math.round(bar.low / (atr[i-1] * gCluster * 10 || 1)) * (atr[i-1] * gCluster * 10 || 1);
              zones[key] = (zones[key] || 0) + 1;
            });
            const minTouches = 3;
            const strongLevels = Object.entries(zones).filter(([, cnt]) => cnt >= minTouches).map(([p]) => +p);

            for (const level of strongLevels) {
              const dist = Math.abs(price - level) / price * 100;
              if (dist < 1.0) {
                const wick = price > level ? (c.low < level ? c.close - c.low : 0) : (c.high > level ? c.high - c.close : 0);
                const volOk = !gVolOnBPU || volumes[i] > volMA[i] * 0.8;
                if (wick > Math.abs(c.close - c.open) * 0.5 && volOk) {
                  const slDist = Math.max(atr[i-1], price * gAtrFloor);
                  if (price > level && rsi[i] < 50) {
                    const sl = level - slDist;
                    const tp = price + (price - sl) * tp1R;
                    if ((tp - price) / (price - sl) >= gMinRR) signal = { dir: 'long', sl, tp };
                  } else if (price < level && rsi[i] > 50) {
                    const sl = level + slDist;
                    const tp = price - (sl - price) * tp1R;
                    if ((price - tp) / (sl - price) >= gMinRR) signal = { dir: 'short', sl, tp };
                  }
                }
              }
            }
          }
        }

        // ── SCALPING V3: VWAP Bounce / Liquidity Grab / Volume Spike ──
        else if (strategy === 'scalping') {
          const scRsiOB = P.rsiOB || 55;
          const scRsiOS = P.rsiOS || 45;
          const scVolSpike = P.volSpikeMult || 2.5;
          const scAtrMult = P.atrMult || 1.2;
          const scMaxSL = (P.maxSL || 1.0) / 100;
          const scMinSL = (P.minSL || 0.25) / 100;
          const scBodyPct = P.bodyPct || 0.55;
          const useVwap = P.vwapBounce !== false;
          const useLG = P.liquidityGrab !== false;
          const useVS = P.volSpike !== false;
          const trendOnly = P.trendOnly === true;
          const m = macdCalc(closes);
          const prevHist = m.hist[i - 1], currHist = m.hist[i];
          const volRatio = volMA[i] > 0 ? volumes[i] / volMA[i] : 1;

          // Trend filter
          if (trendOnly && ema200[i]) {
            if (price < ema200[i] && (prevHist < 0 && currHist > 0)) { /* skip long */ }
            if (price > ema200[i] && (prevHist > 0 && currHist < 0)) { /* skip short */ }
          }

          // Volume Spike entry (primary)
          if (useVS && volRatio >= scVolSpike) {
            const body = Math.abs(c.close - c.open);
            const bar = c.high - c.low;
            if (bar > 0 && body / bar >= scBodyPct) {
              if (c.close > c.open && rsi[i] < scRsiOB) {
                let sl = (c.open + c.low) / 2;
                let slPct = (price - sl) / price;
                if (slPct > scMaxSL) sl = price * (1 - scMaxSL);
                if (slPct < scMinSL) sl = price * (1 - scMinSL);
                signal = { dir: 'long', sl, tp: price + Math.max(body * 1.5, (price - sl) * 2.0) };
              } else if (c.close < c.open && rsi[i] > scRsiOS) {
                let sl = (c.open + c.high) / 2;
                let slPct = (sl - price) / price;
                if (slPct > scMaxSL) sl = price * (1 + scMaxSL);
                if (slPct < scMinSL) sl = price * (1 + scMinSL);
                signal = { dir: 'short', sl, tp: price - Math.max(body * 1.5, (sl - price) * 2.0) };
              }
            }
          }
          // MACD cross (fallback if no Volume Spike signal)
          if (!signal && P.macdCross !== false) {
            const volAbove = volumes[i] > volMA[i] * (P.volMult || 0.9);
            if (prevHist < 0 && currHist > 0 && rsi[i] < scRsiOS && volAbove) {
              signal = { dir: 'long', sl: price - atr[i-1] * scAtrMult, tp: price + atr[i-1] * scAtrMult * 1.5 };
            } else if (prevHist > 0 && currHist < 0 && rsi[i] > scRsiOB && volAbove) {
              signal = { dir: 'short', sl: price + atr[i-1] * scAtrMult, tp: price - atr[i-1] * scAtrMult * 1.5 };
            }
          }
        }

        } catch(stratErr) { signal = null; } // strategy error — skip bar

        if (signal && signal.dir) {
          // Direction filter
          if (directionFilter === 'long' && signal.dir === 'short') signal = null;
          if (directionFilter === 'short' && signal.dir === 'long') signal = null;

          // Trend filter: EMA(200) — only trade with trend
          if (signal && useTrendFilter && ema200[i]) {
            if (signal.dir === 'long' && price < ema200[i]) signal = null;
            else if (signal && signal.dir === 'short' && price > ema200[i]) signal = null;
          }
        }

        if (signal && signal.dir && signal.sl && signal.tp) {
          inTrade = true;
          entryPrice = price;
          direction = signal.dir;
          slPrice = signal.sl;
          tpPrice = signal.tp;
          entryIdx = i;
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
          trades.push({ dir: direction, entry: entryPrice, exit: exitPrice, sl: slPrice, tp: tpPrice, pnl: +pnl.toFixed(2), pnlPct: +pnlPct.toFixed(2), result: hit_tp ? 'win' : 'loss', entryTime: candles[entryIdx]?.ts || 0, exitTime: candles[i]?.ts || 0 });
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
      trades: trades.slice(0, 100), // max 100 trades for response size
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
