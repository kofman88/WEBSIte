const express = require('express');
const { z } = require('zod');
const { authMiddleware } = require('../middleware/auth');
const riskLimits = require('../services/riskLimitsService');
const handleErr = require('../middleware/handleErr');

const router = express.Router();

router.use(authMiddleware);

// GET /api/risk/limits — current user's limits (lazy-inserted with defaults)
router.get('/limits', (req, res, next) => {
  try {
    res.json(riskLimits.get(req.userId));
  } catch (err) { handleErr(err, res, next); }
});

// PATCH /api/risk/limits — partial update
router.patch('/limits', (req, res, next) => {
  try {
    const patch = z.object({
      killSwitchEnabled: z.boolean().optional(),
      maxOpenPositions: z.number().int().min(1).max(500).optional(),
      maxDailyLossPct:  z.number().min(0.1).max(50).optional(),
      blacklistedSymbols: z.array(z.string().min(1).max(32)).max(100).optional(),
    }).parse(req.body);
    res.json(riskLimits.update(req.userId, patch));
  } catch (err) { handleErr(err, res, next); }
});

module.exports = router;
