/**
 * AI-assistant endpoints — Gemini-backed chat for educational Q&A.
 * Auth required (Free+ plan). Free tier is 20 msg/day; see aiService.
 */
const express = require('express');
const { z } = require('zod');
const { authMiddleware } = require('../middleware/auth');
const ai = require('../services/aiService');

const router = express.Router();
router.use(authMiddleware);

function handleErr(err, res, next) {
  if (err instanceof z.ZodError) return res.status(400).json({ error: 'Validation failed', issues: err.issues });
  if (err && err.statusCode) return res.status(err.statusCode).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  return next(err);
}

router.post('/chat', async (req, res, next) => {
  try {
    const body = z.object({
      message: z.string().min(2).max(2000),
      history: z.array(z.object({
        role: z.enum(['user', 'assistant', 'model']),
        content: z.string().max(2000),
      })).max(20).optional().default([]),
    }).parse(req.body);

    const plan = req.userPlan || 'free';
    const result = await ai.ask({
      userId: req.userId,
      plan,
      message: body.message,
      history: body.history,
    });
    res.json(result);
  } catch (err) { handleErr(err, res, next); }
});

// Meta endpoint — exposes the daily limit + current count so the widget
// can render "X / Y" before sending anything.
router.get('/usage', (req, res) => {
  const plan = req.userPlan || 'free';
  res.json({
    requestsToday: ai.getCount(req.userId),
    requestsLimit: ai.limitForPlan(plan),
    plan,
    enabled: Boolean(process.env.GEMINI_API_KEY),
  });
});

module.exports = router;
