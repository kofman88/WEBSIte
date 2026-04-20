const express = require('express');
const { z } = require('zod');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const support = require('../services/supportService');
const leaderboard = require('../services/leaderboardService');

const router = express.Router();

function handleErr(err, res, next) {
  if (err instanceof z.ZodError) {
    return res.status(400).json({ error: 'Validation failed', issues: err.issues });
  }
  if (err && err.statusCode) return res.status(err.statusCode).json({ error: err.message });
  return next(err);
}

// ── User-facing ───────────────────────────────────────────────────────
router.use(authMiddleware);

router.get('/tickets', (req, res, next) => {
  try {
    const q = z.object({
      status: z.enum(['open', 'pending', 'closed']).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);
    res.json({ tickets: support.listForUser(req.userId, q) });
  } catch (err) { handleErr(err, res, next); }
});

router.post('/tickets', (req, res, next) => {
  try {
    const body = z.object({
      subject: z.string().min(3).max(200),
      body: z.string().min(10).max(10000),
    }).parse(req.body);
    res.status(201).json(support.create(req.userId, body));
  } catch (err) { handleErr(err, res, next); }
});

router.get('/tickets/:id', (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    res.json(support.getForUser(id, req.userId, req.isAdmin));
  } catch (err) { handleErr(err, res, next); }
});

router.post('/tickets/:id/reply', (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const body = z.object({ body: z.string().min(1).max(10000) }).parse(req.body);
    res.json(support.reply(id, { userId: req.userId, body: body.body, isAdmin: Boolean(req.isAdmin) }));
  } catch (err) { handleErr(err, res, next); }
});

router.post('/tickets/:id/close', (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    res.json(support.closeTicket(id, { userId: req.userId, isAdmin: Boolean(req.isAdmin) }));
  } catch (err) { handleErr(err, res, next); }
});

// ── Admin ─────────────────────────────────────────────────────────────
router.get('/admin/tickets', requireAdmin, (req, res, next) => {
  try {
    const q = z.object({
      status: z.enum(['open', 'pending', 'closed']).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);
    res.json({ tickets: support.listAll(q) });
  } catch (err) { handleErr(err, res, next); }
});

// ── Profile privacy toggle (lives here to keep all "community" endpoints together) ──
router.put('/profile/public', (req, res, next) => {
  try {
    const body = z.object({ enabled: z.boolean() }).parse(req.body);
    res.json(leaderboard.setPublicProfile(req.userId, body.enabled));
  } catch (err) { handleErr(err, res, next); }
});

// ── Paper-trading starting balance ───────────────────────────────────────
// Users configure their own "virtual account" — used for equity-curve
// baseline on the dashboard + analytics page. $100 min, $10M max to
// keep P&L% math reasonable.
router.put('/profile/paper-balance', (req, res, next) => {
  try {
    const body = z.object({ amount: z.number().min(100).max(10_000_000) }).parse(req.body);
    const db = require('../models/database');
    db.prepare(`UPDATE users SET paper_starting_balance = ? WHERE id = ?`).run(body.amount, req.userId);
    res.json({ paperStartingBalance: body.amount });
  } catch (err) { handleErr(err, res, next); }
});

module.exports = router;
