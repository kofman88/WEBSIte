const express = require('express');
const { z } = require('zod');
const authService = require('../services/authService');
const twoFactorService = require('../services/twoFactorService');
const {
  authMiddleware,
  loginLimiter,
  registerLimiter,
  passwordResetLimiter,
} = require('../middleware/auth');
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
router.post('/register', registerLimiter, (req, res, next) => {
  try {
    const input = validation.registerSchema.parse(req.body);
    const out = authService.register({
      email: input.email,
      password: input.password,
      displayName: input.displayName,
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
router.post('/password-reset/confirm', (req, res, next) => {
  try {
    const input = z.object({
      token: z.string().min(16).max(256),
      newPassword: validation.password,
    }).parse(req.body);
    const out = authService.confirmPasswordReset({
      token: input.token,
      newPassword: input.newPassword,
      ipAddress: getIp(req),
      userAgent: getUA(req),
    });
    res.json(out);
  } catch (err) { handleServiceError(err, res, next); }
});

// POST /api/auth/change-password (auth'd)
router.post('/change-password', authMiddleware, (req, res, next) => {
  try {
    const input = z.object({
      currentPassword: z.string().min(1).max(128),
      newPassword: validation.password,
    }).parse(req.body);
    const out = authService.changePassword({
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

router.post('/2fa/confirm', authMiddleware, (req, res, next) => {
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
router.post('/2fa/verify-login', (req, res, next) => {
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

module.exports = router;
