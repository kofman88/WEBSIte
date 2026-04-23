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

// Plan usage snapshot — powers the topbar plan-pill dropdown. Single
// request returns everything the UI needs to render progress bars,
// next-plan teaser, and quick upgrade CTA, so we don't fan out 5 calls.
router.get('/usage', authMiddleware, (req, res) => {
  try {
    const db = require('../models/database');
    const plans = require('../config/plans');
    // Route through subscriptionService.getUserSubscription — it handles
    // expired-sub auto-downgrade + auto-pauses Elite-only market bots.
    // A raw SELECT here would silently keep showing "Pro" to an expired
    // user until some other endpoint triggered the downgrade.
    const sub = subscriptionService.getUserSubscription(req.userId);
    const plan = plans.getPlan(sub.plan) || plans.getPlan('free');
    const order = plans.PLAN_ORDER;
    const idx = order.indexOf(plan.id);
    const nextId = order[idx + 1] || null;
    const next = nextId ? plans.getPlan(nextId) : null;

    const startOfDayUtc = new Date(); startOfDayUtc.setUTCHours(0, 0, 0, 0);
    const startOfMonthUtc = new Date(); startOfMonthUtc.setUTCDate(1); startOfMonthUtc.setUTCHours(0, 0, 0, 0);

    const botCount = db.prepare('SELECT COUNT(*) AS n FROM trading_bots WHERE user_id = ? AND is_active = 1').get(req.userId).n;
    const signalsToday = db.prepare(
      'SELECT COUNT(*) AS n FROM signals WHERE user_id = ? AND created_at > ?'
    ).get(req.userId, startOfDayUtc.toISOString()).n;
    const keysCount = db.prepare('SELECT COUNT(*) AS n FROM exchange_keys WHERE user_id = ?').get(req.userId).n;
    const backtestsThisMonth = (() => {
      try {
        return db.prepare('SELECT COUNT(*) AS n FROM backtests WHERE user_id = ? AND created_at > ?').get(req.userId, startOfMonthUtc.toISOString()).n;
      } catch { return 0; }
    })();

    // Features unlocked on the NEXT plan — simple diff string list for
    // the UI to render as a bullet teaser.
    const nextUnlocks = [];
    if (next) {
      if (!plan.autoTrade && next.autoTrade) nextUnlocks.push('Автоторговля с реальной биржей');
      if (plan.paperTradingOnly && !next.paperTradingOnly) nextUnlocks.push('Live-режим (реальные деньги)');
      if (!plan.optimizer && next.optimizer) nextUnlocks.push('Оптимизатор параметров (grid-search)');
      if (!plan.apiAccess && next.apiAccess) nextUnlocks.push('REST API для своих скриптов');
      const newStrats = next.strategies.filter((s) => !plan.strategies.includes(s));
      if (newStrats.length) nextUnlocks.push('Стратегии: ' + newStrats.join(', '));
      if (next.maxLeverage > plan.maxLeverage) nextUnlocks.push('Плечо до ' + next.maxLeverage + '×');
      if (nextId === 'elite') nextUnlocks.push('Market Scanner по всему рынку');
    }

    const finite = (v) => (v === null || v === Infinity ? null : v);
    res.json({
      plan: { id: plan.id, name: plan.name, priceUsd: plan.priceUsd },
      status: sub.status || (sub.plan === 'free' ? 'active' : 'unknown'),
      expiresAt: sub.expires_at || null,
      trialEndsAt: sub.trial_ends_at || null,
      usage: {
        bots:      { used: botCount,           limit: finite(plan.maxBots) },
        signals:   { used: signalsToday,       limit: finite(plan.signalsPerDay) },
        keys:      { used: keysCount,          limit: null },   // no hard cap per plan
        backtests: { used: backtestsThisMonth, limit: finite(plan.backtestsPerDay) },
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

module.exports = router;
