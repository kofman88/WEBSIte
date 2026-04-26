const express = require('express');
const { z } = require('zod');
const authService = require('../services/authService');
const twoFactorService = require('../services/twoFactorService');
const {
  authMiddleware,
  loginLimiter,
  registerLimiter,
  passwordResetLimiter,
  twoFactorLimiter,
} = require('../middleware/auth');
const { geoBlock } = require('../middleware/geoBlock');
const validation = require('../utils/validation');

const router = express.Router();

function getIp(req) { return req.ip || req.headers['x-forwarded-for'] || null; }
function getUA(req) { return req.headers['user-agent'] || null; }

function handleZod(err, res) {
  return res.status(400).json({
    error: 'Validation failed',
    code: 'VALIDATION_ERROR',
    issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  });
}

function handleServiceError(err, res, next) {
  if (err instanceof z.ZodError) return handleZod(err, res);
  if (err && err.statusCode) {
    return res.status(err.statusCode).json({
      error: err.message,
      ...(err.code ? { code: err.code } : {}),
    });
  }
  return next(err);
}

// POST /api/auth/register
router.post('/register', geoBlock(), registerLimiter, async (req, res, next) => {
  try {
    const input = validation.registerSchema.parse(req.body);
    const out = await authService.register({
      email: input.email,
      password: input.password,
      displayName: input.displayName,
      givenName: input.givenName,
      familyName: input.familyName,
      referralCode: input.referralCode,
      ipAddress: getIp(req),
      userAgent: getUA(req),
    });
    res.status(201).json(out);
  } catch (err) { handleServiceError(err, res, next); }
});

// POST /api/auth/login
router.post('/login', loginLimiter, (req, res, next) => {
  try {
    const input = validation.loginSchema.parse(req.body);
    const out = authService.login({
      email: input.email,
      password: input.password,
      ipAddress: getIp(req),
      userAgent: getUA(req),
    });
    res.json(out);
  } catch (err) { handleServiceError(err, res, next); }
});

// POST /api/auth/refresh
router.post('/refresh', (req, res, next) => {
  try {
    const input = validation.refreshSchema.parse(req.body);
    const out = authService.refresh({
      refreshToken: input.refreshToken,
      ipAddress: getIp(req),
      userAgent: getUA(req),
    });
    res.json(out);
  } catch (err) { handleServiceError(err, res, next); }
});

// POST /api/auth/logout
router.post('/logout', (req, res, next) => {
  try {
    const input = validation.refreshSchema.parse(req.body);
    authService.logout({
      refreshToken: input.refreshToken,
      ipAddress: getIp(req),
      userAgent: getUA(req),
    });
    res.json({ success: true });
  } catch (err) { handleServiceError(err, res, next); }
});

// POST /api/auth/logout-all (auth'd) — revoke all refresh tokens
router.post('/logout-all', authMiddleware, (req, res, next) => {
  try {
    authService.logoutAll({
      userId: req.userId,
      ipAddress: getIp(req),
      userAgent: getUA(req),
    });
    res.json({ success: true });
  } catch (err) { handleServiceError(err, res, next); }
});

// GET /api/auth/me
router.get('/me', authMiddleware, (req, res, next) => {
  try {
    const user = authService.getUserPublic(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (err) { handleServiceError(err, res, next); }
});

// GET /api/auth/me/export — GDPR subject-access export.
router.get('/me/export', authMiddleware, (req, res, next) => {
  try {
    const dataExport = require('../services/dataExportService');
    const data = dataExport.build(req.userId);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const db = require('../models/database');
    db.prepare(`
      INSERT INTO audit_log (user_id, action, entity_type, entity_id, ip_address, user_agent)
      VALUES (?, 'user.data_export', 'user', ?, ?, ?)
    `).run(req.userId, req.userId, req.ip, req.get('user-agent'));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="chm-data-export-' + ts + '.json"');
    res.send(JSON.stringify(data, null, 2));
  } catch (err) { handleServiceError(err, res, next); }
});

// POST /api/auth/password-reset/request
router.post('/password-reset/request', passwordResetLimiter, (req, res, next) => {
  try {
    const input = z.object({ email: validation.email }).parse(req.body);
    const out = authService.requestPasswordReset({
      email: input.email,
      ipAddress: getIp(req),
      userAgent: getUA(req),
    });
    res.json(out);
  } catch (err) { handleServiceError(err, res, next); }
});

// POST /api/auth/password-reset/confirm
router.post('/password-reset/confirm', async (req, res, next) => {
  try {
    const input = z.object({
      token: z.string().min(16).max(256),
      newPassword: validation.password,
    }).parse(req.body);
    const out = await authService.confirmPasswordReset({
      token: input.token,
      newPassword: input.newPassword,
      ipAddress: getIp(req),
      userAgent: getUA(req),
    });
    res.json(out);
  } catch (err) { handleServiceError(err, res, next); }
});

// POST /api/auth/change-password (auth'd)
router.post('/change-password', authMiddleware, async (req, res, next) => {
  try {
    const input = z.object({
      currentPassword: z.string().min(1).max(128),
      newPassword: validation.password,
    }).parse(req.body);
    const out = await authService.changePassword({
      userId: req.userId,
      currentPassword: input.currentPassword,
      newPassword: input.newPassword,
      ipAddress: getIp(req),
      userAgent: getUA(req),
    });
    res.json(out);
  } catch (err) { handleServiceError(err, res, next); }
});

// ── Email verification ────────────────────────────────────────────────
router.post('/verify-email/request', authMiddleware, (req, res, next) => {
  try {
    const out = authService.requestEmailVerification({
      userId: req.userId, email: req.userEmail,
      ipAddress: getIp(req), userAgent: getUA(req),
    });
    res.json(out);
  } catch (err) { handleServiceError(err, res, next); }
});

// GET or POST — click from email
router.get('/verify-email/:token', (req, res, next) => {
  try {
    const token = z.string().min(16).max(256).parse(req.params.token);
    authService.verifyEmail({ token, ipAddress: getIp(req), userAgent: getUA(req) });
    // Redirect to frontend confirmation page instead of JSON
    res.redirect('/?verified=1');
  } catch (err) {
    if (err && err.statusCode) return res.redirect('/?verified=0&code=' + encodeURIComponent(err.code || 'ERR'));
    return handleServiceError(err, res, next);
  }
});
router.post('/verify-email/confirm', (req, res, next) => {
  try {
    const input = z.object({ token: z.string().min(16).max(256) }).parse(req.body);
    const out = authService.verifyEmail({ token: input.token, ipAddress: getIp(req), userAgent: getUA(req) });
    res.json(out);
  } catch (err) { handleServiceError(err, res, next); }
});

// ── 2FA management ───────────────────────────────────────────────────
router.get('/2fa/status', authMiddleware, (req, res, next) => {
  try { res.json(twoFactorService.status(req.userId)); }
  catch (err) { handleServiceError(err, res, next); }
});

router.post('/2fa/setup', authMiddleware, (req, res, next) => {
  try {
    const out = twoFactorService.setup(req.userId, req.userEmail);
    res.json(out);
  } catch (err) { handleServiceError(err, res, next); }
});

router.post('/2fa/confirm', authMiddleware, twoFactorLimiter, (req, res, next) => {
  try {
    const input = z.object({ code: z.string().min(6).max(16) }).parse(req.body);
    res.json(twoFactorService.confirm(req.userId, input.code));
  } catch (err) { handleServiceError(err, res, next); }
});

router.post('/2fa/disable', authMiddleware, (req, res, next) => {
  try {
    const input = z.object({ password: z.string().min(1) }).parse(req.body);
    // Re-authenticate with password first
    const bcrypt = require('bcryptjs');
    const db = require('../models/database');
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.userId);
    if (!row || !bcrypt.compareSync(input.password, row.password_hash)) {
      return res.status(401).json({ error: 'Wrong password', code: 'WRONG_PASSWORD' });
    }
    res.json(twoFactorService.disable(req.userId));
  } catch (err) { handleServiceError(err, res, next); }
});

// Login completion when 2FA is enabled
router.post('/2fa/verify-login', twoFactorLimiter, (req, res, next) => {
  try {
    const input = z.object({
      pendingToken: z.string().min(10),
      code: z.string().min(6).max(16),
    }).parse(req.body);
    const out = authService.finalizeLoginAfter2FA({
      pendingToken: input.pendingToken, code: input.code,
      ipAddress: getIp(req), userAgent: getUA(req),
    });
    res.json(out);
  } catch (err) { handleServiceError(err, res, next); }
});

// ── Sessions / history ──────────────────────────────────────────────
router.get('/sessions', authMiddleware, (req, res, next) => {
  try { res.json({ sessions: authService.listSessions(req.userId) }); }
  catch (err) { handleServiceError(err, res, next); }
});

router.delete('/sessions/:id', authMiddleware, (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    res.json(authService.revokeSession({
      userId: req.userId, sessionId: id,
      ipAddress: getIp(req), userAgent: getUA(req),
    }));
  } catch (err) { handleServiceError(err, res, next); }
});

router.get('/login-history', authMiddleware, (req, res, next) => {
  try {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(req.query);
    res.json({ history: authService.listLoginHistory(req.userId, q) });
  } catch (err) { handleServiceError(err, res, next); }
});

// ── OAuth / Social login (Google + Telegram) ─────────────────────────
const oauth = require('../services/oauthService');

// Tiny cookie parser — avoids adding cookie-parser as a runtime dep.
// Returns the value of the named cookie or '' if absent / malformed.
function readCookie(req, name) {
  const raw = req.headers && req.headers.cookie;
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) {
      try { return decodeURIComponent(part.slice(idx + 1).trim()); } catch (_e) { return ''; }
    }
  }
  return '';
}

// Feature-flag endpoint — frontend reads this to know which buttons to render.
router.get('/oauth/providers', (_req, res) => {
  try { res.json(oauth.providers()); } catch (_e) { res.json({}); }
});

// Google: step 1 — redirect the browser to the Google consent screen.
router.get('/oauth/google/start', (req, res) => {
  try {
    const state = oauth.issueState();
    // Remember where to send the user back to (passed as ?redirect=/dashboard.html)
    const returnTo = typeof req.query.redirect === 'string' && req.query.redirect.startsWith('/')
      ? req.query.redirect : '/dashboard.html';
    res.cookie('oauth_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000, secure: process.env.NODE_ENV === 'production' });
    res.cookie('oauth_return', returnTo, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000, secure: process.env.NODE_ENV === 'production' });
    res.redirect(oauth.googleAuthUrl(state));
  } catch (err) {
    if (err.statusCode === 503) return res.redirect('/?oauth_error=disabled&provider=google');
    res.redirect('/?oauth_error=start_failed');
  }
});

// Google: step 2 — callback with ?code=...&state=...
router.get('/oauth/google/callback', async (req, res) => {
  try {
    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    const cookieState = readCookie(req, 'oauth_state');
    if (!code) return res.redirect('/?oauth_error=no_code');
    if (!state || state !== cookieState || !oauth.verifyState(state)) {
      return res.redirect('/?oauth_error=bad_state');
    }
    const tok = await oauth.googleExchangeCode(code);
    const profile = await oauth.googleFetchProfile(tok.access_token);
    const user = oauth.upsertOAuthUser({
      provider: 'google',
      providerId: profile.sub,
      email: profile.email,
      emailVerified: profile.emailVerified,
      givenName: profile.givenName,
      familyName: profile.familyName,
      avatarUrl: profile.picture,
    });
    const session = authService.issueSessionForUser(user.id, { ipAddress: getIp(req), userAgent: getUA(req) });
    const returnTo = readCookie(req, 'oauth_return') || '/dashboard.html';
    res.clearCookie('oauth_state'); res.clearCookie('oauth_return');
    // URL fragment — tokens never hit server logs / referrer headers
    const frag = new URLSearchParams({
      access_token: session.accessToken,
      refresh_token: session.refreshToken,
      provider: 'google',
    }).toString();
    res.redirect(returnTo + '#' + frag);
  } catch (err) {
    const code = err && err.code ? err.code : 'ERR';
    res.redirect('/?oauth_error=' + encodeURIComponent(code));
  }
});

// Telegram: POST with the Login Widget payload {id, first_name, username, photo_url, auth_date, hash}
router.post('/oauth/telegram', (req, res, next) => {
  try {
    const payload = z.object({
      id: z.union([z.string(), z.number()]).transform(String),
      first_name: z.string().optional(),
      last_name: z.string().optional(),
      username: z.string().optional(),
      photo_url: z.string().optional(),
      auth_date: z.union([z.string(), z.number()]).transform(Number),
      hash: z.string().min(32),
    }).parse(req.body);
    const tg = oauth.verifyTelegram(payload);
    const user = oauth.upsertOAuthUser({
      provider: 'telegram',
      providerId: tg.tgId,
      email: null,
      emailVerified: false,
      givenName: tg.firstName,
      familyName: tg.lastName,
      avatarUrl: tg.photoUrl,
      tgUsername: tg.username,
    });
    const session = authService.issueSessionForUser(user.id, { ipAddress: getIp(req), userAgent: getUA(req) });
    res.json(session);
  } catch (err) { handleServiceError(err, res, next); }
});

module.exports = router;
