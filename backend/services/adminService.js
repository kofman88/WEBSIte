/**
 * Admin service — privileged operations for users with is_admin=1.
 *
 * Every mutation writes to audit_log with the admin's user_id so we have a
 * full trail for security reviews.
 */

const db = require('../models/database');
const logger = require('../utils/logger');
const paymentService = require('./paymentService');
const refRewards = require('./refRewards');

// ── Users ──────────────────────────────────────────────────────────────
function listUsers({ search = null, limit = 50, offset = 0 } = {}) {
  const parts = [];
  const params = [];
  if (search) {
    parts.push('(email LIKE ? OR display_name LIKE ? OR referral_code LIKE ?)');
    const q = '%' + search + '%';
    params.push(q, q, q);
  }
  const where = parts.length ? 'WHERE ' + parts.join(' AND ') : '';

  const rows = db.prepare(`
    SELECT u.id, u.email, u.display_name, u.referral_code, u.email_verified,
           u.is_admin, u.is_active, u.last_login_at, u.created_at,
           s.plan, s.status as sub_status, s.expires_at as sub_expires_at,
           (SELECT COUNT(*) FROM trading_bots b WHERE b.user_id = u.id) as bot_count,
           (SELECT COUNT(*) FROM trades t WHERE t.user_id = u.id) as trade_count,
           (SELECT COUNT(*) FROM payments p WHERE p.user_id = u.id AND p.status = 'confirmed') as paid_count
    FROM users u
    LEFT JOIN subscriptions s ON s.user_id = u.id
    ${where}
    ORDER BY u.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const total = db.prepare(`SELECT COUNT(*) as n FROM users ${where}`).get(...params).n;
  return { total, users: rows.map(hydrateUser) };
}

function getUser(userId) {
  const row = db.prepare(`
    SELECT u.*, s.plan, s.status as sub_status, s.expires_at as sub_expires_at
    FROM users u LEFT JOIN subscriptions s ON s.user_id = u.id
    WHERE u.id = ?
  `).get(userId);
  return row ? hydrateUser(row) : null;
}

function setUserActive(userId, isActive, { adminId } = {}) {
  const info = db.prepare('UPDATE users SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(isActive ? 1 : 0, userId);
  if (info.changes === 0) { const err = new Error('User not found'); err.statusCode = 404; throw err; }
  // If disabling, also pause bots + revoke all refresh tokens
  if (!isActive) {
    db.prepare('UPDATE trading_bots SET is_active = 0 WHERE user_id = ?').run(userId);
    db.prepare('UPDATE refresh_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL').run(userId);
  }
  db.prepare(`
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
    VALUES (?, ?, 'user', ?, ?)
  `).run(adminId || null, isActive ? 'admin.user.activate' : 'admin.user.deactivate',
    userId, JSON.stringify({ by: adminId }));
  return { success: true };
}

function setUserPlan(userId, plan, { adminId, durationDays = 30 } = {}) {
  paymentService.extendSubscription(userId, plan, durationDays);
  db.prepare(`
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
    VALUES (?, 'admin.user.set_plan', 'user', ?, ?)
  `).run(adminId || null, userId, JSON.stringify({ plan, durationDays, by: adminId }));
  return { success: true };
}

// ── Payments ───────────────────────────────────────────────────────────
function listPayments({ status = null, method = null, limit = 100, offset = 0 } = {}) {
  const parts = [];
  const params = [];
  if (status) { parts.push('p.status = ?'); params.push(status); }
  if (method) { parts.push('p.method = ?'); params.push(method); }
  const where = parts.length ? 'WHERE ' + parts.join(' AND ') : '';

  const rows = db.prepare(`
    SELECT p.*, u.email as user_email
    FROM payments p LEFT JOIN users u ON u.id = p.user_id
    ${where}
    ORDER BY p.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) as n FROM payments p ${where}`).get(...params).n;

  return {
    total,
    payments: rows.map((p) => ({
      id: p.id, userId: p.user_id, userEmail: p.user_email,
      amountUsd: Number(p.amount_usd), currency: p.currency, method: p.method,
      providerTxId: p.provider_tx_id, plan: p.plan, durationDays: p.duration_days,
      status: p.status, createdAt: p.created_at, confirmedAt: p.confirmed_at,
      metadata: safeJson(p.metadata, {}),
    })),
  };
}

function manualConfirmPayment(paymentId, { adminId, note = null } = {}) {
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!payment) { const err = new Error('Payment not found'); err.statusCode = 404; throw err; }
  if (payment.status === 'confirmed') {
    const err = new Error('Payment already confirmed'); err.statusCode = 400; throw err;
  }

  paymentService.confirmPayment(paymentId);
  db.prepare(`
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
    VALUES (?, 'admin.payment.manual_confirm', 'payment', ?, ?)
  `).run(adminId || null, paymentId, JSON.stringify({ note, by: adminId }));

  return { success: true };
}

function refundPayment(paymentId, { adminId, reason = null } = {}) {
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!payment) { const err = new Error('Payment not found'); err.statusCode = 404; throw err; }

  db.prepare('UPDATE payments SET status = ? WHERE id = ?').run('refunded', paymentId);
  // Cancel any associated ref_rewards still pending
  const reward = db.prepare('SELECT id FROM ref_rewards WHERE payment_id = ? AND status = ?').get(paymentId, 'pending');
  if (reward) {
    refRewards.cancel(reward.id, { adminUserId: adminId, reason: 'payment_refunded' });
  }

  // If this refund leaves the user with no later confirmed payment, drop
  // them back to the free plan. extendSubscription() will then cascade
  // and deactivate any bots above the free-plan cap.
  try {
    const laterConfirmed = db.prepare(`
      SELECT COUNT(*) AS n FROM payments
      WHERE user_id = ? AND status = 'confirmed' AND id <> ? AND created_at > ?
    `).get(payment.user_id, paymentId, payment.created_at).n;
    if (laterConfirmed === 0) {
      const sub = db.prepare('SELECT plan FROM subscriptions WHERE user_id = ?').get(payment.user_id);
      if (sub && sub.plan !== 'free') {
        // Put them on the free plan, wipe the expiry so they can't keep
        // the old tier until expires_at. 0 days means "no extension" —
        // extendSubscription still runs the bot-cleanup pass.
        const paymentService = require('./paymentService');
        paymentService.extendSubscription(payment.user_id, 'free', 0);
        db.prepare(`UPDATE subscriptions SET expires_at = NULL, status = 'refunded', updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`)
          .run(payment.user_id);
      }
    }
  } catch (e) {
    require('../utils/logger').error('refund downgrade failed', { userId: payment.user_id, err: e.message });
  }

  db.prepare(`
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
    VALUES (?, 'admin.payment.refund', 'payment', ?, ?)
  `).run(adminId || null, paymentId, JSON.stringify({ reason, by: adminId }));

  return { success: true };
}

// ── Promo codes ────────────────────────────────────────────────────────
function listPromoCodes() {
  return db.prepare(`
    SELECT pc.*, u.email as created_by_email
    FROM promo_codes pc LEFT JOIN users u ON u.id = pc.created_by
    ORDER BY pc.created_at DESC
  `).all().map(hydratePromo);
}

function createPromoCode({ code, plan, durationDays, maxUses, discountPct, expiresAt }, { adminId }) {
  const existing = db.prepare('SELECT id FROM promo_codes WHERE code = ?').get(code.toUpperCase());
  if (existing) { const err = new Error('Promo code already exists'); err.statusCode = 409; throw err; }
  const info = db.prepare(`
    INSERT INTO promo_codes (code, plan, duration_days, max_uses, discount_pct, is_active, created_by, expires_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(code.toUpperCase(), plan, durationDays, maxUses, discountPct || 100, adminId || null, expiresAt || null);

  db.prepare(`
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
    VALUES (?, 'admin.promo.create', 'promo_code', ?, ?)
  `).run(adminId || null, info.lastInsertRowid,
    JSON.stringify({ code: code.toUpperCase(), plan, durationDays }));

  return db.prepare('SELECT * FROM promo_codes WHERE id = ?').get(info.lastInsertRowid);
}

function setPromoActive(id, isActive, { adminId }) {
  db.prepare('UPDATE promo_codes SET is_active = ? WHERE id = ?').run(isActive ? 1 : 0, id);
  db.prepare(`
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
    VALUES (?, ?, 'promo_code', ?, ?)
  `).run(adminId || null, isActive ? 'admin.promo.enable' : 'admin.promo.disable', id, null);
  return { success: true };
}

function deletePromo(id, { adminId }) {
  const info = db.prepare('DELETE FROM promo_codes WHERE id = ?').run(id);
  if (info.changes === 0) { const err = new Error('Promo not found'); err.statusCode = 404; throw err; }
  db.prepare(`
    INSERT INTO audit_log (user_id, action, entity_type, entity_id) VALUES (?, 'admin.promo.delete', 'promo_code', ?)
  `).run(adminId || null, id);
  return { success: true };
}

// ── Referral rewards ───────────────────────────────────────────────────
function listAllRewards({ status = null, limit = 100, offset = 0 } = {}) {
  const parts = [];
  const params = [];
  if (status) { parts.push('rr.status = ?'); params.push(status); }
  const where = parts.length ? 'WHERE ' + parts.join(' AND ') : '';

  const rows = db.prepare(`
    SELECT rr.*, ref.email as referrer_email, red.email as referred_email
    FROM ref_rewards rr
    LEFT JOIN users ref ON ref.id = rr.referrer_id
    LEFT JOIN users red ON red.id = rr.referred_id
    ${where}
    ORDER BY rr.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  return rows.map((r) => ({
    id: r.id, referrerId: r.referrer_id, referrerEmail: r.referrer_email,
    referredId: r.referred_id, referredEmail: r.referred_email,
    paymentId: r.payment_id, amountUsd: Number(r.amount_usd),
    status: r.status, createdAt: r.created_at, paidAt: r.paid_at,
  }));
}

// ── System stats + audit log ───────────────────────────────────────────
function systemStats() {
  const users = db.prepare(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active,
           SUM(CASE WHEN DATE(created_at) = DATE('now') THEN 1 ELSE 0 END) as today
    FROM users
  `).get();

  const subs = db.prepare(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN plan = 'starter' THEN 1 ELSE 0 END) as starter,
           SUM(CASE WHEN plan = 'pro'     THEN 1 ELSE 0 END) as pro,
           SUM(CASE WHEN plan = 'elite'   THEN 1 ELSE 0 END) as elite,
           SUM(CASE WHEN plan = 'free'    THEN 1 ELSE 0 END) as free
    FROM subscriptions
  `).get();

  const pay = db.prepare(`
    SELECT COUNT(*) as total,
           COALESCE(SUM(CASE WHEN status='confirmed' THEN amount_usd ELSE 0 END), 0) as revenue,
           SUM(CASE WHEN DATE(created_at) = DATE('now') THEN 1 ELSE 0 END) as today
    FROM payments
  `).get();

  const bots = db.prepare(`
    SELECT COUNT(*) as total, SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active
    FROM trading_bots
  `).get();

  const signals = db.prepare(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN DATE(created_at) = DATE('now') THEN 1 ELSE 0 END) as today
    FROM signals
  `).get();

  const backtests = db.prepare(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
           SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running
    FROM backtests
  `).get();

  return { users, subscriptions: subs, payments: pay, bots, signals, backtests };
}

function auditLog({ userId = null, action = null, entityType = null, limit = 100, offset = 0 } = {}) {
  const parts = [];
  const params = [];
  if (userId)     { parts.push('user_id = ?');     params.push(userId); }
  if (action)     { parts.push('action LIKE ?');   params.push('%' + action + '%'); }
  if (entityType) { parts.push('entity_type = ?'); params.push(entityType); }
  const where = parts.length ? 'WHERE ' + parts.join(' AND ') : '';

  const rows = db.prepare(`
    SELECT a.*, u.email as user_email
    FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    ${where}
    ORDER BY a.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  return rows.map((r) => ({
    id: r.id, userId: r.user_id, userEmail: r.user_email,
    action: r.action, entityType: r.entity_type, entityId: r.entity_id,
    ipAddress: r.ip_address, userAgent: r.user_agent,
    metadata: safeJson(r.metadata, null),
    createdAt: r.created_at,
  }));
}

// ── helpers ────────────────────────────────────────────────────────────
function hydrateUser(r) {
  return {
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    referralCode: r.referral_code,
    emailVerified: Boolean(r.email_verified),
    isAdmin: Boolean(r.is_admin),
    isActive: Boolean(r.is_active),
    lastLoginAt: r.last_login_at,
    createdAt: r.created_at,
    plan: r.plan || 'free',
    subStatus: r.sub_status || 'active',
    subExpiresAt: r.sub_expires_at,
    botCount: r.bot_count || 0,
    tradeCount: r.trade_count || 0,
    paidCount: r.paid_count || 0,
  };
}

function hydratePromo(r) {
  return {
    id: r.id,
    code: r.code,
    plan: r.plan,
    durationDays: r.duration_days,
    discountPct: r.discount_pct,
    maxUses: r.max_uses,
    usesCount: r.uses_count,
    isActive: Boolean(r.is_active),
    createdBy: r.created_by,
    createdByEmail: r.created_by_email,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}

function safeJson(s, fb) { if (!s) return fb; try { return JSON.parse(s); } catch { return fb; } }

module.exports = {
  listUsers, getUser, setUserActive, setUserPlan,
  listPayments, manualConfirmPayment, refundPayment,
  listPromoCodes, createPromoCode, setPromoActive, deletePromo,
  listAllRewards,
  systemStats, auditLog,
};
