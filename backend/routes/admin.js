const express = require('express');
const { z } = require('zod');
const { authMiddleware, requireAdmin, requireCapability, ADMIN_ROLES } = require('../middleware/auth');
const admin = require('../services/adminService');
const refRewards = require('../services/refRewards');
const validation = require('../utils/validation');

const router = express.Router();

// ALL routes require authed admin
router.use(authMiddleware, requireAdmin);

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

// ── Users ──────────────────────────────────────────────────────────────
router.get('/users', (req, res, next) => {
  try {
    const q = z.object({
      search: z.string().max(100).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);
    res.json(admin.listUsers(q));
  } catch (err) { handleErr(err, res, next); }
});

router.get('/users/:id', (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const user = admin.getUser(id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) { handleErr(err, res, next); }
});

router.patch('/users/:id/active', requireCapability('user.block'), (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const body = z.object({ isActive: z.boolean() }).parse(req.body);
    res.json(admin.setUserActive(id, body.isActive, { adminId: req.userId }));
  } catch (err) { handleErr(err, res, next); }
});

router.patch('/users/:id/plan', requireCapability('user.plan_change'), (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const body = z.object({
      plan: validation.plan,
      durationDays: z.number().int().min(1).max(3650).default(30),
    }).parse(req.body);
    res.json(admin.setUserPlan(id, body.plan, { adminId: req.userId, durationDays: body.durationDays }));
  } catch (err) { handleErr(err, res, next); }
});

// ── Payments ───────────────────────────────────────────────────────────
router.get('/payments', (req, res, next) => {
  try {
    const q = z.object({
      status: z.enum(['pending', 'confirmed', 'failed', 'refunded']).optional(),
      method: z.enum(['stripe', 'usdt_bep20', 'usdt_trc20', 'promo']).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);
    res.json(admin.listPayments(q));
  } catch (err) { handleErr(err, res, next); }
});

router.post('/payments/:id/confirm', requireCapability('payment.confirm'), (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const body = z.object({ note: z.string().max(500).optional() }).parse(req.body || {});
    res.json(admin.manualConfirmPayment(id, { adminId: req.userId, note: body.note }));
  } catch (err) { handleErr(err, res, next); }
});

router.post('/payments/:id/refund', requireCapability('payment.refund'), (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const body = z.object({ reason: z.string().max(500).optional() }).parse(req.body || {});
    res.json(admin.refundPayment(id, { adminId: req.userId, reason: body.reason }));
  } catch (err) { handleErr(err, res, next); }
});

// ── Promo codes ────────────────────────────────────────────────────────
router.get('/promo-codes', (_req, res, next) => {
  try { res.json({ codes: admin.listPromoCodes() }); }
  catch (err) { handleErr(err, res, next); }
});

router.post('/promo-codes', requireCapability('promo.write'), (req, res, next) => {
  try {
    const body = z.object({
      code: z.string().trim().regex(/^[A-Z0-9]{4,32}$/i),
      plan: validation.plan.exclude(['free']),
      durationDays: z.number().int().min(1).max(3650),
      maxUses: z.number().int().min(0).max(100000),
      discountPct: z.number().int().min(1).max(100).default(100),
      expiresAt: z.string().datetime().optional(),
    }).parse(req.body);
    res.status(201).json(admin.createPromoCode(body, { adminId: req.userId }));
  } catch (err) { handleErr(err, res, next); }
});

router.patch('/promo-codes/:id/active', requireCapability('promo.write'), (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const body = z.object({ isActive: z.boolean() }).parse(req.body);
    res.json(admin.setPromoActive(id, body.isActive, { adminId: req.userId }));
  } catch (err) { handleErr(err, res, next); }
});

router.delete('/promo-codes/:id', requireCapability('promo.write'), (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    res.json(admin.deletePromo(id, { adminId: req.userId }));
  } catch (err) { handleErr(err, res, next); }
});

// ── Ref rewards ────────────────────────────────────────────────────────
router.get('/ref-rewards', (req, res, next) => {
  try {
    const q = z.object({
      status: z.enum(['pending', 'paid', 'cancelled']).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);
    res.json({ rewards: admin.listAllRewards(q) });
  } catch (err) { handleErr(err, res, next); }
});

router.post('/ref-rewards/:id/pay', requireCapability('reward.payout'), (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    res.json(refRewards.markPaid(id, { adminUserId: req.userId }));
  } catch (err) { handleErr(err, res, next); }
});

router.post('/ref-rewards/:id/cancel', requireCapability('reward.payout'), (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const body = z.object({ reason: z.string().max(500).optional() }).parse(req.body || {});
    refRewards.cancel(id, { adminUserId: req.userId, reason: body.reason });
    res.json({ success: true });
  } catch (err) { handleErr(err, res, next); }
});

// ── Back-office dashboards & drill-downs ───────────────────────────────
router.get('/dashboard', (_req, res, next) => {
  try { res.json(admin.opsDashboard()); } catch (err) { handleErr(err, res, next); }
});

router.get('/audit-analytics', (req, res, next) => {
  try {
    const q = z.object({ days: z.coerce.number().int().min(1).max(90).default(14) }).parse(req.query);
    res.json(admin.auditAnalytics(q));
  } catch (err) { handleErr(err, res, next); }
});

router.get('/billing-analytics', (_req, res, next) => {
  try { res.json(admin.billingAnalytics()); } catch (err) { handleErr(err, res, next); }
});

router.get('/revenue-timeseries', (req, res, next) => {
  try {
    const q = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).parse(req.query);
    res.json({ days: q.days, points: admin.revenueTimeseries(q) });
  } catch (err) { handleErr(err, res, next); }
});

router.get('/users/:id/detail', (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    res.json(admin.userDetail(id));
  } catch (err) { handleErr(err, res, next); }
});

router.get('/bots', (req, res, next) => {
  try {
    const q = z.object({
      status: z.enum(['active', 'inactive']).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);
    res.json({ bots: admin.listAllBots(q) });
  } catch (err) { handleErr(err, res, next); }
});

router.get('/trades', (req, res, next) => {
  try {
    const q = z.object({
      status: z.enum(['open', 'closed', 'cancelled']).optional(),
      mode: z.enum(['paper', 'live']).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);
    res.json({ trades: admin.listAllTrades(q) });
  } catch (err) { handleErr(err, res, next); }
});

router.get('/signals', (req, res, next) => {
  try {
    const q = z.object({
      strategy: z.string().max(32).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);
    res.json({ signals: admin.listAllSignals(q) });
  } catch (err) { handleErr(err, res, next); }
});

router.get('/system', (_req, res, next) => {
  try { res.json(admin.systemInfo()); } catch (err) { handleErr(err, res, next); }
});

// ── Feature flags ──────────────────────────────────────────────────────
const featureFlags = require('../services/featureFlagsService');
router.get('/flags', (_req, res, next) => {
  try { res.json({ flags: featureFlags.all() }); }
  catch (err) { handleErr(err, res, next); }
});
router.patch('/flags/:key', requireCapability('*'), (req, res, next) => {
  try {
    const key = z.string().min(1).max(64).parse(req.params.key);
    const body = z.object({ value: z.boolean() }).parse(req.body);
    res.json(featureFlags.setFlag(key, body.value, { adminId: req.userId }));
  } catch (err) { handleErr(err, res, next); }
});

// Admin → dispatch a notification to a user (in-app + email + TG via notifier)
router.post('/users/:id/notify', requireCapability('user.notify'), (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const body = z.object({
      type: z.enum(['security', 'payment', 'trade', 'referral', 'support', 'system']).default('system'),
      title: z.string().min(1).max(200),
      body: z.string().min(1).max(5000),
      link: z.string().max(500).optional(),
    }).parse(req.body);
    const notifier = require('../services/notifier');
    notifier.dispatch(id, body);
    // Audit the outbound message for traceability.
    require('../models/database').prepare(`
      INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
      VALUES (?, 'admin.user.notify', 'user', ?, ?)
    `).run(req.userId, id, JSON.stringify({ type: body.type, title: body.title }));
    res.json({ sent: true });
  } catch (err) { handleErr(err, res, next); }
});

// Admin → impersonate user. Returns a short-lived access token (30 min, no
// refresh) that carries { uid: <target>, imp: <adminId> } — middleware sees
// the target userId as normal, but downstream code + audit entries can read
// req.impersonatedBy to flag the trail. The admin's own session is
// unchanged — they keep it in a parallel tab / localStorage entry.
const jwt = require('jsonwebtoken');
const config = require('../config');
router.post('/users/:id/impersonate', requireCapability('impersonate'), (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const body = z.object({ reason: z.string().min(3).max(500) }).parse(req.body);
    const db = require('../models/database');
    const target = db.prepare(`SELECT id, email, is_active FROM users WHERE id = ?`).get(id);
    if (!target)           return res.status(404).json({ error: 'User not found' });
    if (target.is_admin)   return res.status(403).json({ error: 'Cannot impersonate another admin' });
    const token = jwt.sign(
      { uid: target.id, imp: req.userId },
      config.jwtSecret,
      { expiresIn: '30m', algorithm: 'HS256' },
    );
    db.prepare(`
      INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata, ip_address, user_agent)
      VALUES (?, 'admin.user.impersonate', 'user', ?, ?, ?, ?)
    `).run(req.userId, target.id, JSON.stringify({ reason: body.reason }), req.ip, req.get('user-agent'));
    res.json({ accessToken: token, expiresIn: 1800, targetEmail: target.email, reason: body.reason });
  } catch (err) { handleErr(err, res, next); }
});

// Admin → promote/demote admin flag. Extremely audited. Cannot demote self
// while you're the last admin — server computes that.
// List available sub-roles + capability matrix (for ops UI dropdown).
router.get('/roles', (_req, res) => {
  res.json({
    roles: Object.keys(ADMIN_ROLES).map((name) => ({
      name, capabilities: ADMIN_ROLES[name],
    })),
  });
});

// Set sub-role on an existing admin. Only superadmin (*) may do this,
// and we refuse to demote the last superadmin via this path as well.
router.patch('/users/:id/admin-role', requireCapability('*'), (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const body = z.object({ role: z.enum(Object.keys(ADMIN_ROLES)).nullable() }).parse(req.body);
    const db = require('../models/database');
    const target = db.prepare(`SELECT is_admin, admin_role FROM users WHERE id = ?`).get(id);
    if (!target || !target.is_admin) return res.status(404).json({ error: 'User is not an admin' });
    if (target.admin_role === 'superadmin' && body.role !== 'superadmin') {
      const superCount = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND admin_role = 'superadmin'`).get().n;
      if (superCount <= 1) return res.status(400).json({ error: 'Cannot demote the last superadmin', code: 'LAST_SUPERADMIN' });
    }
    db.prepare(`UPDATE users SET admin_role = ? WHERE id = ?`).run(body.role, id);
    db.prepare(`
      INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
      VALUES (?, 'admin.user.role_change', 'user', ?, ?)
    `).run(req.userId, id, JSON.stringify({ role: body.role }));
    res.json({ id, adminRole: body.role });
  } catch (err) { handleErr(err, res, next); }
});

router.patch('/users/:id/admin', requireCapability('*'), (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const body = z.object({
      isAdmin: z.boolean(),
      role: z.enum(Object.keys(ADMIN_ROLES)).optional(),
    }).parse(req.body);
    const db = require('../models/database');
    if (!body.isAdmin) {
      const superCount = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND admin_role = 'superadmin'`).get().n;
      const target = db.prepare(`SELECT admin_role FROM users WHERE id = ?`).get(id);
      if (target && target.admin_role === 'superadmin' && superCount <= 1) {
        return res.status(400).json({ error: 'Cannot demote the last superadmin', code: 'LAST_SUPERADMIN' });
      }
    }
    const role = body.isAdmin ? (body.role || 'support') : null;
    db.prepare(`UPDATE users SET is_admin = ?, admin_role = ? WHERE id = ?`)
      .run(body.isAdmin ? 1 : 0, role, id);
    db.prepare(`
      INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
      VALUES (?, 'admin.user.grant_admin', 'user', ?, ?)
    `).run(req.userId, id, JSON.stringify({ isAdmin: body.isAdmin, role }));
    res.json({ id, isAdmin: body.isAdmin, adminRole: role });
  } catch (err) { handleErr(err, res, next); }
});

// ── System ─────────────────────────────────────────────────────────────
router.get('/stats', (_req, res, next) => {
  try { res.json(admin.systemStats()); }
  catch (err) { handleErr(err, res, next); }
});

router.get('/audit', (req, res, next) => {
  try {
    const q = z.object({
      userId: z.coerce.number().int().positive().optional(),
      action: z.string().max(64).optional(),
      entityType: z.string().max(32).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);
    res.json({ events: admin.auditLog(q) });
  } catch (err) { handleErr(err, res, next); }
});

// ── Marketplace moderation ──────────────────────────────────────────────
// Admin view — includes unpublished items too (users only see is_public=1).
router.get('/marketplace', (req, res, next) => {
  try {
    const db = require('../models/database');
    const q = z.object({
      search: z.string().max(100).optional(),
      includeHidden: z.coerce.boolean().optional().default(true),
      limit: z.coerce.number().int().min(1).max(200).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);

    const where = [];
    const params = [];
    if (!q.includeHidden) { where.push('s.is_public = 1'); }
    if (q.search) { where.push('(s.title LIKE ? OR u.email LIKE ?)'); params.push('%'+q.search+'%', '%'+q.search+'%'); }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const rows = db.prepare(`
      SELECT s.id, s.slug, s.title, s.strategy, s.timeframe, s.installs,
             s.price_usd, s.platform_fee_pct, s.is_public, s.created_at,
             u.id AS author_id, u.email AS author_email,
             (SELECT COUNT(*) FROM strategy_earnings e WHERE e.strategy_id = s.id) AS earnings_count,
             COALESCE((SELECT SUM(amount_usd) FROM strategy_earnings e WHERE e.strategy_id = s.id AND e.status='pending'), 0) AS pending_usd,
             COALESCE((SELECT SUM(amount_usd) FROM strategy_earnings e WHERE e.strategy_id = s.id AND e.status='paid'), 0) AS paid_usd
      FROM published_strategies s JOIN users u ON u.id = s.author_id
      ${clause}
      ORDER BY s.is_public DESC, s.installs DESC, s.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, q.limit, q.offset);
    res.json({ strategies: rows });
  } catch (err) { handleErr(err, res, next); }
});

router.patch('/marketplace/:id/public', requireCapability('user.block'), (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const body = z.object({ isPublic: z.boolean() }).parse(req.body);
    const db = require('../models/database');
    const info = db.prepare('UPDATE published_strategies SET is_public = ? WHERE id = ?')
      .run(body.isPublic ? 1 : 0, id);
    if (!info.changes) return res.status(404).json({ error: 'Strategy not found' });
    db.prepare(`
      INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
      VALUES (?, 'admin.marketplace.visibility', 'strategy', ?, ?)
    `).run(req.userId, id, JSON.stringify({ isPublic: body.isPublic }));
    res.json({ ok: true, isPublic: body.isPublic });
  } catch (err) { handleErr(err, res, next); }
});

// ── Copy Trading moderation ─────────────────────────────────────────────
router.get('/copy', (req, res, next) => {
  try {
    const db = require('../models/database');
    const q = z.object({
      activeOnly: z.coerce.boolean().optional().default(false),
      leaderId: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().min(1).max(500).default(200),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);

    const where = [];
    const params = [];
    if (q.activeOnly) where.push('cs.is_active = 1');
    if (q.leaderId) { where.push('cs.leader_id = ?'); params.push(q.leaderId); }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const rows = db.prepare(`
      SELECT cs.leader_id, cs.follower_id, cs.mode, cs.risk_mult, cs.is_active, cs.created_at,
             l.email AS leader_email, l.referral_code AS leader_code,
             f.email AS follower_email,
             (SELECT COUNT(*) FROM trades t WHERE t.user_id = cs.leader_id AND t.status = 'closed') AS leader_closed_trades,
             (SELECT COALESCE(SUM(realized_pnl),0) FROM trades t WHERE t.user_id = cs.leader_id AND t.status = 'closed') AS leader_total_pnl
      FROM copy_subscriptions cs
        JOIN users l ON l.id = cs.leader_id
        JOIN users f ON f.id = cs.follower_id
      ${clause}
      ORDER BY cs.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, q.limit, q.offset);
    res.json({ subscriptions: rows });
  } catch (err) { handleErr(err, res, next); }
});

router.post('/copy/disable', requireCapability('user.block'), (req, res, next) => {
  try {
    const body = z.object({
      leaderId: z.number().int().positive(),
      followerId: z.number().int().positive(),
    }).parse(req.body);
    const db = require('../models/database');
    const info = db.prepare('UPDATE copy_subscriptions SET is_active = 0 WHERE leader_id = ? AND follower_id = ?')
      .run(body.leaderId, body.followerId);
    db.prepare(`
      INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
      VALUES (?, 'admin.copy.disable', 'copy_subscription', ?, ?)
    `).run(req.userId, body.followerId, JSON.stringify(body));
    res.json({ disabled: info.changes });
  } catch (err) { handleErr(err, res, next); }
});

router.post('/copy/leader/:leaderId/ban', requireCapability('user.block'), (req, res, next) => {
  try {
    const leaderId = z.coerce.number().int().positive().parse(req.params.leaderId);
    const db = require('../models/database');
    // Disable all subscriptions + revoke leader's public profile so no one
    // can subscribe again. Stops the fan-out but leaves the leader alive.
    const tx = db.transaction(() => {
      const disabled = db.prepare('UPDATE copy_subscriptions SET is_active = 0 WHERE leader_id = ?').run(leaderId).changes;
      db.prepare('UPDATE users SET public_profile = 0 WHERE id = ?').run(leaderId);
      db.prepare(`
        INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
        VALUES (?, 'admin.copy.leader_banned', 'user', ?, ?)
      `).run(req.userId, leaderId, JSON.stringify({ disabled }));
      return disabled;
    });
    res.json({ disabled: tx() });
  } catch (err) { handleErr(err, res, next); }
});

// ── AI usage stats (Gemini) ─────────────────────────────────────────────
// Pulls from the audit_log rows that aiService writes via logger — but we
// actually track the usage counter in-memory only. Expose it via the
// service's internal getCount if available; otherwise show an empty table.
router.get('/ai/usage', (req, res, next) => {
  try {
    const ai = (() => { try { return require('../services/aiService'); } catch { return null; } })();
    const enabled = !!process.env.GEMINI_API_KEY;
    if (!ai) return res.json({ enabled, users: [] });
    const db = require('../models/database');
    // The in-memory counter is per-process; we can't iterate it from here.
    // Instead, show users whose last_login suggests activity + render their
    // current count by probing ai.getCount(userId). For a DB-backed view
    // you'd need an 'ai_usage_log' table — not present yet.
    const users = db.prepare(`
      SELECT id, email, (SELECT plan FROM subscriptions WHERE user_id = users.id) AS plan
      FROM users WHERE is_active = 1 ORDER BY last_login_at DESC LIMIT 50
    `).all();
    const rows = users.map((u) => ({
      userId: u.id,
      email: u.email,
      plan: u.plan || 'free',
      requestsToday: ai.getCount(u.id),
      limit: ai.limitForPlan(u.plan || 'free'),
    })).filter((r) => r.requestsToday > 0);
    res.json({ enabled, users: rows });
  } catch (err) { handleErr(err, res, next); }
});

module.exports = router;
