const db = require('../models/database');
const plans = require('../config/plans');
const planFeatures = require('../config/planFeatures');

/**
 * Subscription service — the plan catalogue is derived from config/plans.js
 * (itself derived from the bot matrix in config/planFeatures.js): free + pro,
 * $69 / 30 days. Legacy ids (starter / elite / beginner) resolve through
 * plans.normalizePlan, so old subscription / promo rows keep working until
 * migration v12 rewrites them.
 */

function catalogueEntry(p) {
  return {
    id: p.id,
    name: p.name,
    price: p.priceUsd,
    interval: p.priceUsd ? 'month' : null,
    periodDays: p.periodDays,
    yearlyPrice: p.yearlyPriceUsd,
    strategies: p.strategies,
    timeframes: p.timeframes,
    // The bot's matrix verbatim (snake_case keys) — what the UI renders.
    features: p.features,
    limits: {
      signalsPerDay: p.signalsPerDay,
      analyzePerDay: p.analyzePerDay,
      symbolsLimit: p.symbolsLimit,
      autoTrade: p.autoTrade,
      bothDirections: p.bothDirections,
      multiExchange: p.multiExchange,
      genome: p.genome,
      challenge: p.challenge,
      apiAccess: p.apiAccess,
      prioritySupport: p.prioritySupport,
    },
  };
}

class SubscriptionService {
  /**
   * Return the static plan catalogue (public, no auth needed).
   */
  getPlans() {
    return plans.listPlans().map(catalogueEntry);
  }

  /**
   * Get or create the subscription record for a user.
   * Every user implicitly starts on the free plan.
   */
  getUserSubscription(userId) {
    let sub = db
      .prepare('SELECT * FROM subscriptions WHERE user_id = ?')
      .get(userId);

    if (!sub) {
      // Lazily insert a free-tier row
      db.prepare(
        `INSERT OR IGNORE INTO subscriptions (user_id, plan, status) VALUES (?, 'free', 'active')`
      ).run(userId);
      sub = db
        .prepare('SELECT * FROM subscriptions WHERE user_id = ?')
        .get(userId);
    }

    // Check expiry
    if (sub && sub.expires_at && new Date(sub.expires_at) < new Date()) {
      db.prepare(
        `UPDATE subscriptions SET plan = 'free', status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`
      ).run(userId);
      sub.plan = 'free';
      sub.status = 'expired';
    }

    const planId = plans.normalizePlan(sub.plan);

    return {
      ...sub,
      planId,
      planDetails: plans.getLimits(planId),
    };
  }

  /**
   * Activate (or upgrade) a subscription.
   *
   * In production this would verify a Stripe / crypto payment.
   * For now we accept a payment_tx string and trust the caller; it is
   * stored in subscriptions.payment_provider_id (the only provider-ref
   * column the table has).
   */
  activateSubscription(userId, { plan, paymentMethod, paymentTx, durationDays }) {
    if (!plans.getPlan(plan)) {
      throw new Error(`Unknown plan: ${plan}`);
    }
    plan = plans.normalizePlan(plan);
    if (plan === 'free') {
      throw new Error('Cannot activate the free plan; it is the default');
    }

    const duration = durationDays || plans.PLANS[plan].periodDays;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + duration);

    const existing = db
      .prepare('SELECT id FROM subscriptions WHERE user_id = ?')
      .get(userId);

    if (existing) {
      db.prepare(
        `UPDATE subscriptions
         SET plan = ?, status = 'active', expires_at = ?, payment_method = ?, payment_provider_id = ?,
             auto_renew = 0, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ?`
      ).run(plan, expiresAt.toISOString(), paymentMethod || null, paymentTx || null, userId);
    } else {
      db.prepare(
        `INSERT INTO subscriptions (user_id, plan, status, expires_at, payment_method, payment_provider_id)
         VALUES (?, ?, 'active', ?, ?, ?)`
      ).run(userId, plan, expiresAt.toISOString(), paymentMethod || null, paymentTx || null);
    }

    // Mirror into trader_settings (planService owns sub_plan / sub_status /
    // sub_expires, M7). Lazy require avoids a circular import.
    try {
      require('./planService').sync(userId).catch(() => {});
    } catch (_e) { /* best-effort */ }

    return this.getUserSubscription(userId);
  }

  /**
   * Apply a promo code to the user's account.
   */
  applyPromoCode(userId, code) {
    const promo = db
      .prepare('SELECT * FROM promo_codes WHERE code = ? AND is_active = 1')
      .get(code);

    if (!promo) {
      throw new Error('Invalid or expired promo code');
    }

    // Check expiry
    if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
      throw new Error('This promo code has expired');
    }

    // Check usage limit
    if (promo.max_uses > 0 && promo.uses_count >= promo.max_uses) {
      throw new Error('This promo code has reached its usage limit');
    }

    // Check if user already redeemed
    const alreadyUsed = db
      .prepare('SELECT id FROM promo_redemptions WHERE user_id = ? AND promo_id = ?')
      .get(userId, promo.id);

    if (alreadyUsed) {
      throw new Error('You have already used this promo code');
    }

    // Apply in a transaction. Re-read uses_count and guard inside the txn so
    // parallel redemptions can't both pass the pre-check and push the counter
    // above max_uses. The UPDATE also uses a WHERE clause with the expected
    // count to turn it into a CAS operation.
    const apply = db.transaction(() => {
      const fresh = db.prepare('SELECT uses_count, max_uses FROM promo_codes WHERE id = ?')
        .get(promo.id);
      if (fresh.max_uses > 0 && fresh.uses_count >= fresh.max_uses) {
        const err = new Error('This promo code has reached its usage limit');
        err.statusCode = 409; err.code = 'PROMO_EXHAUSTED';
        throw err;
      }
      const upd = db.prepare(
        'UPDATE promo_codes SET uses_count = uses_count + 1 WHERE id = ? AND uses_count = ?'
      ).run(promo.id, fresh.uses_count);
      if (upd.changes !== 1) {
        const err = new Error('Promo code contention, please retry');
        err.statusCode = 409; err.code = 'PROMO_CAS_FAILED';
        throw err;
      }

      db.prepare(
        'INSERT INTO promo_redemptions (user_id, promo_id) VALUES (?, ?)'
      ).run(userId, promo.id);

      return this.activateSubscription(userId, {
        plan: promo.plan,
        paymentMethod: 'promo',
        paymentTx: `PROMO:${code}`,
        durationDays: promo.duration_days,
      });
    });

    return apply();
  }

  // ── Limit helpers ────────────────────────────────────────────────────

  /**
   * Return the plan (limits + feature matrix) for a given user.
   */
  getUserLimits(userId) {
    const sub = this.getUserSubscription(userId);
    return sub.planDetails;
  }

  /**
   * Bot `plan_limit(feature)` for a user — numeric limits such as
   * 'signals_per_day' / 'analyze_per_day'. The per-day counters themselves
   * (free_signals_*, analyze_count_<uid>_<day>) arrive with the engine
   * (M9/M10); this only answers "what is the cap".
   */
  planLimit(userId, feature) {
    const sub = this.getUserSubscription(userId);
    const admin = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId);
    return planFeatures.planLimit(sub.planId, feature, { admin: Boolean(admin && admin.is_admin) });
  }
}

module.exports = new SubscriptionService();
