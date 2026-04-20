const db = require('../models/database');

/**
 * Plan definitions with feature limits and pricing.
 */
const PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    price: 0,
    interval: null,
    features: {
      signalsPerDay: 3,
      maxBots: 1,
      autoTrade: false,
      strategies: ['scalping'],
      backtesting: false,
      prioritySignals: false,
      apiAccess: false,
    },
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    price: 29,
    interval: 'month',
    features: {
      signalsPerDay: -1, // unlimited
      maxBots: 3,
      autoTrade: false,
      strategies: ['scalping', 'smc'],
      backtesting: false,
      prioritySignals: false,
      apiAccess: false,
    },
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    price: 79,
    interval: 'month',
    features: {
      signalsPerDay: -1,
      maxBots: 10,
      autoTrade: true,
      strategies: ['scalping', 'smc', 'gerchik'],
      backtesting: true,
      prioritySignals: false,
      apiAccess: false,
    },
  },
  elite: {
    id: 'elite',
    name: 'Elite',
    price: 149,
    interval: 'month',
    features: {
      signalsPerDay: -1,
      maxBots: -1, // unlimited
      autoTrade: true,
      strategies: ['scalping', 'smc', 'gerchik'],
      backtesting: true,
      prioritySignals: true,
      apiAccess: true,
    },
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    price: null, // custom pricing
    interval: 'month',
    features: {
      signalsPerDay: -1,
      maxBots: -1,
      autoTrade: true,
      strategies: ['scalping', 'smc', 'gerchik'],
      backtesting: true,
      prioritySignals: true,
      apiAccess: true,
    },
  },
};

class SubscriptionService {
  /**
   * Return the static plan catalogue (public, no auth needed).
   */
  getPlans() {
    return Object.values(PLANS).map((p) => ({
      id: p.id,
      name: p.name,
      price: p.price,
      interval: p.interval,
      features: p.features,
    }));
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

    const planDef = PLANS[sub.plan] || PLANS.free;

    return {
      ...sub,
      planDetails: planDef,
    };
  }

  /**
   * Activate (or upgrade) a subscription.
   *
   * In production this would verify a Stripe / crypto payment.
   * For now we accept a payment_tx string and trust the caller.
   */
  activateSubscription(userId, { plan, paymentMethod, paymentTx, durationDays }) {
    if (!PLANS[plan]) {
      throw new Error(`Unknown plan: ${plan}`);
    }
    if (plan === 'free') {
      throw new Error('Cannot activate the free plan; it is the default');
    }

    const duration = durationDays || 30;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + duration);

    const existing = db
      .prepare('SELECT id FROM subscriptions WHERE user_id = ?')
      .get(userId);

    if (existing) {
      db.prepare(
        `UPDATE subscriptions
         SET plan = ?, status = 'active', expires_at = ?, payment_method = ?, payment_tx = ?,
             auto_renew = 0, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ?`
      ).run(plan, expiresAt.toISOString(), paymentMethod || null, paymentTx || null, userId);
    } else {
      db.prepare(
        `INSERT INTO subscriptions (user_id, plan, status, expires_at, payment_method, payment_tx)
         VALUES (?, ?, 'active', ?, ?, ?)`
      ).run(userId, plan, expiresAt.toISOString(), paymentMethod || null, paymentTx || null);
    }

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
   * Return the feature limits for a given user.
   */
  getUserLimits(userId) {
    const sub = this.getUserSubscription(userId);
    return sub.planDetails.features;
  }

  /**
   * Check whether the user can create another bot.
   */
  canCreateBot(userId) {
    const limits = this.getUserLimits(userId);
    if (limits.maxBots === -1) return true;

    const count = db
      .prepare('SELECT COUNT(*) as cnt FROM trading_bots WHERE user_id = ?')
      .get(userId).cnt;

    return count < limits.maxBots;
  }

  /**
   * Check whether the user can view another signal today (free-tier gate).
   */
  canViewSignal(userId) {
    const limits = this.getUserLimits(userId);
    if (limits.signalsPerDay === -1) return true;

    const today = new Date().toISOString().slice(0, 10);
    const count = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM user_signal_usage
         WHERE user_id = ? AND DATE(viewed_at) = ?`
      )
      .get(userId, today).cnt;

    return count < limits.signalsPerDay;
  }

  /**
   * Record that a user viewed a signal (for free-tier rate limiting).
   */
  recordSignalView(userId, signalId) {
    db.prepare(
      'INSERT INTO user_signal_usage (user_id, signal_id) VALUES (?, ?)'
    ).run(userId, signalId);
  }
}

module.exports = new SubscriptionService();
