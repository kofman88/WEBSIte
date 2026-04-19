const rateLimit = require('express-rate-limit');
const authService = require('../services/authService');
const db = require('../models/database');
const plans = require('../config/plans');
const logger = require('../utils/logger');

/**
 * JWT authentication — extracts Bearer token, verifies, attaches req.user.
 */
function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication token required', code: 'NO_TOKEN' });
    }
    const token = authHeader.slice(7).trim();
    const decoded = authService.verifyAccessToken(token);
    if (!decoded || !decoded.uid) {
      return res.status(401).json({ error: 'Invalid token', code: 'INVALID_TOKEN' });
    }
    // Load basic user info (admin flag + plan) into req
    const row = db.prepare(`
      SELECT u.id, u.email, u.is_admin, u.is_active, s.plan
      FROM users u LEFT JOIN subscriptions s ON s.user_id = u.id
      WHERE u.id = ?
    `).get(decoded.uid);
    if (!row) return res.status(401).json({ error: 'User not found', code: 'NO_USER' });
    if (!row.is_active) return res.status(403).json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });

    req.userId = row.id;
    req.userEmail = row.email;
    req.userPlan = row.plan || 'free';
    req.isAdmin = Boolean(row.is_admin);
    req.user = row;
    next();
  } catch (err) {
    const code = err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN';
    return res.status(401).json({ error: 'Invalid or expired token', code });
  }
}

/**
 * Requires the authenticated user to be on at least the given plan.
 * Usage: router.post('/upgrade', authMiddleware, requireTier('pro'), ...)
 */
function requireTier(minimumPlan) {
  return (req, res, next) => {
    if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
    if (!plans.isAtLeast(req.userPlan, minimumPlan)) {
      return res.status(403).json({
        error: `This feature requires "${minimumPlan}" plan or higher`,
        code: 'UPGRADE_REQUIRED',
        currentPlan: req.userPlan,
        requiredPlan: minimumPlan,
      });
    }
    next();
  };
}

/**
 * Requires user to have autoTrade / optimizer / apiAccess etc.
 */
function requireFeature(feature) {
  return (req, res, next) => {
    if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
    if (!plans.canUseFeature(req.userPlan, feature)) {
      return res.status(403).json({
        error: `Feature "${feature}" is not available on your plan`,
        code: 'UPGRADE_REQUIRED',
        currentPlan: req.userPlan,
        requiredPlan: plans.requiredPlanFor(feature),
      });
    }
    next();
  };
}

function requireAdmin(req, res, next) {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
  if (!req.isAdmin) {
    logger.warn('non-admin attempted admin endpoint', { userId: req.userId, path: req.path });
    return res.status(403).json({ error: 'Admin only', code: 'FORBIDDEN' });
  }
  next();
}

// ── Rate limiters ────────────────────────────────────────────────────────
// Skip rate limiting in test env so supertest can hammer endpoints freely.
const TESTING = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
const noop = (_req, _res, next) => next();

const loginLimiter = TESTING ? noop : rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Too many login attempts. Try again in a minute.', code: 'RATE_LIMITED' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const email = (req.body && req.body.email ? String(req.body.email).toLowerCase() : '').trim();
    return req.ip + ':' + email;
  },
});

const registerLimiter = TESTING ? noop : rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { error: 'Too many registrations from this IP. Try again later.', code: 'RATE_LIMITED' },
  standardHeaders: true,
  legacyHeaders: false,
});

const passwordResetLimiter = TESTING ? noop : rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many password reset attempts. Try again later.', code: 'RATE_LIMITED' },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = {
  authMiddleware,
  requireTier,
  requireFeature,
  requireAdmin,
  loginLimiter,
  registerLimiter,
  passwordResetLimiter,
};
