/**
 * GDPR data export — collects everything the platform knows about one
 * user and streams it as a single JSON document. No zip library — one
 * .json file is enough for the amounts of data we hold (~hundreds of
 * KB tops) and works without extra dependencies.
 *
 * Secrets are NEVER exposed:
 *   - password_hash, totp secrets, recovery codes — stripped
 *   - exchange API key ciphertext stays encrypted-only (user owns the
 *     plaintext in their biros; our copy is opaque anyway)
 *   - refresh_token hashes are omitted
 *
 * Called from GET /api/auth/me/export and the Settings button.
 */

const db = require('../models/database');

function _strip(row, ...keys) {
  if (!row) return row;
  const copy = { ...row };
  for (const k of keys) delete copy[k];
  return copy;
}

function build(userId) {
  const user = db.prepare(`
    SELECT id, email, display_name, avatar_url, locale, timezone,
           referral_code, referred_by, email_verified, is_admin, admin_role,
           is_active, public_profile, telegram_username, telegram_chat_id,
           telegram_linked_at, notification_prefs, last_login_at, created_at, updated_at
    FROM users WHERE id = ?
  `).get(userId);
  if (!user) { const e = new Error('User not found'); e.statusCode = 404; throw e; }

  const subscription = db.prepare(`SELECT plan, status, expires_at, auto_renew, created_at, updated_at FROM subscriptions WHERE user_id = ?`).get(userId) || null;
  const exchangeKeys = db.prepare(`
    SELECT id, exchange, label, verified_at, created_at
    FROM exchange_keys WHERE user_id = ?
  `).all(userId);
  const bots = db.prepare(`SELECT * FROM trading_bots WHERE user_id = ?`).all(userId)
    .map((b) => _strip(b, 'tv_webhook_secret'));
  const trades = db.prepare(`SELECT * FROM trades WHERE user_id = ?`).all(userId);
  const signals = db.prepare(`SELECT * FROM signals WHERE user_id = ?`).all(userId);
  const payments = db.prepare(`SELECT * FROM payments WHERE user_id = ?`).all(userId);
  const refRewards = db.prepare(`
    SELECT * FROM ref_rewards WHERE referrer_id = ? OR referred_id = ?
  `).all(userId, userId);
  const sessions = db.prepare(`
    SELECT id, user_agent, ip_address, created_at, expires_at, revoked_at
    FROM refresh_tokens WHERE user_id = ?
  `).all(userId);
  const loginHistory = db.prepare(`
    SELECT success, code, user_agent, ip_address, created_at
    FROM login_history WHERE user_id = ?
  `).all(userId);
  const notifications = db.prepare(`SELECT * FROM notifications WHERE user_id = ?`).all(userId);
  const supportTickets = db.prepare(`SELECT * FROM support_tickets WHERE user_id = ?`).all(userId);
  const supportMessages = db.prepare(`
    SELECT m.* FROM support_messages m
    JOIN support_tickets t ON t.id = m.ticket_id
    WHERE t.user_id = ? OR m.author_id = ?
  `).all(userId, userId);
  const audit = db.prepare(`SELECT * FROM audit_log WHERE user_id = ?`).all(userId);
  const wallet = db.prepare(`SELECT id, address, balance, created_at, updated_at FROM wallets WHERE user_id = ?`).get(userId) || null;
  const walletTx = db.prepare(`SELECT * FROM wallet_transactions WHERE user_id = ?`).all(userId);

  return {
    exportedAt: new Date().toISOString(),
    exportedFor: user.email,
    notice: 'This is a full copy of the personal data CHM Finance holds on you. Sensitive fields (password hash, 2FA secret, recovery codes, refresh-token hashes, exchange API secrets, wallet private keys) have been excluded as they cannot be derived back to readable credentials and are not useful for a GDPR subject-access request.',
    profile: _strip(user),
    subscription,
    exchangeKeys,
    wallet,
    walletTransactions: walletTx,
    bots,
    trades,
    signals,
    payments,
    referralRewards: refRewards,
    sessions,
    loginHistory,
    notifications,
    support: { tickets: supportTickets, messages: supportMessages },
    auditLog: audit,
  };
}

module.exports = { build };
