const express = require('express');
const { z } = require('zod');
const { authMiddleware } = require('../middleware/auth');
const copy = require('../services/copyTradingService');
const handleErr = require('../middleware/handleErr');

const router = express.Router();
router.use(authMiddleware);

router.post('/subscribe', (req, res, next) => {
  try {
    const body = z.object({
      leaderCode: z.string().trim().regex(/^[A-Z0-9]{4,12}$/i),
      mode: z.enum(['paper', 'live']).default('paper'),
      riskMult: z.number().min(0.01).max(5).default(1),
    }).parse(req.body);
    res.json(copy.subscribe(req.userId, body));
  } catch (err) { handleErr(err, res, next); }
});

router.post('/unsubscribe', (req, res, next) => {
  try {
    const body = z.object({ leaderId: z.number().int().positive() }).parse(req.body);
    res.json(copy.unsubscribe(req.userId, body.leaderId));
  } catch (err) { handleErr(err, res, next); }
});

router.get('/following', (req, res, next) => {
  try { res.json({ following: copy.listFollowing(req.userId) }); }
  catch (err) { handleErr(err, res, next); }
});

module.exports = router;
