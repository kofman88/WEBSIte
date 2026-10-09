'use strict';
/**
 * adaptiveSizing.js — port of adaptive_sizing.py ([W2 ADAPTIVE-SIZING]): Kelly × volatility ×
 * drawdown × per-strategy PF multipliers on the user's risk %.
 *
 *   kellyFactor(wins, losses, avgWinR, avgLossR, fraction=0.25)   pure, 0.5..1.5 (1.5 at 0 losses ≥ 10 trades)
 *   kellyFactorForUser(uid, lookback=30)       last 30 TP1/TP2/TP3/SL rows
 *   volFactorForSymbol(symbol, atrPct=null)    1H cache, (high−low).rolling(14).mean() / close
 *   drawdownFactorForUser(uid, days=14)        cumulative R equity curve
 *   strategyFactorForUser(uid, strategy, days=30)   PF of that strategy
 *   calculateAdaptiveFactors(uid, symbol, mode, atrPct, strategy) → {kelly, vol, dd, strategy, final}
 *
 * DB errors → factor 1.0 (debug log), like the bot.
 */

const { pyRound } = require('../../strategies/common/pyround');
const { rollingMean } = require('../../strategies/common/series');
const { pyUpper } = require('../../strategies/common/pyUnicode');

function kellyFactor(winsCount, lossesCount, avgWinR, avgLossR, fraction = 0.25) {
  const total = winsCount + lossesCount;
  if (total < 10) return 1.0;
  if (avgWinR <= 0) return 1.0;
  if (lossesCount === 0) return 1.5;
  if (avgLossR <= 0) return 1.0;
  const wr = winsCount / total;
  const f = wr - (1 - wr) * (avgLossR / avgWinR);
  const kelly = fraction * f;
  let multiplier = 1.0 + kelly * 2.0;
  multiplier = Math.max(0.5, Math.min(1.5, multiplier));
  return pyRound(multiplier, 3);
}

function createAdaptiveSizing({ db = null, cache = null, now = () => Date.now() / 1000, log = null } = {}) {
  const dbOf = () => (db ? db : require('../../models/database'));
  const cacheOf = () => (cache ? cache : require('../marketData/candleCache'));
  const logger = log || require('../marketData/mdLog').log;

  async function kellyFactorForUser(userId, lookback = 30) {
    try {
      const rows = dbOf().prepare("SELECT result, result_rr FROM signal_trades WHERE user_id=? "
        + "AND result IN ('TP1','TP2','TP3','SL') "
        + 'AND result_rr IS NOT NULL '
        + 'ORDER BY created_at DESC LIMIT ?').all(Number(userId), lookback);
      if (rows.length < 10) return 1.0;
      let wins = 0;
      let losses = 0;
      let sumWin = 0.0;
      let sumLoss = 0.0;
      for (const r of rows) {
        const rr = Number(r.result_rr || 0);
        if (rr > 0) { wins += 1; sumWin += rr; } else { losses += 1; sumLoss += Math.abs(rr); }
      }
      const avgWin = wins ? sumWin / wins : 0.0;
      const avgLoss = losses ? sumLoss / losses : 1.0;
      return kellyFactor(wins, losses, avgWin, avgLoss);
    } catch (e) {
      logger.debug(`kelly_factor_for_user uid=${userId}: ${e && e.message}`);
      return 1.0;
    }
  }

  async function volFactorForSymbol(symbol, atrPct = null) {
    try {
      let a = atrPct;
      if (a === null || a === undefined) {
        const df = await cacheOf().getCandles(symbol, '1H');
        if (df === null || df === undefined || df.length < 14) return 1.0;
        const hl = new Float64Array(df.length);
        for (let i = 0; i < df.length; i++) hl[i] = df.h[i] - df.l[i];
        const highLow = rollingMean(hl, 14)[df.length - 1];
        const currentClose = df.c[df.length - 1];
        a = currentClose > 0 ? highLow / currentClose * 100.0 : 0;
      }
      if (a <= 0) return 1.0;
      if (a <= 1.0) return 1.3;
      if (a <= 2.0) return 1.15;
      if (a <= 3.0) return 1.0;
      if (a <= 5.0) return 0.85;
      return 0.7;
    } catch (e) {
      logger.debug(`vol_factor_for_symbol ${symbol}: ${e && e.message}`);
      return 1.0;
    }
  }

  async function drawdownFactorForUser(userId, lookbackDays = 14) {
    try {
      const cutoff = now() - lookbackDays * 86400;
      const rows = dbOf().prepare('SELECT result_rr FROM signal_trades WHERE user_id=? '
        + "AND result IN ('TP1','TP2','TP3','SL','BE','TRAIL') "
        + 'AND result_rr IS NOT NULL '
        + 'AND created_at >= ? '
        + 'ORDER BY created_at ASC').all(Number(userId), cutoff);
      if (rows.length < 5) return 1.0;
      let cum = 0.0;
      let peak = 0.0;
      for (const r of rows) {
        cum += Number(r.result_rr || 0);
        if (cum > peak) peak = cum;
      }
      if (peak <= 0) return 1.0;
      const ddPct = peak > 0 ? (peak - cum) / peak * 100.0 : 0.0;
      if (ddPct <= 5.0) return 1.0;
      if (ddPct <= 10.0) return 0.75;
      if (ddPct <= 20.0) return 0.5;
      return 0.25;
    } catch (e) {
      logger.debug(`drawdown_factor_for_user uid=${userId}: ${e && e.message}`);
      return 1.0;
    }
  }

  async function strategyFactorForUser(userId, strategy, lookbackDays = 30) {
    try {
      const cutoff = now() - lookbackDays * 86400;
      const rows = dbOf().prepare('SELECT result_rr FROM signal_trades WHERE user_id=? '
        + 'AND strategy=? '
        + "AND result IN ('TP1','TP2','TP3','SL','BE','TRAIL') "
        + 'AND result_rr IS NOT NULL '
        + 'AND created_at >= ? ').all(Number(userId), pyUpper(String(strategy)), cutoff);
      if (rows.length < 10) return 1.0;
      let winsRr = 0.0;
      let lossesRr = 0.0;
      for (const r of rows) {
        const rr = Number(r.result_rr || 0);
        if (rr > 0) winsRr += rr;
        else if (rr < 0) lossesRr += Math.abs(rr);
      }
      if (lossesRr <= 0.01) return winsRr > 0 ? 1.3 : 1.0;
      const pf = winsRr / lossesRr;
      if (pf >= 2.0) return 1.3;
      if (pf >= 1.5) return 1.15;
      if (pf >= 1.0) return 1.0;
      if (pf >= 0.7) return 0.8;
      return 0.5;
    } catch (e) {
      logger.debug(`strategy_factor_for_user uid=${userId} strat=${strategy}: ${e && e.message}`);
      return 1.0;
    }
  }

  async function calculateAdaptiveFactors({ userId, symbol, mode = 'all', atrPct = null, strategy = null }) {
    if (mode === 'off') return { kelly: 1.0, vol: 1.0, dd: 1.0, strategy: 1.0, final: 1.0 };
    const k = (mode === 'kelly' || mode === 'all') ? await kellyFactorForUser(userId) : 1.0;
    const v = (mode === 'vol' || mode === 'all') ? await volFactorForSymbol(symbol, atrPct) : 1.0;
    const d = (mode === 'dd' || mode === 'all') ? await drawdownFactorForUser(userId) : 1.0;
    const s = (strategy && (mode === 'strategy' || mode === 'all')) ? await strategyFactorForUser(userId, strategy) : 1.0;
    let final = k * v * d * s;
    final = Math.max(0.25, Math.min(1.5, final));
    return {
      kelly: pyRound(k, 3), vol: pyRound(v, 3), dd: pyRound(d, 3), strategy: pyRound(s, 3), final: pyRound(final, 3),
    };
  }

  return { kellyFactorForUser, volFactorForSymbol, drawdownFactorForUser, strategyFactorForUser, calculateAdaptiveFactors };
}

module.exports = { kellyFactor, createAdaptiveSizing };
