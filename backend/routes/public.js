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

// Public market context — BTC/ETH spot + fear & greed + funding
const marketContext = require('../services/marketContextService');
router.get('/market-context', async (_req, res) => {
  try { res.json(await marketContext.summary()); }
  catch (_e) { res.json({ tickers: null, fearGreed: null, funding: null }); }
});

// Bot showcase for the homepage (SITE_MODE=bot): strategy rating + recent
// delivered signals, straight from the bot, cached 5 min in botBridge.
const botBridge = require('../services/botBridge');
router.get('/bot-stats', async (_req, res) => {
  if (!botBridge.enabled()) return res.status(404).json({ error: 'Bot shell disabled', code: 'NOT_FOUND' });
  try {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(await botBridge.publicStats());
  } catch (err) {
    res.status(err.statusCode || 503).json({ error: 'Статистика бота временно недоступна', code: err.code || 'BOT_UNAVAILABLE' });
  }
});

// Static pages (index / pricing) read their runtime config here: which bot
// the Login Widget talks to, which payment methods are on, the Pro price.
router.get('/site-config', (_req, res) => {
  const config = require('../config');
  const plans = require('../config/plans');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json({
    botShell: botBridge.enabled(),
    loginBot: (config.botShell && config.botShell.loginBot) || process.env.TELEGRAM_BOT_USERNAME || '',
    appPath: '/app/',
    priceUsd: plans.PLANS.pro.priceUsd,
    yearlyDiscount: 0.2,
    payments: {
      stripe: Boolean(config.stripeSecretKey),
      cryptoBep20: Boolean(config.paymentBep20Address),
      cryptoTrc20: Boolean(config.paymentTrc20Address),
    },
  });
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
