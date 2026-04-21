const express = require('express');
const { z } = require('zod');
const { authMiddleware, tierLimiter } = require('../middleware/auth');

// Smart Trade & bot-toggle touch exchange APIs — keep tight per-plan caps
// so a runaway client loop doesn't drain the user's exchange rate budget.
const writeCap = tierLimiter({ free: 10, starter: 30, pro: 120, elite: 600 }, '1m');
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

router.post('/:id/toggle', authMiddleware, writeCap, (req, res, next) => {
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

// ── TradingView webhook management ─────────────────────────────────────
const tvWebhook = require('../services/tvWebhookService');
router.get('/:id/tv-webhook', authMiddleware, (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const secret = tvWebhook.getSecret(id, req.userId);
    res.json({ url: tvWebhook.buildUrl(id), secret });
  } catch (err) { handleErr(err, res, next); }
});

router.post('/:id/tv-webhook/rotate', authMiddleware, (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const secret = tvWebhook.rotateSecret(id, req.userId);
    res.json({ url: tvWebhook.buildUrl(id), secret });
  } catch (err) { handleErr(err, res, next); }
});

// ── Manual (smart) trade — creates a bot-less trade ────────────────────
const manualTrade = require('../services/manualTradeService');
router.post('/manual-trade', authMiddleware, writeCap, (req, res, next) => {
  try {
    const input = z.object({
      exchangeKeyId: z.coerce.number().int().positive().optional(),
      exchange: z.string().max(32).optional(),
      symbol: z.string().min(3).max(32),
      side: z.enum(['long', 'short']),
      quantity: z.coerce.number().positive(),
      entryPrice: z.coerce.number().positive(),
      stopLoss: z.coerce.number().positive(),
      takeProfit1: z.coerce.number().positive().optional(),
      takeProfit2: z.coerce.number().positive().optional(),
      takeProfit3: z.coerce.number().positive().optional(),
      leverage: z.coerce.number().int().min(1).max(125).default(1),
      tradingMode: z.enum(['paper', 'live']).default('paper'),
      note: z.string().max(2000).optional(),
    }).parse(req.body);
    const trade = manualTrade.create(req.userId, input);
    res.status(201).json(trade);
  } catch (err) { handleErr(err, res, next); }
});

// ── Strategy schemas (drives wizard config form) ───────────────────────
const schemas = require('../services/strategySchemas');
router.get('/strategy-schemas', authMiddleware, (_req, res) => {
  res.json({ strategies: schemas.listStrategies() });
});
router.get('/strategy-schema/:key', authMiddleware, (req, res) => {
  const s = schemas.getSchema(req.params.key);
  if (!s) return res.status(404).json({ error: 'Unknown strategy' });
  res.json(s);
});

// ── Inline quick-backtest — runs a backtest with the wizard config ─────
// Used by the wizard before final "Create bot" step so operator sees
// how the config would've performed on last N days of history.
const backtestService = require('../services/backtestService');
router.post('/quick-backtest', authMiddleware, writeCap, (req, res, next) => {
  try {
    const input = z.object({
      symbol: z.string().min(3).max(32),
      strategy: z.string().min(1).max(32),
      timeframe: z.string().min(1).max(8),
      exchange: z.string().min(2).max(32).default('bybit'),
      days: z.coerce.number().int().min(7).max(180).default(60),
      direction: z.enum(['long', 'short', 'both']).default('both'),
      strategyConfig: z.record(z.any()).optional().default({}),
      leverage: z.coerce.number().int().min(1).max(100).default(1),
      riskPct: z.coerce.number().min(0.1).max(10).default(1),
    }).parse(req.body);

    const startDate = new Date(Date.now() - input.days * 86_400_000).toISOString().slice(0, 10);
    const endDate   = new Date().toISOString().slice(0, 10);

    const bt = backtestService.createBacktest(req.userId, {
      name: 'wizard-preview-' + Date.now(),
      exchange: input.exchange,
      symbols: [input.symbol],
      strategy: input.strategy,
      timeframe: input.timeframe,
      direction: input.direction,
      leverage: input.leverage,
      riskPct: input.riskPct,
      startDate, endDate,
      initialCapital: 10000,
      strategyConfig: input.strategyConfig,
    });
    res.json(bt);
  } catch (err) { handleErr(err, res, next); }
});

module.exports = router;
