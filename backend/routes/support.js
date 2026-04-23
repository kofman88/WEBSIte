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

// ── Guest (unauthenticated) — MUST be declared BEFORE `router.use(authMiddleware)` ──
// Support widget's fallback for anonymous visitors. One-shot message;
// reply happens out-of-band via email. Rate-limited by IP in the route
// stack (express-rate-limit middleware applied at app level to /api/*).
router.post('/contact', (req, res, next) => {
  try {
    const body = z.object({
      email: z.string().trim().toLowerCase().email().max(254),
      body:  z.string().min(5).max(10000),
    }).parse(req.body);
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim().slice(0, 64);
    const ua = (req.headers['user-agent'] || '').toString().slice(0, 256);
    res.status(201).json(support.guestContact({ ...body, ip, userAgent: ua }));
  } catch (err) { handleErr(err, res, next); }
});

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
      // Widget auto-derives subject from the first 60 chars of body, so we
      // can't demand a longer subject than body. Keep 2 chars min on both
      // to allow short chat-style first messages like "привет", "где
      // кнопка?" while still rejecting empty / accidental sends.
      subject: z.string().min(2).max(200),
      body: z.string().min(2).max(10000),
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
    const body = z.object({
      body: z.string().min(1).max(10000),
      attachments: z.array(z.object({
        name: z.string().max(120),
        type: z.string().max(40),
        dataUrl: z.string().max(800_000),
      })).max(3).optional(),
    }).parse(req.body);
    res.json(support.reply(id, {
      userId: req.userId, body: body.body,
      isAdmin: Boolean(req.isAdmin),
      attachments: body.attachments || null,
    }));
  } catch (err) { handleErr(err, res, next); }
});

router.post('/tickets/:id/close', (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    res.json(support.closeTicket(id, { userId: req.userId, isAdmin: Boolean(req.isAdmin) }));
  } catch (err) { handleErr(err, res, next); }
});

// Mark thread as read from the user's side — widget calls this when
// opening the chat tab so unread badge clears.
router.post('/tickets/:id/mark-read', (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    res.json(support.markReadByUser(id, req.userId));
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

// Admin view of full thread — same route as user /tickets/:id but
// guarded differently (admin can see anyone's ticket).
router.get('/admin/tickets/:id', requireAdmin, (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    res.json(support.getForUser(id, req.userId, true));
  } catch (err) { handleErr(err, res, next); }
});

// Admin posts a reply — flows through the same reply() path so the WS
// broadcast + notifier dispatch fire for the user automatically.
router.post('/admin/tickets/:id/reply', requireAdmin, (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const body = z.object({
      body: z.string().min(1).max(10000),
      isInternal: z.boolean().optional().default(false),
      attachments: z.array(z.object({
        name: z.string().max(120),
        type: z.string().max(40),
        dataUrl: z.string().max(800_000),  // ~600KB base64 → ~450KB original
      })).max(3).optional(),
    }).parse(req.body);
    res.json(support.reply(id, {
      userId: req.userId,
      body: body.body,
      isAdmin: true,
      isInternal: body.isInternal,
      attachments: body.attachments || null,
    }));
  } catch (err) { handleErr(err, res, next); }
});

router.post('/admin/tickets/:id/mark-read', requireAdmin, (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    res.json(support.markReadByAdmin(id));
  } catch (err) { handleErr(err, res, next); }
});

// Assign ticket. Body may contain `targetAdminId` to assign to someone
// else; omitted = assign to self.
router.post('/admin/tickets/:id/assign', requireAdmin, (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const body = z.object({ targetAdminId: z.number().int().positive().optional() }).parse(req.body || {});
    res.json(support.assign(id, req.userId, body));
  } catch (err) { handleErr(err, res, next); }
});
router.post('/admin/tickets/:id/unassign', requireAdmin, (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    res.json(support.unassign(id, req.userId));
  } catch (err) { handleErr(err, res, next); }
});

// ── Canned-response templates (admin only) ──────────────────────────────
const templates = require('../services/supportTemplatesService');
router.get('/admin/templates', requireAdmin, (_req, res, next) => {
  try { res.json({ templates: templates.list() }); }
  catch (err) { handleErr(err, res, next); }
});
router.post('/admin/templates', requireAdmin, (req, res, next) => {
  try {
    const body = z.object({
      slug: z.string().trim().min(1).max(32),
      title: z.string().trim().min(1).max(100),
      body: z.string().trim().min(1).max(4000),
    }).parse(req.body);
    res.status(201).json(templates.create({ ...body, createdBy: req.userId }));
  } catch (err) { handleErr(err, res, next); }
});
router.patch('/admin/templates/:id', requireAdmin, (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const body = z.object({
      title: z.string().trim().min(1).max(100).optional(),
      body: z.string().trim().min(1).max(4000).optional(),
    }).parse(req.body);
    res.json(templates.update(id, body));
  } catch (err) { handleErr(err, res, next); }
});
router.delete('/admin/templates/:id', requireAdmin, (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    res.json(templates.remove(id));
  } catch (err) { handleErr(err, res, next); }
});
router.post('/admin/templates/:id/use', requireAdmin, (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    templates.bumpUseCount(id);
    res.json({ ok: true });
  } catch (err) { handleErr(err, res, next); }
});

// ── Agent presence — 30s ping from ops panel ───────────────────────────
const presence = require('../services/supportPresenceService');
router.post('/admin/presence/ping', requireAdmin, (req, res) => {
  presence.ping(req.userId);
  res.json({ ok: true });
});
router.get('/admin/presence/online', requireAdmin, (_req, res) => {
  res.json({ agents: presence.listOnlineAgents() });
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
