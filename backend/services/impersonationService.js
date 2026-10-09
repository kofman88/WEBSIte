/**
 * Admin impersonation hand-off (ops → "Impersonate").
 *
 * POST /api/admin/users/:id/impersonate (routes/admin.js) registers the session as before (an
 * impersonation_tokens row: jti, admin, target, reason, 30-minute expiry; the audit_log entry
 * admin.user.impersonate) and answers a one-time code instead of the access token. ops.js puts the
 * code into same-origin localStorage under a random key and opens /settings.html#impersonate=<key>;
 * that tab (frontend/app.js bootImpersonation) takes the code out of storage at once and trades it
 * here, POST /api/auth/impersonation/redeem, for the access token, which it keeps in its own
 * sessionStorage. Neither the token nor the code is ever part of a URL, so nothing on the page (an
 * async analytics tag reading location, the browser history, a Referer) can see them.
 *
 * The code: 32 random bytes (base64url), valid 60 s, single use (a conditional UPDATE claims it, so
 * two concurrent redeems cannot both win), only its sha256 is stored. The token it buys is the one
 * the old flow signed — { uid: target, imp: admin, jti } — and expires with the session row (30 min
 * after the admin asked, not after the redeem); authMiddleware still checks the jti for revocation.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../models/database');
const config = require('../config');

const SESSION_SEC = 30 * 60;
const HANDOFF_SEC = 60;
const CODE_RE = /^[A-Za-z0-9_-]{43}$/;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function invalid() {
  const e = new Error('Invalid or expired impersonation code');
  e.statusCode = 400;
  e.code = 'INVALID_HANDOFF';
  return e;
}

/** A fresh code for a new impersonation_tokens row: { code, hash, expiresAt } (hash + expiry are stored). */
function newHandoff(nowMs = Date.now()) {
  const code = crypto.randomBytes(32).toString('base64url');
  return { code, hash: sha256(code), expiresAt: new Date(nowMs + HANDOFF_SEC * 1000).toISOString() };
}

/** The impersonated session's access token for a code, once. Throws 400 INVALID_HANDOFF otherwise. */
function redeem(code, nowMs = Date.now()) {
  if (typeof code !== 'string' || !CODE_RE.test(code)) throw invalid();
  const row = db.prepare(`
    SELECT it.jti, it.admin_id, it.target_id, it.expires_at, it.revoked_at, it.handoff_expires_at, it.handoff_used_at,
           a.is_admin AS admin_is_admin, a.admin_role AS admin_role, a.is_active AS admin_active,
           t.email AS target_email, t.is_admin AS target_is_admin
    FROM impersonation_tokens it
    JOIN users a ON a.id = it.admin_id
    JOIN users t ON t.id = it.target_id
    WHERE it.handoff_hash = ?
  `).get(sha256(code));
  if (!row || row.handoff_used_at) throw invalid();
  // single use: claimed before anything else is looked at, whatever the outcome
  const claim = db.prepare(`
    UPDATE impersonation_tokens SET handoff_used_at = ? WHERE jti = ? AND handoff_used_at IS NULL
  `).run(new Date(nowMs).toISOString(), row.jti);
  if (claim.changes !== 1) throw invalid();
  if (!(Date.parse(row.handoff_expires_at) > nowMs)) throw invalid();
  if (row.revoked_at) throw invalid();
  const remaining = Math.floor((Date.parse(row.expires_at) - nowMs) / 1000);
  if (!(remaining >= 1)) throw invalid();
  // the admin must still be one who may impersonate, the target still not an admin
  const { hasCapability } = require('../middleware/auth');
  if (!row.admin_active || !hasCapability({ isAdmin: Boolean(row.admin_is_admin), adminRole: row.admin_role || 'superadmin' }, 'impersonate')) throw invalid();
  if (row.target_is_admin) throw invalid();
  const accessToken = jwt.sign(
    { uid: row.target_id, imp: row.admin_id, jti: row.jti },
    config.jwtSecret,
    { expiresIn: remaining, algorithm: 'HS256' },
  );
  return { accessToken, expiresIn: remaining, targetEmail: row.target_email };
}

module.exports = { newHandoff, redeem, SESSION_SEC, HANDOFF_SEC, CODE_RE };
