/**
 * Optimization service — enqueue + persist parameter-search runs.
 *
 * Heavy: each trial runs a full backtest under the hood. Gated to Elite plan
 * via plans.canUseFeature('optimizer'). Concurrency capped server-wide.
 */

const PQueue = require('p-queue').default;
const db = require('../models/database');
const optimizer = require('./optimizer');
const plans = require('../config/plans');
const logger = require('../utils/logger');

const OPT_CONCURRENCY = 1; // one optimization at a time globally (CPU heavy)
const runQueue = new PQueue({ concurrency: OPT_CONCURRENCY });

function createOptimization(userId, cfg) {
  // Plan gate
  const planRow = db.prepare('SELECT plan FROM subscriptions WHERE user_id = ?').get(userId);
  const plan = (planRow && planRow.plan) || 'free';
  if (!plans.canUseFeature(plan, 'optimizer')) {
    const err = new Error('Optimizer requires Elite plan');
    err.statusCode = 403; err.code = 'UPGRADE_REQUIRED'; err.requiredPlan = 'elite';
    throw err;
  }

  const result = db.prepare(`
    INSERT INTO optimizations
      (user_id, backtest_config, param_space, objective, n_trials, trials_completed,
       best_params, best_score, status)
    VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, 'pending')
  `).run(
    userId,
    JSON.stringify(cfg.baseConfig),
    JSON.stringify(cfg.paramSpace),
    cfg.objective || 'profitFactor',
    cfg.nTrials || 20,
  );
  const id = result.lastInsertRowid;

  // Enqueue async execution
  runQueue.add(async () => {
    try {
      await run(id);
    } catch (err) {
      logger.error('optimization run failed', { id, err: err.message });
      db.prepare(`
        UPDATE optimizations SET status = 'failed', completed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(id);
    }
  });

  return getOptimization(id, userId);
}

async function run(optId) {
  const row = db.prepare('SELECT * FROM optimizations WHERE id = ?').get(optId);
  if (!row) throw new Error('Optimization not found: ' + optId);

  db.prepare(`UPDATE optimizations SET status = 'running' WHERE id = ?`).run(optId);

  const baseConfig = JSON.parse(row.backtest_config);
  const paramSpace = JSON.parse(row.param_space);
  const objective = row.objective;
  const nTrials = row.n_trials;
  const method = Object.keys(paramSpace).length > 0 && Object.values(paramSpace).some((p) => p.type === 'choice' || p.step) ? 'grid' : 'random';

  let onProgress = (p) => {
    db.prepare(`UPDATE optimizations SET trials_completed = ? WHERE id = ?`)
      .run(p.done, optId);
  };

  const result = await optimizer.walkForward({
    baseConfig, paramSpace, objective, method,
    nTrials, maxCombos: Math.min(nTrials, 50),
    userId: row.user_id,
  });

  db.prepare(`
    UPDATE optimizations
    SET status = 'completed',
        trials_completed = ?,
        best_params = ?,
        best_score = ?,
        completed_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    result.trials,
    JSON.stringify({
      params: result.bestParams,
      trainScore: result.trainScore,
      valScore: result.valScore,
      testScore: result.testScore,
      overfit: result.overfit,
      split: result.split,
      topResults: result.allResults
        .filter((r) => Number.isFinite(r.score))
        .sort((a, b) => b.score - a.score)
        .slice(0, 10)
        .map((r) => ({ params: r.params, score: r.score })),
    }),
    result.bestScore,
    optId
  );
}

function getOptimization(id, userId) {
  const row = db.prepare('SELECT * FROM optimizations WHERE id = ? AND user_id = ?').get(id, userId);
  return row ? hydrate(row) : null;
}

function listForUser(userId, { limit = 50, offset = 0 } = {}) {
  const rows = db.prepare(`
    SELECT * FROM optimizations WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(userId, limit, offset);
  return rows.map(hydrate);
}

function deleteOptimization(id, userId) {
  const info = db.prepare('DELETE FROM optimizations WHERE id = ? AND user_id = ?').run(id, userId);
  if (info.changes === 0) {
    const err = new Error('Optimization not found'); err.statusCode = 404; throw err;
  }
  return { deleted: true };
}

function hydrate(row) {
  return {
    id: row.id,
    userId: row.user_id,
    baseConfig: safeJson(row.backtest_config, {}),
    paramSpace: safeJson(row.param_space, {}),
    objective: row.objective,
    nTrials: row.n_trials,
    trialsCompleted: row.trials_completed,
    bestParams: safeJson(row.best_params, null),
    bestScore: row.best_score,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    progressPct: row.n_trials > 0 ? Math.min(100, Math.round(row.trials_completed / row.n_trials * 100)) : 0,
  };
}

function safeJson(s, fb) { if (!s) return fb; try { return JSON.parse(s); } catch { return fb; } }

module.exports = {
  createOptimization,
  getOptimization,
  listForUser,
  deleteOptimization,
  _queue: runQueue,
};
