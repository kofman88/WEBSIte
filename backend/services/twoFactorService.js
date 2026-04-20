/**
 * Two-factor authentication (TOTP) via otplib.
 *
 * Flow:
 *   1. User hits POST /auth/2fa/setup
 *      → we generate a random secret, encrypt with WALLET_ENCRYPTION_KEY,
 *        store in two_factor_secrets with enabled=0. Return otpauth:// URI
 *        (user scans in Google Authenticator / Authy) plus 8 recovery codes.
 *      → server also returns the QR-image URL (via Google Charts) so the
 *        frontend doesn't need a QR library.
 *   2. User types the 6-digit code from the app → POST /auth/2fa/confirm
 *      → we check it against the stored secret. If valid → enabled=1.
 *   3. On subsequent logins, if enabled=1, login() returns
 *        { twoFactorRequired: true, twoFactorToken }
 *      instead of the access/refresh pair. Client prompts for 6-digit
 *      → POST /auth/2fa/verify { twoFactorToken, code } → full token pair.
 *   4. Disable requires current password (handled in routes layer).
 */

const crypto = require('crypto');
const { authenticator } = require('otplib');
const db = require('../models/database');
const cryptoUtil = require('../utils/crypto');
const config = require('../config');
const logger = require('../utils/logger');

// 30-second window, allow ±1 step drift (standard)
authenticator.options = { window: 1, step: 30 };

const ISSUER = 'CHM Finance';

function generateRecoveryCodes(n = 8) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    // 4-4 format: XXXX-XXXX (uppercase alnum)
    const raw = crypto.randomBytes(8).toString('hex').toUpperCase();
    codes.push(raw.slice(0, 4) + '-' + raw.slice(4, 8));
  }
  return codes;
}

function hashRecoveryCodes(codes) {
  return codes.map((c) => crypto.createHash('sha256').update(c.toLowerCase()).digest('hex')).join(',');
}

function setup(userId, userEmail) {
  const secret = authenticator.generateSecret();
  const otpauth = authenticator.keyuri(userEmail, ISSUER, secret);
  const recoveryCodes = generateRecoveryCodes();
  const recoveryHash = hashRecoveryCodes(recoveryCodes);

  // Upsert — if user had a previous not-yet-enabled secret, overwrite
  const encrypted = cryptoUtil.encrypt(secret, config.walletEncryptionKey);
  db.prepare(`
    INSERT INTO two_factor_secrets (user_id, secret_encrypted, enabled, recovery_codes_hash)
    VALUES (?, ?, 0, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      secret_encrypted = excluded.secret_encrypted,
      recovery_codes_hash = excluded.recovery_codes_hash,
      enabled = 0,
      enabled_at = NULL,
      created_at = CURRENT_TIMESTAMP
  `).run(userId, encrypted, recoveryHash);

  const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=' + encodeURIComponent(otpauth);
  return { otpauth, qrUrl, recoveryCodes };
}

function confirm(userId, code) {
  const row = db.prepare('SELECT secret_encrypted, enabled FROM two_factor_secrets WHERE user_id = ?').get(userId);
  if (!row) { const e = new Error('2FA not initialised — call setup first'); e.statusCode = 400; throw e; }
  const secret = cryptoUtil.decrypt(row.secret_encrypted, config.walletEncryptionKey);
  if (!authenticator.check(code.replace(/\s/g, ''), secret)) {
    const e = new Error('Invalid 2FA code'); e.statusCode = 400; e.code = 'INVALID_2FA'; throw e;
  }
  // Enable 2FA + revoke any other active sessions so anyone still logged
  // in elsewhere has to re-auth (and this time must pass the 2FA gate).
  db.transaction(() => {
    db.prepare('UPDATE two_factor_secrets SET enabled = 1, enabled_at = CURRENT_TIMESTAMP WHERE user_id = ?').run(userId);
    db.prepare('UPDATE refresh_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL').run(userId);
  })();
  logger.info('2FA enabled + sessions revoked', { userId });
  return { enabled: true };
}

function verifyCode(userId, code) {
  const row = db.prepare('SELECT secret_encrypted, enabled, recovery_codes_hash FROM two_factor_secrets WHERE user_id = ?').get(userId);
  if (!row || !row.enabled) return false;
  const clean = code.replace(/\s/g, '');
  const secret = cryptoUtil.decrypt(row.secret_encrypted, config.walletEncryptionKey);
  if (authenticator.check(clean, secret)) return true;
  // Fallback: try recovery code
  const h = crypto.createHash('sha256').update(clean.toLowerCase()).digest('hex');
  const codes = (row.recovery_codes_hash || '').split(',').filter(Boolean);
  const idx = codes.indexOf(h);
  if (idx >= 0) {
    codes.splice(idx, 1);
    db.prepare('UPDATE two_factor_secrets SET recovery_codes_hash = ? WHERE user_id = ?').run(codes.join(','), userId);
    logger.info('2FA recovery code used', { userId, remaining: codes.length });
    return true;
  }
  return false;
}

function disable(userId) {
  db.prepare('DELETE FROM two_factor_secrets WHERE user_id = ?').run(userId);
  logger.info('2FA disabled', { userId });
  return { disabled: true };
}

function isEnabled(userId) {
  const row = db.prepare('SELECT enabled FROM two_factor_secrets WHERE user_id = ?').get(userId);
  return Boolean(row && row.enabled);
}

function status(userId) {
  const row = db.prepare('SELECT enabled, enabled_at, recovery_codes_hash FROM two_factor_secrets WHERE user_id = ?').get(userId);
  if (!row) return { enabled: false, recoveryCodesLeft: 0 };
  return {
    enabled: Boolean(row.enabled),
    enabledAt: row.enabled_at,
    recoveryCodesLeft: (row.recovery_codes_hash || '').split(',').filter(Boolean).length,
  };
}

module.exports = { setup, confirm, verifyCode, disable, isEnabled, status };
