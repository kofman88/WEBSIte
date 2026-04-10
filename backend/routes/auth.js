const express = require('express');
const authService = require('../services/authService');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

/**
 * POST /api/auth/register
 * Create a new user account.
 * Body: { email, password, referralCode? }
 */
router.post('/register', (req, res) => {
  try {
    const { email, password, referralCode } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Basic email format check
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const result = authService.register(email.toLowerCase().trim(), password, referralCode);

    res.status(201).json({
      message: 'User registered successfully',
      userId: result.userId,
      email: result.email,
    });
  } catch (error) {
    console.error('Registration error:', error.message);
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /api/auth/login
 * Authenticate and receive a JWT.
 * Body: { email, password }
 */
router.post('/login', (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const result = authService.login(email.toLowerCase().trim(), password);

    res.json({
      message: 'Login successful',
      ...result,
    });
  } catch (error) {
    console.error('Login error:', error.message);
    res.status(401).json({ error: error.message });
  }
});

/**
 * GET /api/auth/me
 * Return the currently authenticated user's profile.
 */
router.get('/me', authMiddleware, (req, res) => {
  try {
    const user = authService.getUserById(req.userId);

    // Also fetch subscription info
    let subscription = null;
    try {
      const subscriptionService = require('../services/subscriptionService');
      subscription = subscriptionService.getUserSubscription(req.userId);
    } catch (_) {
      // Non-critical
    }

    res.json({
      user,
      subscription: subscription ? {
        plan: subscription.plan,
        status: subscription.status,
        expiresAt: subscription.expires_at,
      } : null,
    });
  } catch (error) {
    console.error('Get user error:', error.message);
    res.status(401).json({ error: error.message });
  }
});

module.exports = router;
