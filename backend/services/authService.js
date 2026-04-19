/**
 * Auth service — registration, login, refresh-token rotation, logout,
 * password reset. Uses bcrypt for passwords and JWT (HS256) for access tokens.
 *
 * Security principles:
 *  - Refresh tokens are single-use (rotating): each refresh issues new pair
 *    AND revokes the old refresh. Hash stored in DB so we can invalidate.
 *  - Login: same error message for "no such email" and "wrong password"
 *    (prevents email enumeration).
 *  - Password change / reset revokes ALL existing refresh tokens for the user.
 *  - Passwords: bcrypt cost 12 (≈250ms on modern CPU).
 */

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../models/database');
const config = require('../config');
const { sha256 } = require('../utils/crypto');
const logger = require('../utils/logger');
const plans = require('../config/plans');

const BCRYPT_COST = 12;
const REFRESH_BYTES = 48;
const RESET_TTL_SEC = 60 * 60;

function genRefreshToken() {
  return crypto.randomBytes(REFRESH_BYTES).toString('base64url');
}

function genReferralCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  const buf = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}

function ensureUniqueRefCode() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = genReferralCode();
    const existing = db.prepare('SELECT id FROM users WHERE referral_code = ?').get(code);
    if (!existing) return code;
  }
  throw new Error('Could not generate unique referral code after 10 attempts');
}

function signAccessToken(userId, extraClaims = {}) {
  return jwt.sign({ uid: userId, ...extraClaims }, config.jwtSecret, {
    expiresIn: config.jwtAccessTtl,
    algorithm: 'HS256',
  });
}

function verifyAccessToken(token) {
  return jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
}

function computeExpiry(ttlString) {
  const m = /^(\d+)([smhd])$/.exec(ttlString);
  if (!m) throw new Error('invalid ttl: ' + ttlString);
  const n = parseInt(m[1], 10);
  const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
  return new Date(Date.now() + n * mult);
}

function issueRefreshToken(userId, { userAgent = null, ipAddress = null } = {}) {
  const token = genRefreshToken();
  const tokenHash = sha256(token);
  const expiresAt = computeExpiry(config.jwtRefreshTtl);
  db.prepare(`
    INSERT INTO refresh_tokens (user_id, token_hash, user_agent, ip_address, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, tokenHash, userAgent, ipAddress, expiresAt.toISOString());
  return { token, expiresAt };
}

function revokeRefreshToken(tokenHash) {
  db.prepare(`
    UPDATE refresh_tokens SET revoked_at = CURRENT_TIMESTAMP
    WHERE token_hash = ? AND revoked_at IS NULL
  `).run(tokenHash);
}

function revokeAllForUser(userId) {
  db.prepare(`
    UPDATE refresh_tokens SET revoked_at = CURRENT_TIMESTAMP
    WHERE user_id = ? AND revoked_at IS NULL
  `).run(userId);
}

function audit(userId, action, meta = null, ip = null, ua = null) {
  try {
    db.prepare(`
      INSERT INTO audit_log (user_id, action, ip_address, user_agent, metadata)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId, action, ip, ua, meta ? JSON.stringify(meta) : null);
  } catch (e) {
    logger.warn('audit_log insert failed', { err: e.message });
  }
}

function register({ email, password, displayName, referralCode, ipAddress, userAgent }) {
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    const err = new Error('Email already registered');
    err.statusCode = 409;
    err.code = 'EMAIL_EXISTS';
    throw err;
  }

  let referrerId = null;
  if (referralCode) {
    const referrer = db.prepare('SELECT id FROM users WHERE referral_code = ? AND is_active = 1')
      .get(referralCode.toUpperCase());
    if (referrer) referrerId = referrer.id;
  }

  const passwordHash = bcrypt.hashSync(password, BCRYPT_COST);
  const refCode = ensureUniqueRefCode();

  const userId = db.transaction(() => {
    const ins = db.prepare(`
      INSERT INTO users (email, password_hash, display_name, referral_code, referred_by, email_verified, is_active)
      VALUES (?, ?, ?, ?, ?, 0, 1)
    `).run(email, passwordHash, displayName || null, refCode, referrerId);
    const id = ins.lastInsertRowid;

    db.prepare(`INSERT INTO subscriptions (user_id, plan, status) VALUES (?, 'free', 'active')`).run(id);

    if (referrerId) {
      db.prepare(`
        INSERT OR IGNORE INTO referrals (referrer_id, referred_id, commission_pct)
        VALUES (?, ?, 20)
      `).run(referrerId, id);
    }
    return id;
  })();

  audit(userId, 'auth.register', { referralCode: referralCode || null, referrerId }, ipAddress, userAgent);

  const user = getUserPublic(userId);
  const accessToken = signAccessToken(userId);
  const refresh = issueRefreshToken(userId, { userAgent, ipAddress });

  return { user, accessToken, refreshToken: refresh.token, refreshExpiresAt: refresh.expiresAt };
}

function login({ email, password, ipAddress, userAgent }) {
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const genericFail = () => {
    const err = new Error('Invalid email or password');
    err.statusCode = 401;
    err.code = 'INVALID_CREDENTIALS';
    throw err;
  };

  if (!row) {
    bcrypt.compareSync(password, '$2a$12$CwTycUXWue0Thq9StjUM0uJ8.Cb6ZQmKzMvkqGFTNmA8X5IjKqRVe');
    return genericFail();
  }

  if (!row.is_active) {
    const err = new Error('Account disabled');
    err.statusCode = 403;
    err.code = 'ACCOUNT_DISABLED';
    throw err;
  }

  if (!bcrypt.compareSync(password, row.password_hash)) return genericFail();

  db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
  audit(row.id, 'auth.login', null, ipAddress, userAgent);

  const user = getUserPublic(row.id);
  const accessToken = signAccessToken(row.id);
  const refresh = issueRefreshToken(row.id, { userAgent, ipAddress });
  return { user, accessToken, refreshToken: refresh.token, refreshExpiresAt: refresh.expiresAt };
}

function refresh({ refreshToken, ipAddress, userAgent }) {
  const tokenHash = sha256(refreshToken);
  const row = db.prepare(`
    SELECT rt.*, u.is_active
    FROM refresh_tokens rt
    JOIN users u ON u.id = rt.user_id
    WHERE rt.token_hash = ?
  `).get(tokenHash);

  if (!row) {
    const err = new Error('Invalid refresh token');
    err.statusCode = 401;
    err.code = 'INVALID_REFRESH';
    throw err;
  }
  if (row.revoked_at) {
    // Replay detected: revoke all sessions
    revokeAllForUser(row.user_id);
    audit(row.user_id, 'auth.refresh.replay_detected', { tokenId: row.id }, ipAddress, userAgent);
    const err = new Error('Refresh token reuse detected; all sessions revoked');
    err.statusCode = 401;
    err.code = 'REFRESH_REUSED';
    throw err;
  }
  if (new Date(row.expires_at) < new Date()) {
    const err = new Error('Refresh token expired');
    err.statusCode = 401;
    err.code = 'REFRESH_EXPIRED';
    throw err;
  }
  if (!row.is_active) {
    const err = new Error('Account disabled');
    err.statusCode = 403;
    err.code = 'ACCOUNT_DISABLED';
    throw err;
  }

  revokeRefreshToken(tokenHash);
  const accessToken = signAccessToken(row.user_id);
  const next = issueRefreshToken(row.user_id, { userAgent, ipAddress });
  audit(row.user_id, 'auth.refresh', null, ipAddress, userAgent);

  return {
    user: getUserPublic(row.user_id),
    accessToken,
    refreshToken: next.token,
    refreshExpiresAt: next.expiresAt,
  };
}

function logout({ refreshToken, userId = null, ipAddress, userAgent }) {
  if (refreshToken) revokeRefreshToken(sha256(refreshToken));
  if (userId) audit(userId, 'auth.logout', null, ipAddress, userAgent);
}

function logoutAll({ userId, ipAddress, userAgent }) {
  revokeAllForUser(userId);
  audit(userId, 'auth.logout_all', null, ipAddress, userAgent);
}

function requestPasswordReset({ email, ipAddress, userAgent }) {
  const row = db.prepare('SELECT id FROM users WHERE email = ? AND is_active = 1').get(email);
  if (!row) {
    logger.info('password reset requested for unknown email', { email });
    return { sent: true };
  }
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + RESET_TTL_SEC * 1000).toISOString();
  const value = JSON.stringify({ userId: row.id, expiresAt });
  db.prepare(`
    INSERT OR REPLACE INTO system_kv (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
  `).run('reset:' + sha256(token), value);
  audit(row.id, 'auth.password_reset_request', null, ipAddress, userAgent);

  const resetUrl = `/reset?token=${token}`;
  if (!config.isProd) {
    logger.info('[DEV] password reset link', { email, resetUrl });
  } else {
    logger.warn('[prod] email delivery not wired — reset link only in logs', { email, resetUrl });
  }
  return { sent: true };
}

function confirmPasswordReset({ token, newPassword, ipAddress, userAgent }) {
  const key = 'reset:' + sha256(token);
  const kv = db.prepare('SELECT value FROM system_kv WHERE key = ?').get(key);
  if (!kv) {
    const err = new Error('Invalid or expired reset token');
    err.statusCode = 400;
    err.code = 'INVALID_RESET_TOKEN';
    throw err;
  }
  const { userId, expiresAt } = JSON.parse(kv.value);
  if (new Date(expiresAt) < new Date()) {
    db.prepare('DELETE FROM system_kv WHERE key = ?').run(key);
    const err = new Error('Reset token expired');
    err.statusCode = 400;
    err.code = 'RESET_TOKEN_EXPIRED';
    throw err;
  }

  const passwordHash = bcrypt.hashSync(newPassword, BCRYPT_COST);
  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(passwordHash, userId);
    revokeAllForUser(userId);
    db.prepare('DELETE FROM system_kv WHERE key = ?').run(key);
  })();
  audit(userId, 'auth.password_reset_confirmed', null, ipAddress, userAgent);
  return { success: true };
}

function changePassword({ userId, currentPassword, newPassword, ipAddress, userAgent }) {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ? AND is_active = 1').get(userId);
  if (!row) { const err = new Error('User not found'); err.statusCode = 404; throw err; }
  if (!bcrypt.compareSync(currentPassword, row.password_hash)) {
    const err = new Error('Current password is incorrect');
    err.statusCode = 401; err.code = 'WRONG_PASSWORD'; throw err;
  }
  const passwordHash = bcrypt.hashSync(newPassword, BCRYPT_COST);
  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(passwordHash, userId);
    revokeAllForUser(userId);
  })();
  audit(userId, 'auth.password_changed', null, ipAddress, userAgent);
  return { success: true };
}

function getUserPublic(userId) {
  const row = db.prepare(`
    SELECT u.id, u.email, u.display_name, u.avatar_url, u.locale, u.timezone,
           u.referral_code, u.email_verified, u.is_admin, u.last_login_at, u.created_at,
           s.plan, s.status as subscription_status, s.expires_at as subscription_expires_at
    FROM users u
    LEFT JOIN subscriptions s ON s.user_id = u.id
    WHERE u.id = ?
  `).get(userId);
  if (!row) return null;
  const planLimits = plans.getLimits(row.plan || 'free');
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    locale: row.locale,
    timezone: row.timezone,
    referralCode: row.referral_code,
    emailVerified: Boolean(row.email_verified),
    isAdmin: Boolean(row.is_admin),
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    subscription: {
      plan: row.plan || 'free',
      status: row.subscription_status || 'active',
      expiresAt: row.subscription_expires_at,
      limits: {
        signalsPerDay: planLimits.signalsPerDay === Infinity ? null : planLimits.signalsPerDay,
        maxBots: planLimits.maxBots === Infinity ? null : planLimits.maxBots,
        backtestsPerDay: planLimits.backtestsPerDay === Infinity ? null : planLimits.backtestsPerDay,
        autoTrade: planLimits.autoTrade,
        optimizer: planLimits.optimizer,
        apiAccess: planLimits.apiAccess,
        strategies: planLimits.strategies,
      },
    },
  };
}

module.exports = {
  register,
  login,
  refresh,
  logout,
  logoutAll,
  requestPasswordReset,
  confirmPasswordReset,
  changePassword,
  verifyAccessToken,
  getUserPublic,
  _signAccessToken: signAccessToken,
};
