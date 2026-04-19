/**
 * Backtest engine — real walk-forward simulator.
 *
 * Replaces the pre-v3 Math.random() mock. This is deterministic, honest
 * simulation given the strategy's scan() output and historical candles.
 *
 * Architecture:
 *   runBacktest(id) loads config from `backtests`, fetches candles per
 *   symbol via marketDataService (cache-friendly), iterates candle by
 *   candle, calls strategy.scan() on the prefix window [0..i], opens
 *   virtual positions, simulates TP1 → 33% + SL→BE, TP2 → 33% + SL→TP1,
 *   TP3/SL → close remainder. Fees + slippage baked into each fill.
 *
 * Concurrency: single bt runs sequentially per-candle; multiple bts are
 * queued externally (see workers/backtestQueue.js).
 *
 * Progress is persisted every ~1000 candles + at every symbol boundary.
 */

const db = require('../models/database');
const marketData = require('./marketDataService');
const logger = require('../utils/logger');

// Strategy registry — keep in sync with signalScanner
const STRATEGIES = {
  levels: require('../strategies/levels'),
  smc: require('../strategies/smc'),
  scalping: require('../strategies/scalping'),
};

// ── Default risk + fees ────────────────────────────────────────────────
const DEFAULT_FEE_PCT = 0.0005;        // 0.05% per execution
const DEFAULT_SLIPPAGE_PCT = 0.0002;   // 0.02%
const DEFAULT_RISK_PCT = 1.0;          // 1% of equity per trade
const PARTIAL_TP1_FRAC = 0.33;
const PARTIAL_TP2_FRAC = 0.33;
// remainder (~0.34) closes at TP3 or SL

const MAX_OPEN_PER_SYMBOL = 1;

/**
 * Public entry: run a saved backtest by id.
 */
async function runBacktest(backtestId) {
  const bt = db.prepare('SELECT * FROM backtests WHERE id = ?').get(backtestId);
  if (!bt) throw new Error('Backtest not found: ' + backtestId);

  db.prepare(`UPDATE backtests SET status='running', started_at=CURRENT_TIMESTAMP, progress_pct=0 WHERE id=?`)
    .run(backtestId);
  const startTime = Date.now();

  try {
    const symbols = safeJson(bt.symbols, []);
    const strategyKey = bt.strategy;
    const strategy = STRATEGIES[strategyKey];
    if (!strategy) throw new Error('Unknown strategy: ' + strategyKey);

    const strategyCfg = safeJson(bt.strategy_config, {});
    const riskCfg = {
      feePct: DEFAULT_FEE_PCT,
      slippagePct: DEFAULT_SLIPPAGE_PCT,
      riskPct: DEFAULT_RISK_PCT,
      ...safeJson(bt.risk_config, {}),
    };

    const fromMs = new Date(bt.start_date).getTime();
    const toMs = new Date(bt.end_date).getTime() + 86_400_000 - 1;

    const capital = bt.initial_capital;
    let equity = capital;
    const equityCurve = [[fromMs, capital]];
    const allTrades = [];
    let maxEquity = capital;
    let maxDrawdownUsd = 0;
    let maxDrawdownPct = 0;

    const perSymbol = {};

    for (let si = 0; si < symbols.length; si++) {
      const symbol = symbols[si];
      logger.info('bt run: symbol', { id: backtestId, symbol });

      // Pull candles (cache will fill)
      let candles;
      try {
        candles = await marketData.fetchCandles(bt.exchange, symbol, bt.timeframe, {
          since: fromMs,
          limit: Math.ceil((toMs - fromMs) / marketData.tfToMs(bt.timeframe)) + 10,
        });
      } catch (err) {
        logger.warn('bt fetch failed', { id: backtestId, symbol, err: err.message });
        continue;
      }
      // Cut strictly to window
      candles = candles.filter((c) => c[0] >= fromMs && c[0] <= toMs);
      if (candles.length < 100) {
        logger.warn('bt: insufficient candles', { id: backtestId, symbol, got: candles.length });
        continue;
      }

      const openPositions = []; // active virtual positions

      for (let i = 50; i < candles.length; i++) {
        // Process any open positions against this bar FIRST (realistic order)
        const bar = candles[i];
        for (let pi = openPositions.length - 1; pi >= 0; pi--) {
          const pos = openPositions[pi];
          const result = _simulateBarExit(pos, bar, riskCfg);
          for (const fill of result.fills) {
            equity += fill.pnl;
            allTrades.push(fill);
            perSymbol[symbol] = perSymbol[symbol] || { trades: 0, wins: 0, pnl: 0 };
            perSymbol[symbol].trades++;
            if (fill.pnl > 0) perSymbol[symbol].wins++;
            perSymbol[symbol].pnl += fill.pnl;
          }
          if (result.closed) openPositions.splice(pi, 1);
          if (equity > maxEquity) maxEquity = equity;
          const ddUsd = maxEquity - equity;
          if (ddUsd > maxDrawdownUsd) maxDrawdownUsd = ddUsd;
          const ddPct = maxEquity > 0 ? ddUsd / maxEquity * 100 : 0;
          if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;
        }

        // Now try to OPEN a new position — strategy sees window ending at bar i
        if (openPositions.length < MAX_OPEN_PER_SYMBOL) {
          const window = candles.slice(0, i + 1);
          const sig = strategy.scan(window, strategyCfg);
          if (sig) {
            const qty = _computeQty(equity, sig.entry, sig.stopLoss, riskCfg.riskPct);
            if (qty > 0) {
              const pos = {
                symbol,
                side: sig.side,
                entry: sig.entry,
                stopLoss: sig.stopLoss,
                tp1: sig.tp1,
                tp2: sig.tp2,
                tp3: sig.tp3,
                qty,
                qtyRemaining: qty,
                tp1Hit: false,
                tp2Hit: false,
                entryTime: bar[0],
                entryIndex: i,
                quality: sig.quality,
                confidence: sig.confidence,
              };
              // Apply entry fee+slippage to equity (exec cost)
              const entryCost = pos.qty * sig.entry * (riskCfg.feePct + riskCfg.slippagePct);
              equity -= entryCost;
              openPositions.push(pos);
            }
          }
        }

        // Update equity curve every ~50 bars or symbol boundary
        if (i % 50 === 0) equityCurve.push([bar[0], equity]);

        // Persist progress ~ every 1000 bars
        if (i % 1000 === 0) {
          const totalBars = symbols.length * candles.length; // approx
          const done = si * candles.length + i;
          const pct = Math.min(99, Math.floor((done / totalBars) * 100));
          db.prepare('UPDATE backtests SET progress_pct = ? WHERE id = ?').run(pct, backtestId);
        }
      }

      // Close any positions left open at the last bar (liquidate)
      const lastBar = candles[candles.length - 1];
      for (const pos of openPositions) {
        const fill = _closePosition(pos, lastBar[4], 'timeout', lastBar[0], riskCfg);
        equity += fill.pnl;
        allTrades.push(fill);
        perSymbol[symbol] = perSymbol[symbol] || { trades: 0, wins: 0, pnl: 0 };
        perSymbol[symbol].trades++;
        if (fill.pnl > 0) perSymbol[symbol].wins++;
        perSymbol[symbol].pnl += fill.pnl;
      }
      equityCurve.push([lastBar[0], equity]);
    }

    // ── Build metrics ──
    const metrics = _buildMetrics({
      capital, equity, equityCurve, allTrades, perSymbol,
      maxDrawdownPct, maxDrawdownUsd,
    });

    // Persist results + backtest_trades
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM backtest_trades WHERE backtest_id = ?').run(backtestId);
      const ins = db.prepare(`
        INSERT INTO backtest_trades
          (backtest_id, symbol, side, entry_time, entry_price, exit_time, exit_price,
           quantity, stop_loss, take_profit_1, take_profit_2, take_profit_3,
           pnl_pct, pnl_usd, close_reason, equity_after)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const t of allTrades) {
        ins.run(
          backtestId, t.symbol, t.side,
          new Date(t.entryTime).toISOString(), t.entryPrice,
          new Date(t.exitTime).toISOString(), t.exitPrice,
          t.quantity, t.stopLoss, t.tp1, t.tp2, t.tp3,
          t.pnlPct, t.pnl, t.closeReason, t.equityAfter,
        );
      }
      db.prepare(`
        UPDATE backtests
        SET status='completed', progress_pct=100, results=?, duration_ms=?, completed_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(JSON.stringify(metrics), Date.now() - startTime, backtestId);
    });
    tx();

    logger.info('bt done', { id: backtestId, trades: allTrades.length, pnl: metrics.totalPnlUsd });
    return metrics;
  } catch (err) {
    logger.error('bt failed', { id: backtestId, err: err.message, stack: err.stack });
    db.prepare(`
      UPDATE backtests SET status='failed', error_message=?, completed_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(String(err.message).slice(0, 500), backtestId);
    throw err;
  }
}

// ── Position math ───────────────────────────────────────────────────────
function _computeQty(equity, entry, stopLoss, riskPct) {
  if (!Number.isFinite(entry) || !Number.isFinite(stopLoss) || entry <= 0) return 0;
  const riskUsd = equity * (riskPct / 100);
  const slDist = Math.abs(entry - stopLoss);
  if (slDist === 0) return 0;
  return riskUsd / slDist;
}

function _simulateBarExit(pos, bar, riskCfg) {
  const [t, , high, low] = bar;
  const fills = [];
  let closed = false;

  const applyFill = (fraction, price, reason) => {
    const qty = pos.qty * fraction;
    const pnlGross = (pos.side === 'long' ? price - pos.entry : pos.entry - price) * qty;
    const feeCost = qty * price * (riskCfg.feePct + riskCfg.slippagePct);
    const pnl = pnlGross - feeCost;
    const pnlPct = pos.entry > 0 ? (pnlGross / (pos.entry * qty)) * 100 : 0;
    pos.qtyRemaining -= qty;
    fills.push({
      symbol: pos.symbol,
      side: pos.side,
      entryTime: pos.entryTime,
      entryPrice: pos.entry,
      exitTime: t,
      exitPrice: price,
      quantity: qty,
      stopLoss: pos.stopLoss,
      tp1: pos.tp1, tp2: pos.tp2, tp3: pos.tp3,
      pnl, pnlPct, closeReason: reason, equityAfter: null,
    });
  };

  // If this bar contains BOTH SL and TP, assume worst case (conservative)
  // For a long: if high reaches TP but low hits SL, we assume SL fired first
  // because we cannot know intra-bar order.

  if (pos.side === 'long') {
    const slHitNow = low <= pos.stopLoss;
    if (slHitNow) {
      applyFill(pos.qtyRemaining / pos.qty, pos.stopLoss, pos.tp1Hit || pos.tp2Hit ? 'trailing_sl' : 'sl');
      closed = true;
    } else {
      if (!pos.tp1Hit && high >= pos.tp1) {
        applyFill(PARTIAL_TP1_FRAC, pos.tp1, 'tp1');
        pos.stopLoss = pos.entry; // move to breakeven
        pos.tp1Hit = true;
      }
      if (!pos.tp2Hit && high >= pos.tp2) {
        applyFill(PARTIAL_TP2_FRAC, pos.tp2, 'tp2');
        pos.stopLoss = pos.tp1; // trail to TP1
        pos.tp2Hit = true;
      }
      if (pos.tp3 !== null && high >= pos.tp3) {
        applyFill(pos.qtyRemaining / pos.qty, pos.tp3, 'tp3');
        closed = true;
      }
    }
  } else {
    // short
    const slHitNow = high >= pos.stopLoss;
    if (slHitNow) {
      applyFill(pos.qtyRemaining / pos.qty, pos.stopLoss, pos.tp1Hit || pos.tp2Hit ? 'trailing_sl' : 'sl');
      closed = true;
    } else {
      if (!pos.tp1Hit && low <= pos.tp1) {
        applyFill(PARTIAL_TP1_FRAC, pos.tp1, 'tp1');
        pos.stopLoss = pos.entry;
        pos.tp1Hit = true;
      }
      if (!pos.tp2Hit && low <= pos.tp2) {
        applyFill(PARTIAL_TP2_FRAC, pos.tp2, 'tp2');
        pos.stopLoss = pos.tp1;
        pos.tp2Hit = true;
      }
      if (pos.tp3 !== null && low <= pos.tp3) {
        applyFill(pos.qtyRemaining / pos.qty, pos.tp3, 'tp3');
        closed = true;
      }
    }
  }

  if (pos.qtyRemaining <= 0.0000001) closed = true;
  return { fills, closed };
}

function _closePosition(pos, price, reason, time, riskCfg) {
  const fraction = pos.qtyRemaining / pos.qty;
  const qty = pos.qtyRemaining;
  const pnlGross = (pos.side === 'long' ? price - pos.entry : pos.entry - price) * qty;
  const feeCost = qty * price * (riskCfg.feePct + riskCfg.slippagePct);
  const pnl = pnlGross - feeCost;
  const pnlPct = pos.entry > 0 ? (pnlGross / (pos.entry * qty)) * 100 : 0;
  return {
    symbol: pos.symbol, side: pos.side,
    entryTime: pos.entryTime, entryPrice: pos.entry,
    exitTime: time, exitPrice: price,
    quantity: qty, stopLoss: pos.stopLoss, tp1: pos.tp1, tp2: pos.tp2, tp3: pos.tp3,
    pnl, pnlPct, closeReason: reason, equityAfter: null,
  };
}

// ── Metrics ─────────────────────────────────────────────────────────────
function _buildMetrics({ capital, equity, equityCurve, allTrades, perSymbol, maxDrawdownPct, maxDrawdownUsd }) {
  const totalTrades = allTrades.length;
  const wins = allTrades.filter((t) => t.pnl > 0);
  const losses = allTrades.filter((t) => t.pnl < 0);
  const breakevens = allTrades.filter((t) => t.pnl === 0);
  const winRate = totalTrades > 0 ? wins.length / totalTrades : 0;
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const totalPnl = equity - capital;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const expectancy = totalTrades > 0 ? totalPnl / totalTrades : 0;

  // Consecutive wins/losses
  let maxWinStreak = 0, maxLossStreak = 0, curWin = 0, curLoss = 0;
  for (const t of allTrades) {
    if (t.pnl > 0) { curWin++; curLoss = 0; if (curWin > maxWinStreak) maxWinStreak = curWin; }
    else if (t.pnl < 0) { curLoss++; curWin = 0; if (curLoss > maxLossStreak) maxLossStreak = curLoss; }
    else { curWin = 0; curLoss = 0; }
  }

  // Sharpe / Sortino on daily returns
  const dailyReturns = _dailyReturns(equityCurve);
  const sharpe = _sharpe(dailyReturns);
  const sortino = _sortino(dailyReturns);
  const calmar = maxDrawdownPct > 0 ? ((totalPnl / capital * 100) / maxDrawdownPct) : 0;

  const bestTradePct = allTrades.reduce((m, t) => Math.max(m, t.pnlPct), -Infinity);
  const worstTradePct = allTrades.reduce((m, t) => Math.min(m, t.pnlPct), Infinity);

  // Monthly returns
  const monthly = {};
  for (const t of allTrades) {
    const d = new Date(t.exitTime);
    const key = d.toISOString().slice(0, 7);
    monthly[key] = (monthly[key] || 0) + t.pnl;
  }

  // Avg trade duration
  let totalHours = 0;
  for (const t of allTrades) {
    totalHours += (t.exitTime - t.entryTime) / 3_600_000;
  }
  const avgTradeHours = totalTrades > 0 ? totalHours / totalTrades : 0;

  return {
    totalTrades,
    winningTrades: wins.length,
    losingTrades: losses.length,
    breakevenTrades: breakevens.length,
    winRatePct: Number((winRate * 100).toFixed(2)),
    totalPnlUsd: Number(totalPnl.toFixed(2)),
    totalPnlPct: Number(((totalPnl / capital) * 100).toFixed(2)),
    maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
    maxDrawdownUsd: Number(maxDrawdownUsd.toFixed(2)),
    maxConsecutiveWins: maxWinStreak,
    maxConsecutiveLosses: maxLossStreak,
    avgWinUsd: Number(avgWin.toFixed(2)),
    avgLossUsd: Number(avgLoss.toFixed(2)),
    profitFactor: Number.isFinite(profitFactor) ? Number(profitFactor.toFixed(2)) : null,
    sharpeRatio: Number(sharpe.toFixed(2)),
    sortinoRatio: Number(sortino.toFixed(2)),
    calmarRatio: Number(calmar.toFixed(2)),
    expectancyUsd: Number(expectancy.toFixed(2)),
    avgTradeDurationHours: Number(avgTradeHours.toFixed(1)),
    bestTradePct: Number.isFinite(bestTradePct) ? Number(bestTradePct.toFixed(2)) : 0,
    worstTradePct: Number.isFinite(worstTradePct) ? Number(worstTradePct.toFixed(2)) : 0,
    equityCurve,
    monthlyReturnsUsd: monthly,
    bySymbol: perSymbol,
  };
}

function _dailyReturns(equityCurve) {
  if (equityCurve.length < 2) return [];
  const byDay = new Map();
  for (const [ts, eq] of equityCurve) {
    const dayKey = Math.floor(ts / 86_400_000);
    byDay.set(dayKey, eq); // last equity snapshot of the day wins
  }
  const days = [...byDay.entries()].sort((a, b) => a[0] - b[0]);
  const returns = [];
  for (let i = 1; i < days.length; i++) {
    const prev = days[i - 1][1];
    const curr = days[i][1];
    if (prev > 0) returns.push((curr - prev) / prev);
  }
  return returns;
}

function _sharpe(returns, annualize = 365) {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((s, x) => s + x, 0) / returns.length;
  const variance = returns.reduce((s, x) => s + (x - mean) ** 2, 0) / returns.length;
  const sd = Math.sqrt(variance);
  if (sd === 0) return 0;
  return (mean / sd) * Math.sqrt(annualize);
}

function _sortino(returns, annualize = 365) {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((s, x) => s + x, 0) / returns.length;
  const downside = returns.filter((x) => x < 0);
  if (downside.length === 0) return 0;
  const variance = downside.reduce((s, x) => s + x ** 2, 0) / downside.length;
  const sd = Math.sqrt(variance);
  if (sd === 0) return 0;
  return (mean / sd) * Math.sqrt(annualize);
}

function safeJson(s, fb) {
  if (!s) return fb;
  try { return JSON.parse(s); } catch { return fb; }
}

module.exports = {
  runBacktest,
  _computeQty,
  _simulateBarExit,
  _buildMetrics,
  STRATEGIES,
};
