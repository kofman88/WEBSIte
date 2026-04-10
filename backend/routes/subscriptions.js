const express = require('express');
const { authMiddleware, requireTier } = require('../middleware/auth');
const subscriptionService = require('../services/subscriptionService');

const router = express.Router();

// ── Public ───────────────────────────────────────────────────────────────

/**
 * GET /api/subscriptions/plans
 * Return the plan catalogue. No auth required.
 */
router.get('/plans', (_req, res) => {
  try {
    const plans = subscriptionService.getPlans();
    res.json({ plans });
  } catch (error) {
    console.error('Error fetching plans:', error.message);
    res.status(500).json({ error: 'Failed to fetch subscription plans' });
  }
});

// ── Authenticated ────────────────────────────────────────────────────────

/**
 * GET /api/subscriptions/status
 * Return the calling user's current subscription (with plan details & limits).
 */
router.get('/status', authMiddleware, (req, res) => {
  try {
    const subscription = subscriptionService.getUserSubscription(req.userId);
    const limits = subscriptionService.getUserLimits(req.userId);
    res.json({ subscription, limits });
  } catch (error) {
    console.error('Error fetching subscription status:', error.message);
    res.status(500).json({ error: 'Failed to fetch subscription status' });
  }
});

/**
 * POST /api/subscriptions/activate
 * Activate or upgrade a subscription.
 * Body: { plan, paymentMethod?, paymentTx?, durationDays? }
 */
router.post('/activate', authMiddleware, (req, res) => {
  try {
    const { plan, paymentMethod, paymentTx, durationDays } = req.body;

    if (!plan) {
      return res.status(400).json({ error: 'plan is required' });
    }

    const subscription = subscriptionService.activateSubscription(req.userId, {
      plan,
      paymentMethod,
      paymentTx,
      durationDays,
    });

    res.json({
      message: `Subscription activated: ${plan}`,
      subscription,
    });
  } catch (error) {
    console.error('Error activating subscription:', error.message);
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /api/subscriptions/promo
 * Apply a promotional code.
 * Body: { code }
 */
router.post('/promo', authMiddleware, (req, res) => {
  try {
    const { code } = req.body;

    if (!code || typeof code !== 'string' || code.trim().length === 0) {
      return res.status(400).json({ error: 'A promo code is required' });
    }

    const subscription = subscriptionService.applyPromoCode(req.userId, code.trim().toUpperCase());

    res.json({
      message: 'Promo code applied successfully',
      subscription,
    });
  } catch (error) {
    console.error('Error applying promo code:', error.message);
    res.status(400).json({ error: error.message });
  }
});

/**
 * GET /api/subscriptions/limits
 * Return the feature limits for the calling user.
 */
router.get('/limits', authMiddleware, (req, res) => {
  try {
    const limits = subscriptionService.getUserLimits(req.userId);
    const canBot = subscriptionService.canCreateBot(req.userId);
    const canSignal = subscriptionService.canViewSignal(req.userId);

    res.json({
      limits,
      canCreateBot: canBot,
      canViewSignal: canSignal,
    });
  } catch (error) {
    console.error('Error fetching limits:', error.message);
    res.status(500).json({ error: 'Failed to fetch subscription limits' });
  }
});

module.exports = router;
