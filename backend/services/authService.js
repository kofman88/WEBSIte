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

function register({ email, password, displayName, givenName, familyName, referralCode, ipAddress, userAgent }) {
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    const err = new Error('Email already registered');
    err.statusCode = 409;
    err.code = 'EMAIL_EXISTS';
    throw err;
  }

  let referrerId = null;
  if (referralCode) {
    const referrer = db.prepare('SELECT id, email FROM users WHERE referral_code = ? AND is_active = 1')
      .get(referralCode.toUpperCase());
    // Anti-self-referral: reject if the referrer's email matches the new
    // registration email (the obvious "use my own code" case). Multi-account
    // self-referral via different emails still needs device/IP + payment
    // verification in refRewards — see issueReward().
    if (referrer && referrer.email !== email) referrerId = referrer.id;
    if (referrer && referrer.email === email) {
      logger.warn('self-referral attempt blocked at register', { email, refCode: referralCode });
    }
  }

  const passwordHash = bcrypt.hashSync(password, BCRYPT_COST);
  const refCode = ensureUniqueRefCode();

  const userId = db.transaction(() => {
    // Compose display_name from given+family if caller passed a name split;
    // otherwise use the legacy `displayName` field verbatim.
    const composedName = displayName
      || [givenName, familyName].filter(Boolean).join(' ').trim()
      || null;
    const ins = db.prepare(`
      INSERT INTO users
        (email, password_hash, display_name, given_name, family_name,
         referral_code, referred_by, email_verified, is_active, oauth_provider)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, 'password')
    `).run(email, passwordHash, composedName, givenName || null, familyName || null, refCode, referrerId);
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

  if (!bcrypt.compareSync(password, row.password_hash)) {
    try {
      db.prepare('INSERT INTO login_history (user_id, ip_address, user_agent, success, failure_code) VALUES (?, ?, ?, 0, ?)')
        .run(row.id, ipAddress || null, userAgent || null, 'WRONG_PASSWORD');
    } catch (_e) {}
    return genericFail();
  }

  // Is 2FA enabled for this user? If so, short-circuit with a pending token.
  try {
    const twoFA = require('./twoFactorService');
    if (twoFA.isEnabled(row.id)) {
      audit(row.id, 'auth.login.2fa_required', null, ipAddress, userAgent);
      return { twoFactorRequired: true, pendingToken: _signPending(row.id) };
    }
  } catch (_e) { /* 2FA service missing → proceed without */ }

  db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
  audit(row.id, 'auth.login', null, ipAddress, userAgent);
  try {
    db.prepare('INSERT INTO login_history (user_id, ip_address, user_agent, success) VALUES (?, ?, ?, 1)')
      .run(row.id, ipAddress || null, userAgent || null);
  } catch (_e) {}

  const user = getUserPublic(row.id);
  const accessToken = signAccessToken(row.id);
  const refresh = issueRefreshToken(row.id, { userAgent, ipAddress });
  return { user, accessToken, refreshToken: refresh.token, refreshExpiresAt: refresh.expiresAt };
}

// Finalize login after 2FA code verification. Called from POST /auth/2fa/verify-login.
function finalizeLoginAfter2FA({ pendingToken, code, ipAddress, userAgent }) {
  const userId = verifyPending(pendingToken);
  const twoFA = require('./twoFactorService');
  if (!twoFA.verifyCode(userId, code)) {
    const err = new Error('Invalid 2FA code'); err.statusCode = 400; err.code = 'INVALID_2FA'; throw err;
  }
  db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
  try {
    db.prepare('INSERT INTO login_history (user_id, ip_address, user_agent, success) VALUES (?, ?, ?, 1)')
      .run(userId, ipAddress || null, userAgent || null);
  } catch (_e) {}
  audit(userId, 'auth.login.2fa_ok', null, ipAddress, userAgent);
  const user = getUserPublic(userId);
  const accessToken = signAccessToken(userId);
  const refresh = issueRefreshToken(userId, { userAgent, ipAddress });
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
  // Always return {sent:true} so attackers can't enumerate registered emails.
  if (!row) {
    logger.info('password reset requested for unknown email', { email });
    return { sent: true };
  }
  const emailService = require('./emailService');
  const token = emailService.randomToken();
  const tokenHash = emailService.hashToken(token);
  const expiresAt = new Date(Date.now() + RESET_TTL_SEC * 1000).toISOString();

  db.prepare(`
    INSERT INTO password_resets (user_id, token_hash, expires_at, ip_address)
    VALUES (?, ?, ?, ?)
  `).run(row.id, tokenHash, expiresAt, ipAddress || null);

  audit(row.id, 'auth.password_reset_request', null, ipAddress, userAgent);
  // Fire-and-forget — don't block the response on SMTP
  emailService.sendPasswordReset(email, token).catch((err) =>
    logger.warn('sendPasswordReset failed', { err: err.message }),
  );
  return { sent: true };
}

function confirmPasswordReset({ token, newPassword, ipAddress, userAgent }) {
  const emailService = require('./emailService');
  const tokenHash = emailService.hashToken(token);
  const row = db.prepare(`
    SELECT id, user_id, expires_at, used_at FROM password_resets WHERE token_hash = ?
  `).get(tokenHash);
  if (!row) {
    const err = new Error('Invalid reset token');
    err.statusCode = 400; err.code = 'INVALID_RESET_TOKEN'; throw err;
  }
  if (row.used_at) {
    const err = new Error('Reset token already used');
    err.statusCode = 400; err.code = 'RESET_TOKEN_USED'; throw err;
  }
  if (new Date(row.expires_at) < new Date()) {
    const err = new Error('Reset token expired');
    err.statusCode = 400; err.code = 'RESET_TOKEN_EXPIRED'; throw err;
  }

  const passwordHash = bcrypt.hashSync(newPassword, BCRYPT_COST);
  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(passwordHash, row.user_id);
    db.prepare('UPDATE password_resets SET used_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
    revokeAllForUser(row.user_id);
  })();
  audit(row.user_id, 'auth.password_reset_confirmed', null, ipAddress, userAgent);
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
           u.referral_code, u.email_verified, u.is_admin, u.admin_role, u.last_login_at, u.created_at,
           u.public_profile, u.paper_starting_balance,
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
    publicProfile: Boolean(row.public_profile),
    paperStartingBalance: Number(row.paper_starting_balance) || 10000,
    emailVerified: Boolean(row.email_verified),
    isAdmin: Boolean(row.is_admin),
    adminRole: row.is_admin ? (row.admin_role || 'superadmin') : null,
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

// ── Email verification (Phase A) ───────────────────────────────────────
function requestEmailVerification({ userId, email, ipAddress, userAgent }) {
  const row = db.prepare('SELECT email, email_verified FROM users WHERE id = ? AND is_active = 1').get(userId);
  if (!row) { const e = new Error('User not found'); e.statusCode = 404; throw e; }
  if (row.email_verified) return { alreadyVerified: true };
  const emailService = require('./emailService');
  const token = emailService.randomToken();
  const tokenHash = emailService.hashToken(token);
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  // Invalidate previous unused tokens for this user
  db.prepare('DELETE FROM email_verifications WHERE user_id = ? AND verified_at IS NULL').run(userId);
  db.prepare(`
    INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES (?, ?, ?)
  `).run(userId, tokenHash, expiresAt);
  audit(userId, 'auth.email_verification.request', null, ipAddress, userAgent);
  emailService.sendVerification(email || row.email, token).catch((err) =>
    logger.warn('sendVerification failed', { err: err.message }),
  );
  return { sent: true };
}

function verifyEmail({ token, ipAddress, userAgent }) {
  const emailService = require('./emailService');
  const tokenHash = emailService.hashToken(token);
  const row = db.prepare(`
    SELECT id, user_id, expires_at, verified_at FROM email_verifications WHERE token_hash = ?
  `).get(tokenHash);
  if (!row) { const e = new Error('Invalid verification token'); e.statusCode = 400; e.code = 'INVALID_VERIFY_TOKEN'; throw e; }
  if (row.verified_at) return { alreadyVerified: true };
  if (new Date(row.expires_at) < new Date()) {
    const e = new Error('Verification token expired'); e.statusCode = 400; e.code = 'VERIFY_TOKEN_EXPIRED'; throw e;
  }
  db.transaction(() => {
    db.prepare('UPDATE email_verifications SET verified_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
    db.prepare('UPDATE users SET email_verified = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.user_id);
  })();
  audit(row.user_id, 'auth.email_verified', null, ipAddress, userAgent);
  return { verified: true, userId: row.user_id };
}

// ── Sessions (active refresh tokens, manual revoke) ────────────────────
function listSessions(userId) {
  return db.prepare(`
    SELECT id, user_agent, ip_address, created_at, expires_at
    FROM refresh_tokens
    WHERE user_id = ? AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP
    ORDER BY created_at DESC
  `).all(userId).map((r) => ({
    id: r.id, userAgent: r.user_agent, ipAddress: r.ip_address,
    createdAt: r.created_at, expiresAt: r.expires_at,
  }));
}

function revokeSession({ userId, sessionId, ipAddress, userAgent }) {
  const info = db.prepare(`
    UPDATE refresh_tokens SET revoked_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ? AND revoked_at IS NULL
  `).run(sessionId, userId);
  if (info.changes === 0) {
    const e = new Error('Session not found or already revoked'); e.statusCode = 404; throw e;
  }
  audit(userId, 'auth.session_revoked', { sessionId }, ipAddress, userAgent);
  return { revoked: true };
}

// ── Login history (last N) ─────────────────────────────────────────────
function recordLoginAttempt({ userId, ipAddress, userAgent, success = true, failureCode = null }) {
  try {
    db.prepare(`
      INSERT INTO login_history (user_id, ip_address, user_agent, success, failure_code)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId, ipAddress || null, userAgent || null, success ? 1 : 0, failureCode);
  } catch (err) { logger.warn('recordLoginAttempt failed', { err: err.message }); }
}
function listLoginHistory(userId, { limit = 20 } = {}) {
  return db.prepare(`
    SELECT ip_address, user_agent, success, failure_code, created_at
    FROM login_history WHERE user_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(userId, limit).map((r) => ({
    ipAddress: r.ip_address, userAgent: r.user_agent,
    success: Boolean(r.success), failureCode: r.failure_code, createdAt: r.created_at,
  }));
}

// ── 2FA-aware login step 2 ─────────────────────────────────────────────
// When user logs in and 2FA is enabled, we return a short-lived pending token.
// Client collects the TOTP code and POSTs { pendingToken, code } to finalize.
function _signPending(userId) {
  return jwt.sign({ uid: userId, kind: '2fa_pending' }, config.jwtSecret, {
    expiresIn: '5m', algorithm: 'HS256',
  });
}
function verifyPending(token) {
  const d = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  if (d.kind !== '2fa_pending' || !d.uid) throw new Error('Invalid pending token');
  return d.uid;
}

// Convenience wrapper used by OAuth flows — mirror what login() returns
// for password users. No password check, no 2FA branch (OAuth already
// gives us a trusted identity).
function issueSessionForUser(userId, { ipAddress = null, userAgent = null } = {}) {
  const user = getUserPublic(userId);
  if (!user) { const e = new Error('User not found'); e.statusCode = 404; throw e; }
  try {
    db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
    db.prepare('INSERT INTO login_history (user_id, ip_address, user_agent, success) VALUES (?, ?, ?, 1)')
      .run(userId, ipAddress || null, userAgent || null);
  } catch (_e) {}
  const accessToken = signAccessToken(userId);
  const refresh = issueRefreshToken(userId, { userAgent, ipAddress });
  return { user, accessToken, refreshToken: refresh.token, refreshExpiresAt: refresh.expiresAt };
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
  requestEmailVerification,
  verifyEmail,
  listSessions,
  revokeSession,
  recordLoginAttempt,
  listLoginHistory,
  verifyPending,
  finalizeLoginAfter2FA,
  verifyAccessToken,
  getUserPublic,
  issueSessionForUser,
  _signAccessToken: signAccessToken,
  _signPending: _signPending,
};
