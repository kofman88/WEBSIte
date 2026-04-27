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
      SELECT u.id, u.email, u.is_admin, u.admin_role, u.is_active, s.plan
      FROM users u LEFT JOIN subscriptions s ON s.user_id = u.id
      WHERE u.id = ?
    `).get(decoded.uid);
    if (!row) return res.status(401).json({ error: 'User not found', code: 'NO_USER' });
    if (!row.is_active) return res.status(403).json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });

    req.userId = row.id;
    req.userEmail = row.email;
    req.userPlan = row.plan || 'free';
    req.isAdmin = Boolean(row.is_admin);
    req.adminRole = row.is_admin ? (row.admin_role || 'superadmin') : null;
    req.user = row;
    // Impersonation: when an admin issued this token via /admin/users/:id/
    // impersonate, decoded.imp holds the original admin id. The target
    // user is still used for authz (req.userId = target.id), but any
    // audited action can log who was actually behind the keyboard.
    if (decoded.imp) {
      // Verify the token hasn't been revoked. Tokens issued before the
      // jti migration won't have decoded.jti — accept them so we don't
      // break existing in-flight impersonation sessions on deploy. New
      // tokens always carry jti and MUST resolve to an active row.
      if (decoded.jti) {
        const imp = db.prepare(`
          SELECT revoked_at FROM impersonation_tokens
          WHERE jti = ?
        `).get(decoded.jti);
        if (!imp) {
          return res.status(401).json({ error: 'Impersonation token not registered', code: 'IMP_NOT_FOUND' });
        }
        if (imp.revoked_at) {
          return res.status(401).json({ error: 'Impersonation token revoked', code: 'IMP_REVOKED' });
        }
      }
      req.impersonatedBy = Number(decoded.imp);
    }
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

// Test-env detection (also used by rate limiters below)
const TESTING = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';

// Block sensitive actions until the user has confirmed their email.
// Apply AFTER authMiddleware on routes that interact with money / trading
// (bot creation, exchange keys, payments, live trading). Admins and
// impersonators bypass to allow support work.
function requireVerifiedEmail(req, res, next) {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
  // Tests spin up fresh users without going through the full signup-email
  // flow, so email_verified stays 0. Bypass in test env so the middleware
  // doesn't break unrelated integration tests.
  if (TESTING) return next();
  // req.impersonatedBy is set by authMiddleware when an admin issued a
  // token via /admin/users/:id/impersonate. Earlier versions of this
  // file referenced a non-existent req.isImpersonating which silently
  // never bypassed — admins doing support work hit EMAIL_NOT_VERIFIED.
  if (req.isAdmin || req.impersonatedBy) return next();
  const db = require('../models/database');
  try {
    const row = db.prepare('SELECT email_verified FROM users WHERE id = ?').get(req.userId);
    if (!row || !row.email_verified) {
      return res.status(403).json({
        error: 'Email confirmation required',
        code: 'EMAIL_NOT_VERIFIED',
        hint: 'Подтвердите email — проверьте почту или запросите письмо заново.',
      });
    }
  } catch (_e) {
    // DB hiccup — fail-open rather than lock everyone out, but log it
    logger.warn('requireVerifiedEmail DB lookup failed', { userId: req.userId });
  }
  next();
}

// ── Rate limiters ────────────────────────────────────────────────────────
// Skip rate limiting in test env so supertest can hammer endpoints freely.
// TESTING is already declared above (shared with requireVerifiedEmail).
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

// 2FA verify — prevent brute-forcing 6-digit TOTP (1M combos otherwise
// testable in seconds without a limit). Keyed by IP + login-token so the
// attacker can't just rotate IPs against one target.
const twoFactorLimiter = TESTING ? noop : rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many 2FA attempts. Try again in 15 minutes.', code: 'RATE_LIMITED' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const tok = (req.body && req.body.pendingToken) || '';
    return req.ip + ':' + String(tok).slice(0, 16);
  },
});

// Exchange API key operations — brute-forcing credential validation is
// expensive on upstream (429 from Bybit/Binance) and leaks info. Tight cap.
const exchangeKeyLimiter = TESTING ? noop : rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Too many exchange key operations. Try again later.', code: 'RATE_LIMITED' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.userId ? 'u:' + req.userId : 'ip:' + req.ip),
});

// ── Admin sub-roles ─────────────────────────────────────────────────────
// Each role is a bundle of capabilities. `superadmin` always has '*' and
// implicitly grants everything. Add/remove roles by editing ADMIN_ROLES
// only — all enforcement reads from this map.
const ADMIN_ROLES = {
  superadmin: ['*'], // root — can do anything, including grant admin
  support: [
    'ops.read', 'user.read', 'user.notify', 'user.plan_change', 'user.block',
    'support.read', 'support.reply', 'support.close',
    'bot.read', 'trade.read', 'signal.read', 'audit.read',
    'impersonate',
  ],
  billing: [
    'ops.read', 'user.read', 'user.plan_change',
    'payment.read', 'payment.confirm', 'payment.refund',
    'promo.read', 'promo.write',
    'reward.read', 'reward.payout',
    'audit.read',
  ],
  viewer: [
    'ops.read', 'user.read',
    'bot.read', 'trade.read', 'signal.read',
    'payment.read', 'support.read', 'audit.read',
  ],
};
function capsFor(role) {
  if (!role) return new Set();
  const caps = ADMIN_ROLES[role] || [];
  return new Set(caps);
}
function hasCapability(req, cap) {
  if (!req.isAdmin) return false;
  const caps = capsFor(req.adminRole);
  return caps.has('*') || caps.has(cap);
}
function requireCapability(cap) {
  return (req, res, next) => {
    if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
    if (!hasCapability(req, cap)) {
      logger.warn('capability denied', { userId: req.userId, role: req.adminRole, cap });
      return res.status(403).json({ error: 'Not permitted', code: 'FORBIDDEN', required: cap });
    }
    next();
  };
}

// Per-plan rate limit. Usage: router.post('/heavy', authMiddleware,
// tierLimiter({ free: 20, starter: 60, pro: 300, elite: 1200 }, '1m'), ...);
// The window string accepts "1m" / "10s" / "1h".
function tierLimiter(caps, windowStr = '1m') {
  if (TESTING) return noop;
  const m = /^(\d+)([smh])$/.exec(String(windowStr));
  const windowMs = m ? Number(m[1]) * ({ s: 1000, m: 60_000, h: 3_600_000 }[m[2]]) : 60_000;
  const limiters = {};
  for (const plan of Object.keys(caps)) {
    limiters[plan] = rateLimit({
      windowMs, max: caps[plan],
      message: { error: `Rate limit for plan "${plan}" hit — upgrade or wait`, code: 'RATE_LIMITED_TIER', plan },
      standardHeaders: true, legacyHeaders: false,
      keyGenerator: (req) => (req.userId ? 'u:' + req.userId : 'ip:' + req.ip),
      skip: (req) => Boolean(req.isAdmin), // admins bypass product limits
    });
  }
  return (req, res, next) => {
    const plan = req.userPlan || 'free';
    const lim = limiters[plan] || limiters.free;
    if (!lim) return next();
    return lim(req, res, next);
  };
}

module.exports = {
  authMiddleware,
  requireTier,
  requireFeature,
  requireAdmin,
  requireVerifiedEmail,
  requireCapability,
  hasCapability,
  ADMIN_ROLES,
  loginLimiter,
  registerLimiter,
  passwordResetLimiter,
  twoFactorLimiter,
  exchangeKeyLimiter,
  tierLimiter,
};
