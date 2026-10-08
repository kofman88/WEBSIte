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

    res.json({
      limits,
      signalsPerDay: subscriptionService.planLimit(req.userId, 'signals_per_day'),
      analyzePerDay: subscriptionService.planLimit(req.userId, 'analyze_per_day'),
    });
  } catch (error) {
    console.error('Error fetching limits:', error.message);
    res.status(500).json({ error: 'Failed to fetch subscription limits' });
  }
});

// Plan usage snapshot — powers the topbar plan-pill dropdown. Single
// request returns everything the UI needs to render progress bars,
// next-plan teaser, and quick upgrade CTA, so we don't fan out 5 calls.
router.get('/usage', authMiddleware, (req, res) => {
  try {
    const db = require('../models/database');
    const plans = require('../config/plans');
    // Route through subscriptionService.getUserSubscription — it handles
    // expired-sub auto-downgrade.
    // A raw SELECT here would silently keep showing "Pro" to an expired
    // user until some other endpoint triggered the downgrade.
    const sub = subscriptionService.getUserSubscription(req.userId);
    const plan = plans.getLimits(sub.plan);
    const order = plans.PLAN_ORDER;
    const idx = order.indexOf(plan.id);
    const nextId = order[idx + 1] || null;
    const next = nextId ? plans.getPlan(nextId) : null;

    // Engine quotas (signals today, analyze count) join this snapshot with
    // the engine (M7/M10); until then only the exchange-key count is live.
    const keysCount = db.prepare('SELECT COUNT(*) AS n FROM exchange_keys WHERE user_id = ?').get(req.userId).n;

    // Features unlocked on the NEXT plan — simple diff string list for
    // the UI to render as a bullet teaser.
    const nextUnlocks = [];
    if (next) {
      if (!plan.autoTrade && next.autoTrade) nextUnlocks.push('Автоторговля с реальной биржей');
      if (!plan.bothDirections && next.bothDirections) nextUnlocks.push('LONG + SHORT одновременно');
      const newStrats = next.strategies.filter((s) => !plan.strategies.includes(s));
      if (newStrats.length) nextUnlocks.push('Стратегии: ' + newStrats.map((s) => s.toUpperCase()).join(', '));
      const newTfs = next.timeframes.filter((t) => !plan.timeframes.includes(t));
      if (newTfs.length) nextUnlocks.push('Таймфреймы: ' + newTfs.join(' · '));
      if (plan.signalsPerDay < next.signalsPerDay) nextUnlocks.push('Без лимита сигналов в день');
      if (!plan.genome && next.genome) nextUnlocks.push('Strategy Genome');
      if (!plan.challenge && next.challenge) nextUnlocks.push('Челлендж');
    }

    res.json({
      plan: { id: plan.id, name: plan.name, priceUsd: plan.priceUsd },
      status: sub.status || (sub.plan === 'free' ? 'active' : 'unknown'),
      expiresAt: sub.expires_at || null,
      trialEndsAt: sub.trial_ends_at || null,
      usage: {
        keys: { used: keysCount, limit: null },   // no hard cap per plan
      },
      next: next ? {
        id: next.id, name: next.name, priceUsd: next.priceUsd,
        unlocks: nextUnlocks,
      } : null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to fetch usage' });
  }
});

/**
 * POST /api/subscriptions/cancel
 * Self-serve cancellation. Body: { atPeriodEnd?: boolean = true }.
 *
 * - atPeriodEnd=true (default, Big-SaaS standard): user keeps paid-plan
 *   access until expires_at, then auto-downgrades to free. Stripe stops
 *   recurring charges on the next cycle. This is what users usually want.
 * - atPeriodEnd=false: immediate cancel + downgrade. Excess bots are
 *   deactivated. No refund (user can request one via support within 14 days,
 *   handled by admin.refundPayment).
 */
router.post('/cancel', authMiddleware, async (req, res, next) => {
  try {
    const { z } = require('zod');
    const body = z.object({ atPeriodEnd: z.boolean().optional().default(true) }).parse(req.body || {});
    const paymentService = require('../services/paymentService');
    const out = await paymentService.cancelSubscription(req.userId, { atPeriodEnd: body.atPeriodEnd });
    res.json(out);
  } catch (err) {
    const handleErr = require('../middleware/handleErr');
    handleErr(err, res, next);
  }
});

module.exports = router;
