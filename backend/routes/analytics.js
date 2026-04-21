const express = require('express');
const { z } = require('zod');
const { authMiddleware } = require('../middleware/auth');
const analytics = require('../services/analyticsService');
const portfolio = require('../services/portfolioService');
const db = require('../models/database');

const router = express.Router();
router.use(authMiddleware);

const dateRangeSchema = z.object({
  from: z.string().datetime().or(z.string().regex(/^\d{4}-\d{2}-\d{2}/)).optional(),
  to: z.string().datetime().or(z.string().regex(/^\d{4}-\d{2}-\d{2}/)).optional(),
});

function handleErr(err, res, next) {
  if (err instanceof z.ZodError) {
    return res.status(400).json({ error: 'Validation failed', code: 'VALIDATION_ERROR', issues: err.issues });
  }
  if (err && err.statusCode) {
    return res.status(err.statusCode).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
  return next(err);
}

// ── Portfolio ──────────────────────────────────────────────────────────
router.get('/portfolio', async (req, res, next) => {
  try {
    const q = z.object({ fresh: z.coerce.boolean().default(false) }).parse(req.query);
    const out = await portfolio.getForUser(req.userId, { fresh: q.fresh });
    res.json(out);
  } catch (err) { handleErr(err, res, next); }
});

// ── Analytics ──────────────────────────────────────────────────────────
router.get('/summary', (req, res, next) => {
  try {
    const q = dateRangeSchema.parse(req.query);
    res.json({
      totals: analytics.totals(req.userId, q),
      byStrategy: analytics.byStrategy(req.userId, q),
    });
  } catch (err) { handleErr(err, res, next); }
});

router.get('/by-symbol', (req, res, next) => {
  try {
    const q = dateRangeSchema.parse(req.query);
    res.json({ symbols: analytics.bySymbol(req.userId, q) });
  } catch (err) { handleErr(err, res, next); }
});

router.get('/by-strategy', (req, res, next) => {
  try {
    const q = dateRangeSchema.parse(req.query);
    res.json({ strategies: analytics.byStrategy(req.userId, q) });
  } catch (err) { handleErr(err, res, next); }
});

router.get('/by-month', (req, res, next) => {
  try {
    const q = dateRangeSchema.parse(req.query);
    res.json({ months: analytics.byMonth(req.userId, q) });
  } catch (err) { handleErr(err, res, next); }
});

router.get('/equity-curve', (req, res, next) => {
  try {
    const q = z.object({ days: z.coerce.number().int().min(1).max(730).default(90) }).parse(req.query);
    res.json({ points: analytics.equityCurve(req.userId, q) });
  } catch (err) { handleErr(err, res, next); }
});

// ── CSV export ─────────────────────────────────────────────────────────
router.get('/trades/export.csv', (req, res, next) => {
  try {
    const q = dateRangeSchema.parse(req.query);
    analytics.csvStream(req.userId, res, q);
  } catch (err) { handleErr(err, res, next); }
});

// ── Trades list (shared with journal drawer) ──────────────────────────
router.get('/trades', (req, res, next) => {
  try {
    const q = z.object({
      limit: z.coerce.number().int().min(1).max(500).default(50),
      offset: z.coerce.number().int().min(0).default(0),
      symbol: z.string().max(32).optional(),
      status: z.enum(['open', 'closed', 'cancelled']).optional(),
      side: z.enum(['long', 'short']).optional(),
      from: z.string().optional(),
      to: z.string().optional(),
    }).parse(req.query);

    const parts = ['user_id = ?'];
    const params = [req.userId];
    if (q.symbol) { parts.push('symbol = ?'); params.push(q.symbol.toUpperCase()); }
    if (q.status) { parts.push('status = ?'); params.push(q.status); }
    if (q.side)   { parts.push('side = ?'); params.push(q.side); }
    if (q.from)   { parts.push('opened_at >= ?'); params.push(q.from); }
    if (q.to)     { parts.push('opened_at <= ?'); params.push(q.to); }
    const where = 'WHERE ' + parts.join(' AND ');

    const total = db.prepare(`SELECT COUNT(*) as n FROM trades ${where}`).get(...params).n;
    const rows = db.prepare(`
      SELECT id, opened_at, closed_at, exchange, symbol, side, strategy,
             entry_price, exit_price, quantity, leverage, stop_loss,
             take_profit_1, take_profit_2, take_profit_3,
             status, close_reason, realized_pnl, realized_pnl_pct, trading_mode, note
      FROM trades ${where}
      ORDER BY opened_at DESC LIMIT ? OFFSET ?
    `).all(...params, q.limit, q.offset);

    res.json({
      total,
      trades: rows.map((r) => ({
        id: r.id, openedAt: r.opened_at, closedAt: r.closed_at,
        exchange: r.exchange, symbol: r.symbol, side: r.side, strategy: r.strategy,
        entryPrice: r.entry_price, exitPrice: r.exit_price, quantity: r.quantity,
        leverage: r.leverage, stopLoss: r.stop_loss,
        tp1: r.take_profit_1, tp2: r.take_profit_2, tp3: r.take_profit_3,
        status: r.status, closeReason: r.close_reason,
        realizedPnl: r.realized_pnl, realizedPnlPct: r.realized_pnl_pct,
        tradingMode: r.trading_mode, note: r.note,
      })),
    });
  } catch (err) { handleErr(err, res, next); }
});

// ── Dashboard v2 — advanced metrics aggregate ─────────────────────────
const adv = require('../services/advancedAnalytics');

router.get('/dashboard-v2', (req, res, next) => {
  try { res.json(adv.dashboardStats(req.userId)); }
  catch (err) { handleErr(err, res, next); }
});

router.get('/open-positions', (req, res, next) => {
  try { res.json({ positions: adv.openPositions(req.userId), riskExposure: adv.riskExposure(req.userId) }); }
  catch (err) { handleErr(err, res, next); }
});

router.get('/calendar-pnl', (req, res, next) => {
  try {
    const q = z.object({ days: z.coerce.number().int().min(7).max(365).default(180) }).parse(req.query);
    res.json({ days: q.days, points: adv.calendarPnl(req.userId, q) });
  } catch (err) { handleErr(err, res, next); }
});

router.get('/hourly-pnl', (req, res, next) => {
  try {
    const q = z.object({ days: z.coerce.number().int().min(7).max(365).default(90) }).parse(req.query);
    res.json({ days: q.days, hours: adv.hourlyPnl(req.userId, q) });
  } catch (err) { handleErr(err, res, next); }
});

router.get('/bot-leaderboard', (req, res, next) => {
  try {
    const q = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).parse(req.query);
    res.json({ bots: adv.botLeaderboard(req.userId, q) });
  } catch (err) { handleErr(err, res, next); }
});

router.get('/btc-benchmark', (req, res, next) => {
  try {
    const q = z.object({ days: z.coerce.number().int().min(7).max(365).default(90) }).parse(req.query);
    res.json({ points: adv.btcBenchmark(q) });
  } catch (err) { handleErr(err, res, next); }
});

router.get('/percentile', (req, res, next) => {
  try {
    const q = z.object({ period: z.enum(['7d', '30d', '90d', '1y']).default('30d') }).parse(req.query);
    res.json({ percentile: adv.leaderboardPercentile(req.userId, q) });
  } catch (err) { handleErr(err, res, next); }
});

// ── Trade journal note ─────────────────────────────────────────────────
router.patch('/trades/:id/note', (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const body = z.object({ note: z.string().max(4000).nullable().optional() }).parse(req.body);
    res.json(analytics.setNote(req.userId, id, body.note ?? ''));
  } catch (err) { handleErr(err, res, next); }
});

module.exports = router;
