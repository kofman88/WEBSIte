const express = require('express');
const authService = require('../services/authService');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/register
router.post('/register', (req, res) => {
  try {
    const { email, password, referralCode } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email format' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    authService.register(email.toLowerCase().trim(), password, referralCode);
    const loginResult = authService.login(email.toLowerCase().trim(), password);

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
    authService.verifyEmail(token);
    res.json({ message: 'Email verified successfully' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const result = authService.requestPasswordReset(email.toLowerCase().trim());
    // In production: send email with link containing result.resetToken
    // For now: return token (remove in production!)
    res.json({ message: 'If this email exists, a reset link has been sent', resetToken: result.resetToken });
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
