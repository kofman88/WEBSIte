const express = require('express');
const { z } = require('zod');
const { authMiddleware } = require('../middleware/auth');
const backtestService = require('../services/backtestService');
const validation = require('../utils/validation');

const router = express.Router();

function handleErr(err, res, next) {
  if (err instanceof z.ZodError) {
    return res.status(400).json({
      error: 'Validation failed', code: 'VALIDATION_ERROR',
      issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  if (err && err.statusCode) {
    return res.status(err.statusCode).json({
      error: err.message,
      ...(err.code ? { code: err.code } : {}),
      ...(err.requiredPlan ? { requiredPlan: err.requiredPlan } : {}),
    });
  }
  return next(err);
}

// POST /api/backtests — create + enqueue
router.post('/', authMiddleware, (req, res, next) => {
  try {
    const input = validation.createBacktestSchema.parse(req.body);
    const bt = backtestService.createBacktest(req.userId, input);
    res.status(201).json(bt);
  } catch (err) { handleErr(err, res, next); }
});

// GET /api/backtests — list
router.get('/', authMiddleware, (req, res, next) => {
  try {
    const q = z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);
    const list = backtestService.listForUser(req.userId, q);
    res.json({ count: list.length, backtests: list });
  } catch (err) { handleErr(err, res, next); }
});

// GET /api/backtests/stats
router.get('/stats', authMiddleware, (req, res, next) => {
  try {
    res.json(backtestService.stats(req.userId));
  } catch (err) { handleErr(err, res, next); }
});

// GET /api/backtests/:id
router.get('/:id', authMiddleware, (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const bt = backtestService.getBacktest(id, req.userId);
    if (!bt) return res.status(404).json({ error: 'Backtest not found' });
    res.json(bt);
  } catch (err) { handleErr(err, res, next); }
});

// GET /api/backtests/:id/trades — per-trade detail (paginated)
router.get('/:id/trades', authMiddleware, (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const q = z.object({
      limit: z.coerce.number().int().min(1).max(2000).default(500),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);
    const trades = backtestService.getTradesForBacktest(id, req.userId, q);
    if (trades === null) return res.status(404).json({ error: 'Backtest not found' });
    res.json({ count: trades.length, trades });
  } catch (err) { handleErr(err, res, next); }
});

// DELETE /api/backtests/:id
router.delete('/:id', authMiddleware, (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    res.json(backtestService.deleteBacktest(id, req.userId));
  } catch (err) { handleErr(err, res, next); }
});

module.exports = router;
