const express = require('express');
const authService = require('../services/authService');
const emailService = require('../services/emailService');
const { authMiddleware } = require('../middleware/auth');
const config = require('../config');

async function verifyCaptcha(token) {
  if (!config.recaptchaSecret || !token) return true; // skip if not configured
  try {
    const res = await fetch(`https://www.google.com/recaptcha/api/siteverify?secret=${config.recaptchaSecret}&response=${token}`, { method: 'POST' });
    const data = await res.json();
    return data.success === true;
  } catch (e) { return true; } // don't block on network errors
}

const router = express.Router();

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { email, password, referralCode, captchaToken } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email format' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    // Verify reCAPTCHA
    const captchaOk = await verifyCaptcha(captchaToken);
    if (!captchaOk) return res.status(400).json({ error: 'Проверка reCAPTCHA не пройдена. Попробуйте ещё раз.' });

    const registerResult = authService.register(email.toLowerCase().trim(), password, referralCode);
    const loginResult = authService.login(email.toLowerCase().trim(), password);

    // Send verification email (async, don't block response)
    emailService.sendVerificationEmail(email.toLowerCase().trim(), registerResult.emailVerifyToken)
      .catch(e => console.error('Verification email error:', e.message));

    res.status(201).json({ message: 'User registered successfully', token: loginResult.token, user: loginResult.user });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/auth/login
router.post('/login', (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    const result = authService.login(email.toLowerCase().trim(), password);
    res.json({ message: 'Login successful', ...result });
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});

// GET /api/auth/me
router.get('/me', authMiddleware, (req, res) => {
  try {
    const user = authService.getUserById(req.userId);
    let subscription = null;
    try {
      const subscriptionService = require('../services/subscriptionService');
      const sub = subscriptionService.getUserSubscription(req.userId);
      if (sub) subscription = { plan: sub.plan || 'free', status: sub.status || 'active', expiresAt: sub.expires_at || null };
    } catch (e) { console.log('Sub fetch error:', e.message); }

    res.json({
      user,
      subscription: subscription ? { plan: subscription.plan, status: subscription.status, expiresAt: subscription.expires_at } : null,
    });
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});

// GET /api/auth/verify-email?token=xxx
router.get('/verify-email', (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Token required' });

    // Get user email before verification (for welcome email)
    const db = require('../models/database');
    const user = db.prepare('SELECT email FROM users WHERE email_verify_token = ?').get(token);

    authService.verifyEmail(token);

    // Send welcome email after successful verification
    if (user && user.email) {
      emailService.sendWelcomeEmail(user.email).catch(e => console.error('Welcome email error:', e.message));
    }

    // Redirect to dashboard with success message
    res.redirect('/dashboard.html?verified=1');
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const result = authService.requestPasswordReset(email.toLowerCase().trim());

    // Send password reset email
    emailService.sendPasswordResetEmail(email.toLowerCase().trim(), result.resetToken)
      .catch(e => console.error('Reset email error:', e.message));

    res.json({ message: 'If this email exists, a reset link has been sent' });
  } catch (error) {
    res.json({ message: 'If this email exists, a reset link has been sent' });
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
    authService.resetPassword(token, password);
    res.json({ message: 'Password reset successfully' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/auth/change-password (authenticated)
router.post('/change-password', authMiddleware, (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
    authService.changePassword(req.userId, currentPassword, newPassword);
    res.json({ message: 'Password changed successfully' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
