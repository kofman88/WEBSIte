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

// ── Back-office: 360° user view, global feeds, KPI dashboard, system ─────

/** Full profile + everything we know about one user. Read-only. */
function userDetail(userId) {
  const u = db.prepare(`
    SELECT u.*, s.plan, s.status as sub_status, s.expires_at as sub_expires_at,
           s.auto_renew
    FROM users u LEFT JOIN subscriptions s ON s.user_id = u.id
    WHERE u.id = ?
  `).get(userId);
  if (!u) { const e = new Error('User not found'); e.statusCode = 404; throw e; }

  const keys = db.prepare(`SELECT id, exchange, label, verified_at, created_at FROM exchange_keys WHERE user_id = ? ORDER BY created_at DESC`).all(userId);
  const bots = db.prepare(`
    SELECT id, name, exchange, symbols, strategy, timeframe, is_active, auto_trade, trading_mode, created_at
    FROM trading_bots WHERE user_id = ? ORDER BY created_at DESC LIMIT 50
  `).all(userId);
  const payments = db.prepare(`
    SELECT id, amount_usd, method, plan, status, created_at, confirmed_at
    FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 50
  `).all(userId);
  const trades = db.prepare(`
    SELECT id, bot_id, symbol, side, status, trading_mode, entry_price, exit_price,
           realized_pnl, realized_pnl_pct, opened_at, closed_at
    FROM trades WHERE user_id = ? ORDER BY opened_at DESC LIMIT 100
  `).all(userId);
  const pnl = db.prepare(`
    SELECT COUNT(*) AS n,
           COALESCE(SUM(realized_pnl), 0) AS total,
           SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END) AS losses
    FROM trades WHERE user_id = ? AND status = 'closed' AND realized_pnl IS NOT NULL
  `).get(userId);
  const sessions = db.prepare(`
    SELECT id, created_at, expires_at, revoked_at, ip_address, user_agent
    FROM refresh_tokens WHERE user_id = ? ORDER BY created_at DESC LIMIT 20
  `).all(userId);
  const logins = db.prepare(`
    SELECT success, ip_address, user_agent, code, created_at
    FROM login_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 30
  `).all(userId);
  const tickets = db.prepare(`
    SELECT id, subject, status, priority, created_at, updated_at
    FROM support_tickets WHERE user_id = ? ORDER BY updated_at DESC LIMIT 20
  `).all(userId);
  const notifications = db.prepare(`
    SELECT id, type, title, created_at, read_at
    FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 30
  `).all(userId);
  const audits = db.prepare(`
    SELECT action, entity_type, entity_id, ip_address, metadata, created_at
    FROM audit_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 50
  `).all(userId);
  const referrals = db.prepare(`
    SELECT r.referred_id, u.email AS referred_email, r.created_at, r.total_earned_usd
    FROM referrals r LEFT JOIN users u ON u.id = r.referred_id
    WHERE r.referrer_id = ? ORDER BY r.created_at DESC LIMIT 50
  `).all(userId);
  const tfa = db.prepare(`SELECT enabled, enabled_at FROM two_factor_secrets WHERE user_id = ?`).get(userId);

  return {
    user: {
      id: u.id, email: u.email, displayName: u.display_name,
      referralCode: u.referral_code, referredBy: u.referred_by,
      isAdmin: Boolean(u.is_admin), adminRole: u.is_admin ? (u.admin_role || 'superadmin') : null,
      isActive: Boolean(u.is_active),
      emailVerified: Boolean(u.email_verified),
      publicProfile: Boolean(u.public_profile),
      telegramUsername: u.telegram_username,
      telegramChatId: u.telegram_chat_id,
      createdAt: u.created_at, lastLoginAt: u.last_login_at,
      subscription: {
        plan: u.plan || 'free', status: u.sub_status || 'active',
        expiresAt: u.sub_expires_at, autoRenew: Boolean(u.auto_renew),
      },
      twoFactor: { enabled: Boolean(tfa && tfa.enabled), enabledAt: tfa && tfa.enabled_at },
    },
    exchangeKeys: keys,
    bots,
    payments,
    trades,
    pnl: {
      closedTrades: pnl.n || 0, totalPnl: Number(pnl.total) || 0,
      wins: pnl.wins || 0, losses: pnl.losses || 0,
      winRate: (pnl.n || 0) > 0 ? (pnl.wins || 0) / pnl.n : null,
    },
    sessions: sessions.map((s) => ({
      ...s, active: !s.revoked_at && new Date(s.expires_at).getTime() > Date.now(),
    })),
    logins,
    tickets,
    notifications,
    referrals,
    audit: audits.map((a) => ({ ...a, metadata: safeJson(a.metadata, null) })),
  };
}

/** Global bot feed for ops — all users. */
function listAllBots({ status = null, limit = 100, offset = 0 } = {}) {
  const parts = [];
  const params = [];
  if (status === 'active') parts.push('b.is_active = 1');
  if (status === 'inactive') parts.push('b.is_active = 0');
  const where = parts.length ? 'WHERE ' + parts.join(' AND ') : '';
  return db.prepare(`
    SELECT b.id, b.user_id, u.email AS user_email, b.name, b.exchange, b.symbols,
           b.strategy, b.timeframe, b.is_active, b.auto_trade, b.trading_mode,
           b.created_at, b.last_run_at,
           (SELECT COUNT(*) FROM trades t WHERE t.bot_id = b.id) AS trade_count,
           (SELECT COALESCE(SUM(realized_pnl), 0) FROM trades t WHERE t.bot_id = b.id AND t.status = 'closed') AS total_pnl
    FROM trading_bots b JOIN users u ON u.id = b.user_id
    ${where}
    ORDER BY b.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
}

/** Global trades feed. */
function listAllTrades({ status = null, mode = null, limit = 100, offset = 0 } = {}) {
  const parts = [];
  const params = [];
  if (status) { parts.push('t.status = ?'); params.push(status); }
  if (mode)   { parts.push('t.trading_mode = ?'); params.push(mode); }
  const where = parts.length ? 'WHERE ' + parts.join(' AND ') : '';
  return db.prepare(`
    SELECT t.id, t.user_id, u.email AS user_email, t.bot_id, t.symbol, t.side,
           t.status, t.trading_mode, t.entry_price, t.exit_price,
           t.realized_pnl, t.realized_pnl_pct, t.opened_at, t.closed_at
    FROM trades t JOIN users u ON u.id = t.user_id
    ${where}
    ORDER BY t.opened_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
}

/** Global signal feed. */
function listAllSignals({ strategy = null, limit = 100, offset = 0 } = {}) {
  const parts = [];
  const params = [];
  if (strategy) { parts.push('s.strategy = ?'); params.push(strategy); }
  const where = parts.length ? 'WHERE ' + parts.join(' AND ') : '';
  return db.prepare(`
    SELECT s.id, s.user_id, u.email AS user_email, s.symbol, s.side, s.strategy,
           s.entry, s.tp, s.sl, s.result, s.created_at, s.expires_at
    FROM signals s LEFT JOIN users u ON u.id = s.user_id
    ${where}
    ORDER BY s.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
}

/** Dashboard KPIs for the ops landing page. */
function opsDashboard() {
  const now = Date.now();
  const d24 = new Date(now - 86_400_000).toISOString();
  const d7  = new Date(now - 7 * 86_400_000).toISOString();
  const d30 = new Date(now - 30 * 86_400_000).toISOString();

  const users = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users) AS total,
      (SELECT COUNT(*) FROM users WHERE created_at >= ?) AS new24h,
      (SELECT COUNT(*) FROM users WHERE last_login_at >= ?) AS dau,
      (SELECT COUNT(*) FROM users WHERE last_login_at >= ?) AS wau,
      (SELECT COUNT(*) FROM users WHERE last_login_at >= ?) AS mau
  `).get(d24, d24, d7, d30);

  const revenue = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN created_at >= ? THEN amount_usd ELSE 0 END), 0) AS rev24h,
      COALESCE(SUM(CASE WHEN created_at >= ? THEN amount_usd ELSE 0 END), 0) AS rev30d,
      COALESCE(SUM(amount_usd), 0) AS revAll
    FROM payments WHERE status = 'confirmed'
  `).get(d24, d30);

  const mrr = db.prepare(`
    SELECT COALESCE(SUM(CASE
      WHEN plan = 'starter' THEN 29
      WHEN plan = 'pro' THEN 79
      WHEN plan = 'elite' THEN 149
      ELSE 0 END), 0) AS mrr
    FROM subscriptions
    WHERE status = 'active' AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
  `).get();

  const bots = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN auto_trade = 1 AND is_active = 1 THEN 1 ELSE 0 END) AS autotrading
    FROM trading_bots
  `).get();

  const trades = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN opened_at >= ? THEN 1 ELSE 0 END) AS open24h,
      SUM(CASE WHEN closed_at >= ? THEN 1 ELSE 0 END) AS closed24h
    FROM trades
  `).get(d24, d24);

  const support = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS new24h
    FROM support_tickets
  `).get(d24);

  const signalsToday = db.prepare(`SELECT COUNT(*) AS n FROM signals WHERE created_at >= ?`).get(d24).n;
  const paymentsPending = db.prepare(`SELECT COUNT(*) AS n FROM payments WHERE status = 'pending'`).get().n;
  const refRewardsPending = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(amount_usd), 0) AS total
    FROM ref_rewards WHERE status = 'pending'
  `).get();

  return {
    users: { total: users.total, new24h: users.new24h, dau: users.dau, wau: users.wau, mau: users.mau },
    revenue: {
      mrr: Number(mrr.mrr),
      last24h: Number(revenue.rev24h),
      last30d: Number(revenue.rev30d),
      lifetime: Number(revenue.revAll),
    },
    bots: { total: bots.total || 0, active: bots.active || 0, autotrading: bots.autotrading || 0 },
    trades: { open: trades.open || 0, openedLast24h: trades.open24h || 0, closedLast24h: trades.closed24h || 0 },
    support: { open: support.open || 0, pending: support.pending || 0, new24h: support.new24h || 0 },
    pipeline: {
      signalsToday,
      paymentsPending,
      refRewardsPending: { count: refRewardsPending.n, amountUsd: Number(refRewardsPending.total) },
    },
  };
}

/** Daily revenue + new-user time series for Dashboard chart. */
function revenueTimeseries({ days = 30 } = {}) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = db.prepare(`
    SELECT DATE(created_at) AS day,
           COALESCE(SUM(amount_usd), 0) AS revenue,
           COUNT(*) AS payments
    FROM payments
    WHERE status = 'confirmed' AND created_at >= ?
    GROUP BY DATE(created_at)
    ORDER BY DATE(created_at)
  `).all(since);
  const userRows = db.prepare(`
    SELECT DATE(created_at) AS day, COUNT(*) AS users
    FROM users WHERE created_at >= ?
    GROUP BY DATE(created_at)
    ORDER BY DATE(created_at)
  `).all(since);

  // Fill missing days with zeros so the chart line is continuous.
  const byDay = {};
  for (const r of rows) byDay[r.day] = { revenue: Number(r.revenue), payments: r.payments, users: 0 };
  for (const r of userRows) {
    if (!byDay[r.day]) byDay[r.day] = { revenue: 0, payments: 0, users: r.users };
    else byDay[r.day].users = r.users;
  }
  const out = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(now.getTime() - i * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    const v = byDay[key] || { revenue: 0, payments: 0, users: 0 };
    out.push({ day: key, revenue: v.revenue, payments: v.payments, newUsers: v.users });
  }
  return out;
}

/**
 * Billing analytics — cohort MRR, churn, LTV, ARPPU.
 *
 * Cohort: users bucketed by the month they first confirmed a payment.
 * For each cohort, we report members + MRR (current month-over-month
 * subscription worth of that cohort still active).
 *
 * Churn (monthly): subscriptions that went from active → free/expired
 * in the last 30 days, divided by subscriptions active 30 days ago.
 *
 * LTV: mean lifetime revenue per paid user who has churned OR is > 6m old.
 */
function billingAnalytics() {
  const PRICE = { free: 0, starter: 29, pro: 79, elite: 149 };
  // Paid cohorts by first payment month
  const cohorts = db.prepare(`
    SELECT strftime('%Y-%m', MIN(created_at)) AS cohort, user_id
    FROM payments WHERE status = 'confirmed'
    GROUP BY user_id
  `).all();
  const byCohort = {};
  for (const r of cohorts) {
    const c = r.cohort;
    if (!byCohort[c]) byCohort[c] = { cohort: c, users: [], members: 0, activeMrr: 0, lifetimeRev: 0 };
    byCohort[c].users.push(r.user_id); byCohort[c].members += 1;
  }
  for (const c of Object.keys(byCohort)) {
    const ids = byCohort[c].users;
    if (!ids.length) continue;
    const q = '(' + ids.map(() => '?').join(',') + ')';
    const plans = db.prepare(`
      SELECT s.plan FROM subscriptions s
      WHERE s.user_id IN ${q} AND s.status = 'active'
        AND (s.expires_at IS NULL OR s.expires_at > CURRENT_TIMESTAMP)
    `).all(...ids);
    byCohort[c].activeMrr = plans.reduce((sum, p) => sum + (PRICE[p.plan] || 0), 0);
    const rev = db.prepare(`
      SELECT COALESCE(SUM(amount_usd), 0) AS t FROM payments
      WHERE status = 'confirmed' AND user_id IN ${q}
    `).get(...ids).t;
    byCohort[c].lifetimeRev = Number(rev) || 0;
    delete byCohort[c].users;
  }
  const cohortList = Object.values(byCohort).sort((a, b) => a.cohort.localeCompare(b.cohort));

  // Churn (monthly): subscriptions that rolled off paid in the last 30d
  const thirtyAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const activeNow = db.prepare(`
    SELECT COUNT(*) AS n FROM subscriptions
    WHERE status = 'active' AND plan != 'free'
      AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
  `).get().n;
  // Approximation: "active 30d ago" = confirmed payments > 30d ago + still had paid plan
  const activeThirtyAgo = db.prepare(`
    SELECT COUNT(DISTINCT user_id) AS n FROM payments
    WHERE status = 'confirmed' AND created_at <= ?
  `).get(thirtyAgo).n;
  const churned = db.prepare(`
    SELECT COUNT(*) AS n FROM subscriptions
    WHERE (status = 'expired' OR status = 'refunded' OR (plan = 'free' AND updated_at >= ?))
      AND updated_at >= ?
  `).get(thirtyAgo, thirtyAgo).n;
  const churnRate = activeThirtyAgo > 0 ? churned / activeThirtyAgo : 0;

  // LTV: mean lifetime revenue over "mature" cohorts (>=6 months old)
  const cutoff = new Date(Date.now() - 180 * 86_400_000).toISOString();
  const mature = db.prepare(`
    SELECT user_id, COALESCE(SUM(amount_usd), 0) AS total
    FROM payments
    WHERE status = 'confirmed' AND user_id IN (
      SELECT user_id FROM payments WHERE status = 'confirmed'
      GROUP BY user_id HAVING MIN(created_at) <= ?
    )
    GROUP BY user_id
  `).all(cutoff);
  const ltv = mature.length ? mature.reduce((s, r) => s + Number(r.total), 0) / mature.length : 0;

  // ARPPU: average revenue per paying user (lifetime)
  const allPaid = db.prepare(`
    SELECT user_id, COALESCE(SUM(amount_usd), 0) AS total
    FROM payments WHERE status = 'confirmed' GROUP BY user_id
  `).all();
  const arppu = allPaid.length ? allPaid.reduce((s, r) => s + Number(r.total), 0) / allPaid.length : 0;

  // Plan distribution across currently active subs
  const planRows = db.prepare(`
    SELECT plan, COUNT(*) AS n FROM subscriptions
    WHERE status = 'active' AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
    GROUP BY plan
  `).all();

  return {
    cohorts: cohortList,
    churn: { monthlyRate: Math.round(churnRate * 10000) / 10000, churnedLast30d: churned, activeNow, activeThirtyDaysAgo: activeThirtyAgo },
    ltv: Math.round(ltv * 100) / 100,
    arppu: Math.round(arppu * 100) / 100,
    payingUsers: allPaid.length,
    planDistribution: planRows,
  };
}

/** Audit activity breakdown for the last N days. */
function auditAnalytics({ days = 14 } = {}) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  // Per-day total
  const byDay = db.prepare(`
    SELECT DATE(created_at) AS day, COUNT(*) AS n
    FROM audit_log WHERE created_at >= ?
    GROUP BY DATE(created_at) ORDER BY DATE(created_at)
  `).all(since);
  // Per-action counts (top 20)
  const byAction = db.prepare(`
    SELECT action, COUNT(*) AS n FROM audit_log
    WHERE created_at >= ?
    GROUP BY action ORDER BY n DESC LIMIT 20
  `).all(since);
  // Per-actor counts (admins only; for daily staff activity)
  const byActor = db.prepare(`
    SELECT COALESCE(u.email, '(system)') AS email, COUNT(*) AS n
    FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.created_at >= ? AND a.action LIKE 'admin.%'
    GROUP BY a.user_id ORDER BY n DESC LIMIT 20
  `).all(since);
  // Breakdown by action category (prefix before the first dot)
  const byCategory = db.prepare(`
    SELECT substr(action, 1, instr(action || '.', '.') - 1) AS category, COUNT(*) AS n
    FROM audit_log WHERE created_at >= ?
    GROUP BY category ORDER BY n DESC
  `).all(since);
  return { days, byDay, byAction, byActor, byCategory };
}

/** System health, DB size, worker state. */
function systemInfo() {
  const out = { process: {}, db: {}, backups: {}, subsystems: {} };
  try {
    out.process = {
      uptimeSeconds: Math.round(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
      heapMb: Math.round(process.memoryUsage().heapUsed / 1048576),
      node: process.version,
      pid: process.pid,
      nodeEnv: process.env.NODE_ENV || 'development',
    };
  } catch (_e) {}

  try {
    const dbRow = db.prepare(`SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()`).get();
    out.db = {
      sizeMb: dbRow ? Math.round(dbRow.size / 1048576 * 100) / 100 : null,
      walMode: Boolean(db.prepare(`PRAGMA journal_mode`).get().journal_mode === 'wal'),
      tables: db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all().map((r) => r.name),
    };
    // Row counts for the big tables (fast via explicit indexes)
    const counts = {};
    for (const t of ['users', 'trades', 'signals', 'payments', 'audit_log', 'notifications', 'login_history']) {
      try { counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; } catch (_e) {}
    }
    out.db.rowCounts = counts;
  } catch (e) { out.db.error = e.message; }

  try {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(path.dirname(process.env.DATABASE_PATH || './data/chmup.db'), 'backups');
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir)
        .filter((f) => /^chmup-\d{8}\.db$/.test(f))
        .map((f) => {
          const st = fs.statSync(path.join(dir, f));
          return { name: f, sizeMb: Math.round(st.size / 1048576 * 100) / 100, mtime: st.mtime };
        })
        .sort((a, b) => b.mtime - a.mtime);
      out.backups = { count: files.length, latest: files[0] || null, files: files.slice(0, 10) };
    } else {
      out.backups = { count: 0, latest: null, files: [] };
    }
  } catch (_e) {}

  return out;
}

module.exports = {
  listUsers, getUser, setUserActive, setUserPlan,
  listPayments, manualConfirmPayment, refundPayment,
  listPromoCodes, createPromoCode, setPromoActive, deletePromo,
  listAllRewards,
  systemStats, auditLog,
  userDetail, listAllBots, listAllTrades, listAllSignals,
  opsDashboard, systemInfo, revenueTimeseries, billingAnalytics, auditAnalytics,
};
