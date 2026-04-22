/**
 * OAuth / Social login — Google + Telegram Login Widget.
 *
 * Zero external deps (no passport). Plain HTTPS fetch for Google, HMAC
 * check for Telegram. Both flows end at upsertOAuthUser() which either
 * creates a new user, links to an existing one by email, or signs in
 * the already-linked user.
 *
 * Env:
 *   GOOGLE_OAUTH_CLIENT_ID     — from console.cloud.google.com
 *   GOOGLE_OAUTH_CLIENT_SECRET — paired secret
 *   OAUTH_REDIRECT_URL         — e.g. https://chmup.top/api/auth/oauth/google/callback
 *                                (defaults to ${APP_URL}/api/auth/oauth/google/callback)
 *   TELEGRAM_BOT_TOKEN         — existing (@CHMUP_bot)
 *
 * If GOOGLE_OAUTH_CLIENT_ID is empty, providers('google').enabled = false
 * and the route returns 503 to make the button stub gracefully.
 */

const crypto = require('crypto');
const https = require('https');
const db = require('../models/database');
const logger = require('../utils/logger');
const authService = require('./authService');

// ── Config resolver ────────────────────────────────────────────────────
function appUrl() { return (process.env.APP_URL || 'https://chmup.top').replace(/\/$/, ''); }

function googleConfig() {
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!id || !secret) return null;
  return {
    clientId: id,
    clientSecret: secret,
    redirectUri: process.env.OAUTH_REDIRECT_URL
      || `${appUrl()}/api/auth/oauth/google/callback`,
  };
}

function telegramConfig() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  return { token, username: process.env.TELEGRAM_BOT_USERNAME || 'CHMUP_bot' };
}

function providers() {
  const g = googleConfig();
  const tg = telegramConfig();
  return {
    google: { enabled: Boolean(g), clientId: g ? g.clientId : null },
    telegram: { enabled: Boolean(tg), username: tg ? tg.username : null },
  };
}

// ── HTTP helper (no deps) ──────────────────────────────────────────────
function postForm(url, body) {
  return new Promise((resolve, reject) => {
    const payload = new URLSearchParams(body).toString();
    const u = new URL(url);
    const req = https.request(u, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 8000,
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch (e) { resolve({ status: res.statusCode, body: { raw: buf } }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(payload); req.end();
  });
}

function getJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers, timeout: 8000 }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch (e) { resolve({ status: res.statusCode, body: { raw: buf } }); }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

// ── Google OAuth 2.0 ───────────────────────────────────────────────────
// Flow: /start → Google → /callback with ?code=... → exchange → userinfo → upsert.
function googleAuthUrl(state) {
  const cfg = googleConfig();
  if (!cfg) throw Object.assign(new Error('Google OAuth not configured'), { statusCode: 503, code: 'OAUTH_DISABLED' });
  const p = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    state,
    prompt: 'select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`;
}

async function googleExchangeCode(code) {
  const cfg = googleConfig();
  if (!cfg) throw Object.assign(new Error('Google OAuth not configured'), { statusCode: 503 });
  const { status, body } = await postForm('https://oauth2.googleapis.com/token', {
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    grant_type: 'authorization_code',
  });
  if (status !== 200 || !body.access_token) {
    throw Object.assign(new Error('Google token exchange failed: ' + (body.error_description || body.error || status)),
      { statusCode: 401, code: 'OAUTH_TOKEN_FAILED' });
  }
  return body; // { access_token, id_token, expires_in, scope, token_type }
}

async function googleFetchProfile(accessToken) {
  const { status, body } = await getJson(
    'https://www.googleapis.com/oauth2/v3/userinfo',
    { Authorization: 'Bearer ' + accessToken }
  );
  if (status !== 200 || !body.email) {
    throw Object.assign(new Error('Google userinfo failed'), { statusCode: 401, code: 'OAUTH_USERINFO_FAILED' });
  }
  return {
    sub: body.sub,
    email: String(body.email).toLowerCase(),
    emailVerified: Boolean(body.email_verified),
    givenName: body.given_name || null,
    familyName: body.family_name || null,
    name: body.name || null,
    picture: body.picture || null,
  };
}

// ── Telegram Login Widget HMAC verify ──────────────────────────────────
// Docs: https://core.telegram.org/widgets/login#checking-authorization
// 1. Build data_check_string from sorted key=value pairs (excluding hash)
// 2. HMAC-SHA256 with key = SHA256(bot_token)
// 3. Compare hex digest to received hash (constant-time)
// 4. Reject if auth_date older than 24h (replay protection)
function verifyTelegram(payload) {
  const cfg = telegramConfig();
  if (!cfg) throw Object.assign(new Error('Telegram bot not configured'), { statusCode: 503, code: 'OAUTH_DISABLED' });
  if (!payload || typeof payload !== 'object' || !payload.hash || !payload.id) {
    throw Object.assign(new Error('Invalid Telegram payload'), { statusCode: 400, code: 'INVALID_PAYLOAD' });
  }
  const { hash, ...data } = payload;
  const checkArr = Object.keys(data).sort().map((k) => `${k}=${data[k]}`);
  const checkString = checkArr.join('\n');
  const secretKey = crypto.createHash('sha256').update(cfg.token).digest();
  const expected = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');
  const receivedBuf = Buffer.from(String(hash), 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  if (receivedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(receivedBuf, expectedBuf)) {
    throw Object.assign(new Error('Telegram signature invalid'), { statusCode: 401, code: 'INVALID_SIGNATURE' });
  }
  const authDate = Number(payload.auth_date);
  if (!authDate || Date.now() / 1000 - authDate > 86400) {
    throw Object.assign(new Error('Telegram auth_date too old'), { statusCode: 401, code: 'EXPIRED' });
  }
  return {
    tgId: String(payload.id),
    username: payload.username || null,
    firstName: payload.first_name || null,
    lastName: payload.last_name || null,
    photoUrl: payload.photo_url || null,
  };
}

// ── upsert + issue session ─────────────────────────────────────────────
// For every OAuth flow the end result is: (a) find existing user by
// provider-id OR by email → update profile fields; (b) create a new
// user if nothing matches; (c) issue refresh + access tokens the same
// way password login does, via authService.issueSessionForUser().
function upsertOAuthUser({
  provider,          // 'google' | 'telegram'
  providerId,        // google_id or tg_id
  email,             // may be null for Telegram
  emailVerified = false,
  givenName = null,
  familyName = null,
  avatarUrl = null,
  tgUsername = null, // Telegram-only
}) {
  const col = provider === 'google' ? 'google_id' : 'tg_id';
  let user = db.prepare(`SELECT * FROM users WHERE ${col} = ?`).get(providerId);
  let linked = false;

  if (!user && email) {
    // Link by email if the address is already registered — avoid duplicates
    user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (user) linked = true;
  }

  if (!user) {
    // Brand-new user
    const refCode = crypto.randomBytes(4).toString('hex').toUpperCase();
    const info = db.prepare(`
      INSERT INTO users
        (email, password_hash, referral_code, email_verified, is_active,
         oauth_provider, ${col}, given_name, family_name, avatar_url,
         telegram_username)
      VALUES (?, '', ?, ?, 1, ?, ?, ?, ?, ?, ?)
    `).run(
      email || `${provider}_${providerId}@chm.local`,
      refCode,
      emailVerified ? 1 : (provider === 'telegram' ? 1 : 0),
      provider,
      providerId,
      givenName,
      familyName,
      avatarUrl,
      tgUsername,
    );
    // Seed a free subscription so new user can land on the dashboard
    try {
      db.prepare(`INSERT OR IGNORE INTO subscriptions (user_id, plan, status) VALUES (?, 'free', 'active')`).run(info.lastInsertRowid);
    } catch (_e) {}
    audit(info.lastInsertRowid, 'auth.oauth_signup', { provider, email });
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  } else {
    // Existing user — link provider id if missing, refresh profile fields
    const patch = [];
    const args = [];
    if (!user[col]) { patch.push(`${col} = ?`); args.push(providerId); }
    if (!user.given_name && givenName) { patch.push('given_name = ?'); args.push(givenName); }
    if (!user.family_name && familyName) { patch.push('family_name = ?'); args.push(familyName); }
    if (!user.avatar_url && avatarUrl) { patch.push('avatar_url = ?'); args.push(avatarUrl); }
    // OAuth email-verified trumps local false
    if (!user.email_verified && emailVerified) { patch.push('email_verified = 1'); }
    if (tgUsername && !user.telegram_username) { patch.push('telegram_username = ?'); args.push(tgUsername); }
    if (patch.length) {
      args.push(user.id);
      db.prepare(`UPDATE users SET ${patch.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...args);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    }
    audit(user.id, linked ? 'auth.oauth_link' : 'auth.oauth_login', { provider });
  }
  return user;
}

function audit(userId, action, metadata) {
  try {
    db.prepare(`
      INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
      VALUES (?, ?, 'user', ?, ?)
    `).run(userId, action, userId, JSON.stringify(metadata || {}));
  } catch (_e) { /* non-fatal */ }
}

// State token for CSRF protection on the Google redirect.
// Simple HMAC of issue-time; valid for 10 minutes.
function issueState() {
  const nonce = crypto.randomBytes(12).toString('hex');
  const ts = Date.now();
  const sig = crypto.createHmac('sha256', process.env.JWT_SECRET || 'dev')
    .update(nonce + ':' + ts).digest('hex').slice(0, 24);
  return `${nonce}.${ts}.${sig}`;
}
function verifyState(state) {
  if (!state || typeof state !== 'string') return false;
  const [nonce, tsRaw, sig] = state.split('.');
  if (!nonce || !tsRaw || !sig) return false;
  const ts = Number(tsRaw);
  if (Date.now() - ts > 10 * 60 * 1000) return false;
  const expected = crypto.createHmac('sha256', process.env.JWT_SECRET || 'dev')
    .update(nonce + ':' + ts).digest('hex').slice(0, 24);
  return sig === expected;
}

module.exports = {
  providers,
  googleAuthUrl,
  googleExchangeCode,
  googleFetchProfile,
  verifyTelegram,
  upsertOAuthUser,
  issueState,
  verifyState,
};
