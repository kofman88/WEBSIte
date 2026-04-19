const express = require('express');
const { z } = require('zod');
const { authMiddleware } = require('../middleware/auth');
const botService = require('../services/botService');
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

router.get('/', authMiddleware, (req, res, next) => {
  try {
    res.json({ bots: botService.listForUser(req.userId) });
  } catch (err) { handleErr(err, res, next); }
});

router.get('/summary', authMiddleware, (req, res, next) => {
  try {
    res.json(botService.userSummary(req.userId));
  } catch (err) { handleErr(err, res, next); }
});

router.post('/', authMiddleware, (req, res, next) => {
  try {
    const input = validation.createBotSchema.parse(req.body);
    const bot = botService.createBot(req.userId, input);
    res.status(201).json(bot);
  } catch (err) { handleErr(err, res, next); }
});

router.get('/:id', authMiddleware, (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const bot = botService.getBot(id, req.userId);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    res.json(bot);
  } catch (err) { handleErr(err, res, next); }
});

router.patch('/:id', authMiddleware, (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const patch = validation.updateBotSchema.parse(req.body);
    res.json(botService.updateBot(id, req.userId, patch));
  } catch (err) { handleErr(err, res, next); }
});

router.post('/:id/toggle', authMiddleware, (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    res.json(botService.toggleActive(id, req.userId));
  } catch (err) { handleErr(err, res, next); }
});

router.delete('/:id', authMiddleware, (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    res.json(botService.deleteBot(id, req.userId));
  } catch (err) { handleErr(err, res, next); }
});

router.get('/:id/trades', authMiddleware, (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const q = z.object({
      limit: z.coerce.number().int().min(1).max(500).default(100),
      offset: z.coerce.number().int().min(0).default(0),
      status: z.enum(['open', 'closed', 'cancelled', 'liquidated']).optional(),
    }).parse(req.query);
    const trades = botService.getBotTrades(id, req.userId, q);
    if (trades === null) return res.status(404).json({ error: 'Bot not found' });
    res.json({ count: trades.length, trades });
  } catch (err) { handleErr(err, res, next); }
});

router.get('/:id/stats', authMiddleware, (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const stats = botService.getBotStats(id, req.userId);
    if (!stats) return res.status(404).json({ error: 'Bot not found' });
    res.json(stats);
  } catch (err) { handleErr(err, res, next); }
});

module.exports = router;
