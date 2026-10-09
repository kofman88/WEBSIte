/**
 * Two-factor authentication (TOTP) via otplib.
 *
 * Flow:
 *   1. User hits POST /auth/2fa/setup
 *      → we generate a random secret, encrypt with WALLET_ENCRYPTION_KEY,
 *        store in two_factor_secrets with enabled=0. Return otpauth:// URI
 *        (user scans in Google Authenticator / Authy) plus 8 recovery codes.
 *      → server also returns the QR image of that URI as a PNG data: URL drawn
 *        here (utils/qr.js), so the frontend needs no QR library and the
 *        secret never reaches a third-party QR service.
 *   2. User types the 6-digit code from the app → POST /auth/2fa/confirm
 *      → we check it against the stored secret. If valid → enabled=1.
 *   3. On subsequent logins, if enabled=1, login() returns
 *        { twoFactorRequired: true, twoFactorToken }
 *      instead of the access/refresh pair. Client prompts for 6-digit
 *      → POST /auth/2fa/verify { twoFactorToken, code } → full token pair.
 *   4. Disable requires current password (handled in routes layer).
 *
 * Replay: a TOTP code stays valid for its 30-second step (±1 step of clock drift), so a code seen
 * once (shoulder-surfed, phished, logged by a proxy) could be used again within ~90 s. Every accepted
 * code moves two_factor_secrets.last_used_step forward to its step (one conditional UPDATE, so two
 * concurrent requests cannot both win); a code of that step or an earlier one is refused. Confirming
 * the setup counts as a use too. A recovery code is single-use the same way: its hash leaves the
 * stored list by a compare-and-swap UPDATE (the list as read must still be the stored one), so two
 * Passenger processes verifying the same code at once cannot both accept it.
 */

const crypto = require('crypto');
const { authenticator } = require('otplib');
const db = require('../models/database');
const cryptoUtil = require('../utils/crypto');
const config = require('../config');
const logger = require('../utils/logger');
const { qrDataUrl } = require('../utils/qr');

// 30-second window, allow ±1 step drift (standard)
const STEP_SEC = 30;
authenticator.options = { window: 1, step: STEP_SEC };

/** The TOTP time step (unix seconds / 30) the code belongs to at `nowMs`, or null if it matches none. */
function matchStep(code, secret, nowMs = Date.now()) {
  const delta = authenticator.clone({ epoch: nowMs }).checkDelta(code, secret);
  if (typeof delta !== 'number') return null;
  return Math.floor(nowMs / 1000 / STEP_SEC) + delta;
}

/** Accept `step` once for the user: false when that step or a later one was already used (replay). */
function claimStep(userId, step) {
  const info = db.prepare(`
    UPDATE two_factor_secrets SET last_used_step = ?
    WHERE user_id = ? AND (last_used_step IS NULL OR last_used_step < ?)
  `).run(step, userId, step);
  return info.changes === 1;
}

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

async function setup(userId, userEmail) {
  const secret = authenticator.generateSecret();
  const otpauth = authenticator.keyuri(userEmail, ISSUER, secret);
  // drawn before anything is stored: a failure leaves the previous state untouched
  const qrUrl = await qrDataUrl(otpauth);
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
      last_used_step = NULL,
      created_at = CURRENT_TIMESTAMP
  `).run(userId, encrypted, recoveryHash);

  return { otpauth, qrUrl, recoveryCodes };
}

function confirm(userId, code) {
  const row = db.prepare('SELECT secret_encrypted, enabled FROM two_factor_secrets WHERE user_id = ?').get(userId);
  if (!row) { const e = new Error('2FA not initialised — call setup first'); e.statusCode = 400; throw e; }
  const secret = cryptoUtil.decrypt(row.secret_encrypted, config.walletEncryptionKey);
  const step = matchStep(code.replace(/\s/g, ''), secret);
  if (step === null || !claimStep(userId, step)) {
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
  const step = matchStep(clean, secret);
  if (step !== null) return claimStep(userId, step);   // a valid code of a step already used: replay
  // Fallback: try recovery code
  return consumeRecoveryCode(userId, crypto.createHash('sha256').update(clean.toLowerCase()).digest('hex'));
}

// Take one recovery code's hash out of the stored list, once. Compare-and-swap on the whole list:
// the UPDATE only applies to the list this call read, so of two processes holding the same code
// only one succeeds; a lost race on a different code is retried with the new list.
function consumeRecoveryCode(userId, hash) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const cur = db.prepare('SELECT recovery_codes_hash FROM two_factor_secrets WHERE user_id = ? AND enabled = 1').get(userId);
    if (!cur || !cur.recovery_codes_hash) return false;
    const codes = cur.recovery_codes_hash.split(',').filter(Boolean);
    const idx = codes.indexOf(hash);
    if (idx < 0) return false;
    codes.splice(idx, 1);
    const info = db.prepare('UPDATE two_factor_secrets SET recovery_codes_hash = ? WHERE user_id = ? AND recovery_codes_hash = ?')
      .run(codes.join(','), userId, cur.recovery_codes_hash);
    if (info.changes === 1) {
      logger.info('2FA recovery code used', { userId, remaining: codes.length });
      return true;
    }
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

module.exports = { setup, confirm, verifyCode, disable, isEnabled, status, matchStep, STEP_SEC };
