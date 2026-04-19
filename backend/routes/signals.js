const express = require('express');
const { z } = require('zod');
const { authMiddleware } = require('../middleware/auth');
const signalService = require('../services/signalService');
const validation = require('../utils/validation');
const plans = require('../config/plans');

const router = express.Router();

function handleErr(err, res, next) {
  if (err instanceof z.ZodError) {
    return res.status(400).json({
      error: 'Validation failed', code: 'VALIDATION_ERROR',
      issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  if (err && err.statusCode) {
    return res.status(err.statusCode).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
  return next(err);
}

router.get('/', authMiddleware, (req, res, next) => {
  try {
    const q = z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
      strategy: validation.strategy.optional(),
      symbol: z.string().toUpperCase().optional(),
    }).parse(req.query);

    if (signalService.freeDailyLimitHit(req.userId, req.userPlan)) {
      const limit = plans.getLimits(req.userPlan).signalsPerDay;
      return res.status(403).json({
        error: `Free plan limited to ${limit} signals per day. Upgrade for unlimited.`,
        code: 'SIGNAL_LIMIT_REACHED',
        currentPlan: req.userPlan,
        requiredPlan: 'starter',
      });
    }

    const list = signalService.listForUser(req.userId, q);
    res.json({ count: list.length, signals: list });
  } catch (err) { handleErr(err, res, next); }
});

router.get('/public', (req, res, next) => {
  try {
    const q = z.object({
      limit: z.coerce.number().int().min(1).max(20).default(10),
      strategy: validation.strategy.optional(),
    }).parse(req.query);
    const list = signalService.listPublic(q);
    res.json({ count: list.length, signals: list });
  } catch (err) { handleErr(err, res, next); }
});

router.get('/stats/me', authMiddleware, (req, res, next) => {
  try {
    res.json(signalService.stats(req.userId));
  } catch (err) { handleErr(err, res, next); }
});

router.get('/stats/global', (_req, res, next) => {
  try {
    res.json(signalService.stats(null));
  } catch (err) { handleErr(err, res, next); }
});

router.get('/prefs/me', authMiddleware, (req, res, next) => {
  try {
    res.json(signalService.getPrefs(req.userId));
  } catch (err) { handleErr(err, res, next); }
});

router.patch('/prefs/me', authMiddleware, (req, res, next) => {
  try {
    const patch = validation.signalPrefsSchema.parse(req.body);
    res.json(signalService.updatePrefs(req.userId, patch));
  } catch (err) { handleErr(err, res, next); }
});

router.get('/:id', authMiddleware, (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const sig = signalService.getById(id);
    if (!sig) return res.status(404).json({ error: 'Signal not found' });
    if (sig.userId && sig.userId !== req.userId) {
      return res.status(403).json({ error: 'Not your signal' });
    }
    signalService.trackView(req.userId, id);
    res.json(sig);
  } catch (err) { handleErr(err, res, next); }
});

module.exports = router;
