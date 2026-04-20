const express = require('express');
const { z } = require('zod');
const leaderboard = require('../services/leaderboardService');

const router = express.Router();

// Public — no auth, rate-limited only by the global /api limiter
router.get('/leaderboard', (req, res, next) => {
  try {
    const q = z.object({
      period: z.enum(['7d', '30d', '90d', '1y', 'all']).default('30d'),
      sort: z.enum(['pnl', 'winrate', 'sharpe', 'roi']).default('pnl'),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }).parse(req.query);
    res.json({ period: q.period, sort: q.sort, traders: leaderboard.topTraders(q) });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Validation failed', issues: err.issues });
    next(err);
  }
});

router.get('/u/:code', (req, res, next) => {
  try {
    const code = z.string().trim().regex(/^[A-Z0-9]{4,12}$/i).parse(req.params.code);
    const profile = leaderboard.publicProfile(code);
    if (!profile) return res.status(404).json({ error: 'Profile not public or does not exist' });
    res.json(profile);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Invalid referral code' });
    next(err);
  }
});

module.exports = router;
