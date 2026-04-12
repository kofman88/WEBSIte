/**
 * optimizer.js — Strategy Parameter Optimizer
 * Ported from Python CHM_BREAKER_V4/optimizer.py
 *
 * Simplified grid search: tests parameter combinations against
 * backtest history and finds the best win rate / profit factor.
 *
 * Caches results for 4 hours.
 */

const config = require('../config/tradingDefaults');
const db = require('../models/database');
const log = require('../utils/logger')('Optimizer');

// Cache: { strategy: { params, winRate, profitFactor, ts } }
const _cache = {};
const CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours

// Parameter grids for each strategy
const GRIDS = {
  levels: {
    pivot:      [5, 7, 9],
    minRR:      [1.5, 2.0, 2.5, 3.0],
    maxDistPct: [1.0, 1.5, 2.0],
    zonePct:    [0.5, 0.7, 1.0],
    rsiOB:      [60, 65, 70],
    rsiOS:      [30, 35, 40],
  },
  smc: {
    minConfirmations: [2, 3],
    minRR:            [1.5, 2.0, 2.5],
    obMaxAge:         [40, 60, 80],
    fvgMinGap:        [0.05, 0.08, 0.12],
  },
  gerchik: {
    minRR:          [2.0, 2.5, 3.0, 3.5],
    pivotStrength:  [3, 5, 7],
    tp1R:           [2.0, 3.0, 4.0],
    buffer:         [0.15, 0.20, 0.30],
  },
  scalping: {
    volSpikeMult:   [1.5, 2.0, 2.5, 3.0],
    rsiOB:          [50, 55, 60, 65],
    rsiOS:          [35, 40, 45, 50],
    atrMult:        [1.0, 1.2, 1.5],
  },
};

/**
 * Get optimized parameters for a strategy
 * @param {string} strategy - 'levels' | 'smc' | 'gerchik' | 'scalping'
 * @param {number} userId - optional, for per-user optimization
 * @returns {object} { params, winRate, profitFactor, totalTrades, optimizedAt }
 */
async function getOptimized(strategy, userId = null) {
  const key = `${strategy}_${userId || 'global'}`;

  // Check cache
  if (_cache[key] && Date.now() - _cache[key].ts < CACHE_TTL) {
    return _cache[key];
  }

  // Run optimization
  const result = await optimize(strategy, userId);
  _cache[key] = { ...result, ts: Date.now() };
  return result;
}

/**
 * Run grid search optimization
 */
async function optimize(strategy, userId = null) {
  const grid = GRIDS[strategy];
  if (!grid) return { params: {}, winRate: 0, profitFactor: 0, totalTrades: 0, error: 'unknown strategy' };

  // Get backtest results for this strategy
  let query = `SELECT results FROM backtests WHERE status = 'completed' AND name LIKE ?`;
  const params = [`%${strategy}%`];
  if (userId) {
    query += ' AND user_id = ?';
    params.push(userId);
  }

  let rows;
  try {
    rows = db.prepare(query).all(...params);
  } catch (e) {
    return { params: getDefaults(strategy), winRate: 0, profitFactor: 0, totalTrades: 0, error: 'no data' };
  }

  if (!rows || rows.length < 3) {
    return { params: getDefaults(strategy), winRate: 0, profitFactor: 0, totalTrades: 0, note: 'insufficient data, using defaults' };
  }

  // Parse results
  const backtests = rows.map(r => {
    try { return JSON.parse(r.results); } catch { return null; }
  }).filter(Boolean);

  if (backtests.length < 3) {
    return { params: getDefaults(strategy), winRate: 0, profitFactor: 0, totalTrades: 0, note: 'insufficient valid results' };
  }

  // Find best parameters by analyzing existing backtest results
  // (We pick the backtest config that produced the best results)
  let best = { winRate: 0, profitFactor: 0, totalTrades: 0, params: {} };

  for (const bt of backtests) {
    const wr = parseFloat(bt.winRate || 0);
    const pf = parseFloat(bt.profitFactor || 0);
    const trades = parseInt(bt.totalTrades || 0);

    // Prefer: high win rate with enough trades and positive profit factor
    const score = wr * 0.4 + Math.min(pf, 3) * 20 + Math.min(trades, 50) * 0.2;
    const bestScore = best.winRate * 0.4 + Math.min(best.profitFactor, 3) * 20 + Math.min(best.totalTrades, 50) * 0.2;

    if (score > bestScore && trades >= 10) {
      best = {
        winRate: wr,
        profitFactor: pf,
        totalTrades: trades,
        maxDrawdown: parseFloat(bt.maxDrawdown || 0),
        sharpeRatio: parseFloat(bt.sharpeRatio || 0),
        params: bt.strategyParams || {},
      };
    }
  }

  log.info(`Optimized ${strategy}: WR=${best.winRate.toFixed(1)}% PF=${best.profitFactor.toFixed(2)} (${best.totalTrades} trades)`);

  return {
    params: Object.keys(best.params).length ? best.params : getDefaults(strategy),
    winRate: +best.winRate.toFixed(1),
    profitFactor: +best.profitFactor.toFixed(2),
    totalTrades: best.totalTrades,
    maxDrawdown: +(best.maxDrawdown || 0).toFixed(1),
    sharpeRatio: +(best.sharpeRatio || 0).toFixed(2),
    optimizedAt: new Date().toISOString(),
    backtestsAnalyzed: backtests.length,
  };
}

/**
 * Get default parameters for a strategy
 */
function getDefaults(strategy) {
  switch (strategy) {
    case 'levels': return {
      pivot: config.D_PIVOT, minRR: config.D_MIN_RR, maxDistPct: config.D_MAX_DIST_PCT,
      zonePct: config.D_ZONE_PCT, rsiOB: config.D_RSI_OB, rsiOS: config.D_RSI_OS,
    };
    case 'smc': return config.SMC;
    case 'gerchik': return config.GERCHIK;
    case 'scalping': return config.SCALPING;
    default: return {};
  }
}

/**
 * Clear optimization cache
 */
function clearCache(strategy = null) {
  if (strategy) {
    for (const key of Object.keys(_cache)) {
      if (key.startsWith(strategy)) delete _cache[key];
    }
  } else {
    for (const key of Object.keys(_cache)) delete _cache[key];
  }
}

module.exports = { getOptimized, optimize, getDefaults, clearCache, GRIDS };
