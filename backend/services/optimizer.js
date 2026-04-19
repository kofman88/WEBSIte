/**
 * Parameter optimizer — Grid Search + Random Search with Walk-Forward validation.
 *
 * Inspired by bot's bayesian_optimizer.py (Optuna TPE), but implemented with
 * simpler search algorithms since Node.js lacks a mature Bayesian library.
 * For MVP, Grid + Random cover 80% of the practical use case.
 *
 * Walk-Forward validation:
 *   [start ───────── trainEnd ── valEnd ── end]
 *          60%          20%      20%
 *
 *   1. Optimize on [start..trainEnd] — find bestParams by `objective`
 *   2. Validate with bestParams on [trainEnd..valEnd] → validationScore
 *   3. Final test with bestParams on [valEnd..end] → testScore
 *
 * If testScore / trainScore < 0.5 → likely overfit; flagged in results.
 *
 * Architecture:
 *   paramSpace: { paramName: { type: 'int'|'float'|'choice', min, max, step?, choices? } }
 *   objective:  'profitFactor' | 'sharpeRatio' | 'totalPnlPct' | 'winRatePct'
 *
 * All trials share a single base backtest config; only strategy_config is varied.
 */

const PQueue = require('p-queue').default;
const db = require('../models/database');
const engine = require('./backtestEngine');
const logger = require('../utils/logger');

const OBJECTIVES = ['profitFactor', 'sharpeRatio', 'sortinoRatio', 'totalPnlPct', 'winRatePct', 'expectancyUsd'];

// ── Param space utilities ──────────────────────────────────────────────

/**
 * Enumerate every combination in the param space (for grid search).
 * @returns {Array<object>} — array of {paramName: value} combos
 */
function enumerateGrid(paramSpace, maxCombos = 1000) {
  const paramNames = Object.keys(paramSpace);
  if (!paramNames.length) return [{}];

  const domains = {};
  for (const name of paramNames) {
    const spec = paramSpace[name];
    if (spec.type === 'choice') {
      domains[name] = spec.choices;
    } else if (spec.type === 'int' || spec.type === 'float') {
      const step = spec.step || (spec.type === 'int' ? 1 : (spec.max - spec.min) / 5);
      const vals = [];
      for (let v = spec.min; v <= spec.max + 1e-9; v += step) {
        vals.push(spec.type === 'int' ? Math.round(v) : Number(v.toFixed(6)));
      }
      domains[name] = [...new Set(vals)];
    } else {
      throw new Error(`Unknown param type: ${spec.type}`);
    }
  }

  // Cartesian product with size cap
  let combos = [{}];
  for (const name of paramNames) {
    const next = [];
    for (const c of combos) {
      for (const v of domains[name]) {
        next.push({ ...c, [name]: v });
        if (next.length > maxCombos) break;
      }
      if (next.length > maxCombos) break;
    }
    combos = next;
  }
  return combos.slice(0, maxCombos);
}

/**
 * Sample one random point from the param space.
 */
function sampleRandom(paramSpace) {
  const out = {};
  for (const [name, spec] of Object.entries(paramSpace)) {
    if (spec.type === 'choice') {
      out[name] = spec.choices[Math.floor(Math.random() * spec.choices.length)];
    } else if (spec.type === 'int') {
      out[name] = Math.floor(spec.min + Math.random() * (spec.max - spec.min + 1));
    } else if (spec.type === 'float') {
      const v = spec.min + Math.random() * (spec.max - spec.min);
      out[name] = Number(v.toFixed(6));
    }
  }
  return out;
}

// ── Trial runner ───────────────────────────────────────────────────────

/**
 * Create a temporary backtest row, run engine, return metrics. Cleans up row after.
 */
async function runTrial(baseConfig, paramOverrides, { userId }) {
  const mergedCfg = { ...(baseConfig.strategyConfig || {}), ...paramOverrides };
  const info = db.prepare(`
    INSERT INTO backtests
      (user_id, name, strategy, exchange, symbols, timeframe,
       start_date, end_date, initial_capital, strategy_config,
       risk_config, status, progress_pct)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0)
  `).run(
    userId,
    '_opt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    baseConfig.strategy,
    baseConfig.exchange,
    JSON.stringify(baseConfig.symbols),
    baseConfig.timeframe,
    baseConfig.startDate,
    baseConfig.endDate,
    baseConfig.initialCapital,
    JSON.stringify(mergedCfg),
    JSON.stringify(baseConfig.riskConfig || {}),
  );
  const btId = info.lastInsertRowid;

  let metrics = null;
  try {
    metrics = await engine.runBacktest(btId);
  } catch (err) {
    logger.warn('optimizer trial failed', { err: err.message, params: paramOverrides });
  }

  // Cleanup: delete the ephemeral backtest and its trades
  db.prepare('DELETE FROM backtest_trades WHERE backtest_id = ?').run(btId);
  db.prepare('DELETE FROM backtests WHERE id = ?').run(btId);

  return metrics;
}

function scoreFrom(metrics, objective) {
  if (!metrics) return -Infinity;
  const v = metrics[objective];
  if (v === null || v === undefined || !Number.isFinite(v)) return -Infinity;
  return v;
}

// ── Walk-forward splitting ─────────────────────────────────────────────

/**
 * Split [start, end] into train / val / test by ratios.
 * Returns {trainEnd, valEnd} as ISO date strings (YYYY-MM-DD).
 */
function splitDates(startDate, endDate, trainRatio = 0.6, valRatio = 0.2) {
  const start = new Date(startDate).getTime();
  const end = new Date(endDate).getTime();
  const span = end - start;
  const trainEnd = new Date(start + span * trainRatio);
  const valEnd = new Date(start + span * (trainRatio + valRatio));
  const toIso = (d) => d.toISOString().slice(0, 10);
  return {
    trainStart: startDate,
    trainEnd: toIso(trainEnd),
    valStart: toIso(trainEnd),
    valEnd: toIso(valEnd),
    testStart: toIso(valEnd),
    testEnd: endDate,
  };
}

// ── Main search functions ──────────────────────────────────────────────

/**
 * Grid search. Returns { bestParams, bestScore, allResults, windowRange }.
 * Runs trials sequentially to respect CPU budget (caller can parallelise via PQueue if needed).
 */
async function gridSearch({ baseConfig, paramSpace, objective = 'profitFactor', maxCombos = 50, userId, onProgress }) {
  if (!OBJECTIVES.includes(objective)) throw new Error(`Unknown objective: ${objective}`);
  const combos = enumerateGrid(paramSpace, maxCombos);
  const allResults = [];

  for (let i = 0; i < combos.length; i++) {
    const params = combos[i];
    const metrics = await runTrial(baseConfig, params, { userId });
    const score = scoreFrom(metrics, objective);
    allResults.push({ params, score, metrics });
    if (onProgress) {
      try { onProgress({ done: i + 1, total: combos.length, bestSoFar: bestOf(allResults) }); } catch (_e) {}
    }
  }

  const best = bestOf(allResults);
  return { bestParams: best ? best.params : {}, bestScore: best ? best.score : null, allResults, method: 'grid', trials: combos.length };
}

/**
 * Random search. N trials, uniform sampling from paramSpace.
 */
async function randomSearch({ baseConfig, paramSpace, objective = 'profitFactor', nTrials = 20, userId, onProgress }) {
  if (!OBJECTIVES.includes(objective)) throw new Error(`Unknown objective: ${objective}`);
  const allResults = [];

  for (let i = 0; i < nTrials; i++) {
    const params = sampleRandom(paramSpace);
    const metrics = await runTrial(baseConfig, params, { userId });
    const score = scoreFrom(metrics, objective);
    allResults.push({ params, score, metrics });
    if (onProgress) {
      try { onProgress({ done: i + 1, total: nTrials, bestSoFar: bestOf(allResults) }); } catch (_e) {}
    }
  }

  const best = bestOf(allResults);
  return { bestParams: best ? best.params : {}, bestScore: best ? best.score : null, allResults, method: 'random', trials: nTrials };
}

/**
 * Walk-forward validation wrapper around gridSearch or randomSearch.
 *
 * 1. Split date range 60/20/20
 * 2. Optimize on train → bestParams
 * 3. Re-run bestParams on validation → valScore
 * 4. Re-run bestParams on test → testScore
 * 5. Report overfitting flag if testScore/trainScore < 0.5
 */
async function walkForward({ baseConfig, paramSpace, objective = 'profitFactor', method = 'grid',
                              nTrials = 20, maxCombos = 50, userId }) {
  const split = splitDates(baseConfig.startDate, baseConfig.endDate);

  const trainConfig = { ...baseConfig, startDate: split.trainStart, endDate: split.trainEnd };

  // 1. Optimize on train
  const searchFn = method === 'grid' ? gridSearch : randomSearch;
  const searchArgs = method === 'grid'
    ? { baseConfig: trainConfig, paramSpace, objective, maxCombos, userId }
    : { baseConfig: trainConfig, paramSpace, objective, nTrials, userId };
  const opt = await searchFn(searchArgs);

  const bestParams = opt.bestParams;
  if (!bestParams || opt.bestScore === null || opt.bestScore === -Infinity) {
    return {
      bestParams: {},
      trainScore: null,
      valScore: null,
      testScore: null,
      overfit: null,
      allResults: opt.allResults,
      method, trials: opt.trials, split,
    };
  }

  // 2. Validation
  const valConfig = { ...baseConfig, startDate: split.valStart, endDate: split.valEnd };
  const valMetrics = await runTrial(valConfig, bestParams, { userId });
  const valScore = scoreFrom(valMetrics, objective);

  // 3. Test
  const testConfig = { ...baseConfig, startDate: split.testStart, endDate: split.testEnd };
  const testMetrics = await runTrial(testConfig, bestParams, { userId });
  const testScore = scoreFrom(testMetrics, objective);

  const overfit = opt.bestScore > 0 && testScore < opt.bestScore * 0.5;

  return {
    bestParams,
    trainScore: opt.bestScore,
    valScore,
    testScore,
    overfit,
    allResults: opt.allResults,
    method, trials: opt.trials, split,
  };
}

function bestOf(results) {
  return results.reduce((best, r) => (!best || r.score > best.score) ? r : best, null);
}

module.exports = {
  gridSearch,
  randomSearch,
  walkForward,
  splitDates,
  enumerateGrid,
  sampleRandom,
  OBJECTIVES,
  _runTrial: runTrial,
};
