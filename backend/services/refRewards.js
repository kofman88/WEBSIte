/**
 * Referral rewards — 20% commission of every confirmed payment.
 *
 * Workflow:
 *   1. User A registers with referralCode from user R
 *      → referrals row (referrer=R, referred=A, commission_pct=20)
 *   2. User A pays $79 for Pro
 *      → payments row status=confirmed
 *      → issueReward(paymentId) inserts ref_rewards row (status=pending, amount=15.8)
 *   3. Admin processes manual payout once a month
 *      → markPaid(rewardId)
 *
 * Ref-rewards are ONE-TIME per payment (not recurring). If user A's
 * subscription auto-renews, each monthly invoice triggers a new reward.
 */

const db = require('../models/database');
const logger = require('../utils/logger');

function issueReward(paymentId) {
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!payment) throw new Error('Payment not found: ' + paymentId);
  if (payment.status !== 'confirmed') return null;

  // Check if referral link exists for this user
  const ref = db.prepare(`
    SELECT * FROM referrals WHERE referred_id = ?
  `).get(payment.user_id);
  if (!ref) return null;

  // Prevent duplicate reward for same payment
  const existing = db.prepare(`
    SELECT id FROM ref_rewards WHERE payment_id = ?
  `).get(paymentId);
  if (existing) return null;

  const commissionUsd = (Number(payment.amount_usd) || 0) * (ref.commission_pct / 100);
  if (commissionUsd <= 0) return null;

  const info = db.prepare(`
    INSERT INTO ref_rewards (referrer_id, referred_id, payment_id, amount_usd, status)
    VALUES (?, ?, ?, ?, 'pending')
  `).run(ref.referrer_id, payment.user_id, paymentId, commissionUsd);

  // Update referrer aggregate
  db.prepare(`
    UPDATE referrals SET total_earned_usd = total_earned_usd + ?
    WHERE referrer_id = ? AND referred_id = ?
  `).run(commissionUsd, ref.referrer_id, payment.user_id);

  db.prepare(`
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
    VALUES (?, 'ref_reward.issued', 'ref_reward', ?, ?)
  `).run(ref.referrer_id, info.lastInsertRowid, JSON.stringify({ paymentId, amount: commissionUsd }));

  logger.info('ref_reward issued', {
    rewardId: info.lastInsertRowid, referrer: ref.referrer_id,
    referred: payment.user_id, amount: commissionUsd,
  });
  try {
    const notifier = require('./notifier');
    notifier.dispatch(ref.referrer_id, {
      type: 'referral',
      title: `💰 Реферальное вознаграждение · $${commissionUsd.toFixed(2)}`,
      body: `Ваш приглашённый пользователь оплатил подписку. 20% комиссия начислена в ожидание выплаты.`,
      link: '/settings.html',
    });
  } catch (_e) {}
  return info.lastInsertRowid;
}

function listForUser(userId, { status = null, limit = 50, offset = 0 } = {}) {
  const parts = ['referrer_id = ?'];
  const params = [userId];
  if (status) { parts.push('status = ?'); params.push(status); }
  const rows = db.prepare(`
    SELECT rr.*, u.email as referred_email
    FROM ref_rewards rr
    LEFT JOIN users u ON u.id = rr.referred_id
    WHERE ${parts.join(' AND ')}
    ORDER BY rr.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  return rows.map(hydrate);
}

function summaryForUser(userId) {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status='pending' THEN amount_usd ELSE 0 END), 0) as pending_usd,
      COALESCE(SUM(CASE WHEN status='paid'    THEN amount_usd ELSE 0 END), 0) as paid_usd,
      COUNT(*) as total_rewards,
      (SELECT COUNT(*) FROM referrals WHERE referrer_id = ?) as referred_count
    FROM ref_rewards WHERE referrer_id = ?
  `).get(userId, userId);
  return {
    pendingUsd: Number(row.pending_usd) || 0,
    paidUsd: Number(row.paid_usd) || 0,
    totalRewards: row.total_rewards || 0,
    referredCount: row.referred_count || 0,
  };
}

function markPaid(rewardId, { adminUserId = null } = {}) {
  const info = db.prepare(`
    UPDATE ref_rewards SET status='paid', paid_at=CURRENT_TIMESTAMP
    WHERE id = ? AND status='pending'
  `).run(rewardId);
  if (info.changes === 0) {
    const err = new Error('Reward not found or already paid');
    err.statusCode = 404; throw err;
  }
  if (adminUserId) {
    db.prepare(`
      INSERT INTO audit_log (user_id, action, entity_type, entity_id)
      VALUES (?, 'ref_reward.paid', 'ref_reward', ?)
    `).run(adminUserId, rewardId);
  }
  return { paid: true };
}

function cancel(rewardId, { adminUserId = null, reason = null } = {}) {
  db.prepare(`
    UPDATE ref_rewards SET status='cancelled' WHERE id = ? AND status='pending'
  `).run(rewardId);
  if (adminUserId) {
    db.prepare(`
      INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
      VALUES (?, 'ref_reward.cancelled', 'ref_reward', ?, ?)
    `).run(adminUserId, rewardId, JSON.stringify({ reason }));
  }
}

function hydrate(row) {
  return {
    id: row.id,
    referrerId: row.referrer_id,
    referredId: row.referred_id,
    referredEmail: row.referred_email,
    paymentId: row.payment_id,
    amountUsd: Number(row.amount_usd),
    status: row.status,
    createdAt: row.created_at,
    paidAt: row.paid_at,
  };
}

module.exports = {
  issueReward,
  listForUser,
  summaryForUser,
  markPaid,
  cancel,
};
