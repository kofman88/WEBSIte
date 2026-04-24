/**
 * Payment service — creates + confirms payments, activates subscriptions.
 *
 *   Stripe Checkout:
 *     createStripeCheckout(userId, plan, billingCycle) → {url, sessionId}
 *     handleStripeWebhook(rawBody, signature)           → processes events
 *
 *   Crypto (BEP20 / TRC20):
 *     createCryptoPayment(userId, plan, network) → {address, amountUsdt, paymentId}
 *     confirmCryptoPayment(paymentId, {txHash, amountUsdt, fromAddress})
 *
 *   Common:
 *     confirmPayment(paymentId) → activates/extends subscription + issues ref-reward
 *     getUserPayments(userId)
 *
 * Stripe is loaded lazily — if STRIPE_SECRET_KEY is unset the service still
 * works for crypto-only; Stripe endpoints return 503 instead of throwing.
 */

const db = require('../models/database');
const config = require('../config');
const logger = require('../utils/logger');
const plans = require('../config/plans');
const refRewards = require('./refRewards');

// Lazy Stripe instance
let _stripe = null;
function stripe() {
  if (_stripe) return _stripe;
  if (!config.stripeSecretKey) return null;
  try {
    const Stripe = require('stripe');
    _stripe = Stripe(config.stripeSecretKey, { apiVersion: '2024-06-20' });
    return _stripe;
  } catch (err) {
    logger.error('stripe init failed', { err: err.message });
    return null;
  }
}

// ── Common: Plan pricing ───────────────────────────────────────────────
const BILLING_DAYS = { monthly: 30, yearly: 365 };

function planPrice(planId, billingCycle = 'monthly') {
  const p = plans.getPlan(planId);
  if (!p || p.priceUsd === 0) throw new Error('Unpaid plan: ' + planId);
  const monthly = p.priceUsd;
  if (billingCycle === 'yearly') return monthly * 12 * 0.8; // 20% yearly discount
  return monthly;
}

// ── Stripe Checkout ────────────────────────────────────────────────────
async function createStripeCheckout(userId, { plan, billingCycle = 'monthly', successUrl, cancelUrl }) {
  const s = stripe();
  if (!s) {
    const err = new Error('Stripe not configured');
    err.statusCode = 503; err.code = 'STRIPE_DISABLED';
    throw err;
  }
  const price = planPrice(plan, billingCycle);
  const user = db.prepare('SELECT email FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('User not found');

  const origin = successUrl ? new URL(successUrl).origin : '';
  // Idempotency key: same user + plan + cycle in a single minute will not
  // create duplicate Stripe sessions if the network retries our create call.
  const idemKey = 'chk_' + userId + '_' + plan + '_' + billingCycle + '_' + Math.floor(Date.now() / 60000);
  const session = await s.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    customer_email: user.email,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: Math.round(price * 100),
        recurring: { interval: billingCycle === 'yearly' ? 'year' : 'month' },
        product_data: {
          name: 'CHM Finance ' + plan[0].toUpperCase() + plan.slice(1) + ' Plan',
          description: billingCycle === 'yearly' ? 'Billed annually (20% off)' : 'Billed monthly',
        },
      },
    }],
    success_url: successUrl || (origin + '/dashboard.html?paid=1'),
    cancel_url: cancelUrl || (origin + '/?checkout=cancel'),
    metadata: { userId: String(userId), plan, billingCycle },
  }, { idempotencyKey: idemKey });

  // Record pending payment
  const info = db.prepare(`
    INSERT INTO payments (user_id, amount_usd, currency, method, provider_tx_id, plan, duration_days, status, metadata)
    VALUES (?, ?, 'USD', 'stripe', ?, ?, ?, 'pending', ?)
  `).run(userId, price, session.id, plan, BILLING_DAYS[billingCycle] || 30,
    JSON.stringify({ billingCycle, checkoutUrl: session.url }));

  db.prepare(`
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
    VALUES (?, 'payment.stripe.create', 'payment', ?, ?)
  `).run(userId, info.lastInsertRowid, JSON.stringify({ plan, billingCycle, sessionId: session.id }));

  return { url: session.url, sessionId: session.id, paymentId: info.lastInsertRowid };
}

async function handleStripeWebhook(rawBody, signature) {
  const s = stripe();
  if (!s) { const err = new Error('Stripe not configured'); err.statusCode = 503; throw err; }

  // Webhook MUST be signature-verified in prod. Unsigned passthrough is only
  // allowed in dev/test when an operator is explicitly replaying captured
  // events. In prod a missing secret is a 503 — better than accepting forged
  // checkout.session.completed events from an attacker.
  let event;
  if (!config.stripeWebhookSecret) {
    if (config.isProd) {
      const e = new Error('Stripe webhook secret not configured'); e.statusCode = 503; e.code = 'WEBHOOK_SECRET_MISSING';
      logger.error('stripe webhook rejected: STRIPE_WEBHOOK_SECRET not set in prod');
      throw e;
    }
    logger.warn('stripe webhook: running without signature verification (dev/test only)');
    event = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
  } else {
    try {
      event = s.webhooks.constructEvent(rawBody, signature, config.stripeWebhookSecret);
    } catch (err) {
      const e = new Error('Webhook signature failed'); e.statusCode = 400; e.code = 'BAD_SIGNATURE'; throw e;
    }
  }

  logger.info('stripe webhook', { type: event.type, id: event.id });

  // Idempotency: Stripe retries on transient failures — record event.id
  // and bail out on duplicates. INSERT OR IGNORE keeps this race-safe.
  if (event.id) {
    const ins = db.prepare('INSERT OR IGNORE INTO stripe_webhooks (event_id, event_type) VALUES (?, ?)')
      .run(event.id, event.type);
    if (ins.changes === 0) {
      logger.info('stripe webhook duplicate ignored', { id: event.id });
      return { received: true, duplicate: true };
    }
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const sess = event.data.object;
      const payment = db.prepare(`
        SELECT * FROM payments WHERE provider_tx_id = ?
      `).get(sess.id);
      if (payment && payment.status === 'pending') {
        confirmPayment(payment.id, { metadata: { stripeSessionId: sess.id } });
      }
      break;
    }
    case 'invoice.paid': {
      const inv = event.data.object;
      // Recurring renewal — extend subscription by 30 days for that user
      const userId = Number(inv.metadata && inv.metadata.userId) || null;
      if (userId) {
        const info = db.prepare(`
          INSERT INTO payments (user_id, amount_usd, currency, method, provider_tx_id, plan, duration_days, status, confirmed_at, metadata)
          VALUES (?, ?, 'USD', 'stripe', ?, ?, 30, 'confirmed', CURRENT_TIMESTAMP, ?)
        `).run(userId, (inv.amount_paid / 100), inv.id,
          (inv.metadata && inv.metadata.plan) || 'pro',
          JSON.stringify({ recurring: true }));
        extendSubscription(userId, (inv.metadata && inv.metadata.plan) || 'pro', 30);
        refRewards.issueReward(info.lastInsertRowid);
        refRewards.issueSignupBonus(info.lastInsertRowid);
      }
      break;
    }
    case 'invoice.payment_failed': {
      const inv = event.data.object;
      const userId = Number(inv.metadata && inv.metadata.userId);
      if (userId) {
        db.prepare(`UPDATE subscriptions SET status='past_due', updated_at=CURRENT_TIMESTAMP WHERE user_id = ?`)
          .run(userId);

        // Dunning email — Stripe retries the charge automatically (default
        // 3-4 attempts over 2 weeks, configurable in Stripe dashboard). We
        // email the user immediately on each failed attempt with a direct
        // link to update their card via the Billing Portal. Without this,
        // users silently churn — 5% of MRR typically lost to failed cards.
        try {
          const emailService = require('./emailService');
          const user = db.prepare('SELECT email, display_name FROM users WHERE id = ?').get(userId);
          if (user && user.email) {
            let portalUrl = null;
            try {
              const portal = await createBillingPortalSession(userId, { returnUrl: (config.appUrl || 'https://chmup.top') + '/settings.html#billing' });
              portalUrl = portal.url;
            } catch (_e) { /* fall back to settings page */ }
            const tpl = require('./emailTemplates').paymentFailed({
              displayName: user.display_name,
              plan: (inv.metadata && inv.metadata.plan) || 'pro',
              amountUsd: (inv.amount_due || inv.amount_paid || 0) / 100,
              billingPortalUrl: portalUrl,
              attemptCount: inv.attempt_count || 1,
              nextAttemptAt: inv.next_payment_attempt ? new Date(inv.next_payment_attempt * 1000).toISOString() : null,
            });
            emailService.sendDurable({ to: user.email, subject: tpl.subject, html: tpl.html, text: tpl.text });
          }
        } catch (err) { logger.warn('dunning email failed', { userId, err: err.message }); }

        // In-app notification mirrors the email so users see it on next login
        try {
          const notifier = require('./notifier');
          notifier.dispatch(userId, {
            type: 'payment',
            title: 'Платёж не прошёл',
            body: 'Обновите карту до следующей попытки списания — иначе подписка будет отменена.',
            link: '/settings.html#billing',
          });
        } catch (_e) {}
      }
      break;
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const userId = Number(sub.metadata && sub.metadata.userId);
      if (userId) {
        db.prepare(`UPDATE subscriptions SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE user_id = ?`)
          .run(userId);
      }
      break;
    }
    default:
      // Ignore unrelated event types
  }
  return { received: true };
}

// ── Crypto (BEP20 / TRC20) ─────────────────────────────────────────────

const PENDING_TOLERANCE_SEC = 3600; // pending crypto valid for 1h

function _uniqueAmount(base) {
  // Generate unique amount: base + random cents (0.01 - 0.99) for identification
  const suffix = (Math.floor(Math.random() * 99) + 1) / 100;
  return Number((base + suffix).toFixed(2));
}

function createCryptoPayment(userId, { plan, network, billingCycle = 'monthly' }) {
  if (!['bep20', 'trc20'].includes(network)) {
    const err = new Error('Invalid network'); err.statusCode = 400; throw err;
  }
  const address = network === 'bep20' ? config.paymentBep20Address : config.paymentTrc20Address;
  if (!address) {
    const err = new Error('Crypto payments temporarily unavailable');
    err.statusCode = 503; err.code = 'CRYPTO_DISABLED'; throw err;
  }
  const basePrice = planPrice(plan, billingCycle);
  const amountUsdt = _uniqueAmount(basePrice);

  const info = db.prepare(`
    INSERT INTO payments (user_id, amount_usd, currency, method, plan, duration_days, status, metadata)
    VALUES (?, ?, 'USDT', ?, ?, ?, 'pending', ?)
  `).run(userId, amountUsdt, 'usdt_' + network, plan, BILLING_DAYS[billingCycle] || 30,
    JSON.stringify({ network, address, billingCycle }));

  db.prepare(`
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
    VALUES (?, 'payment.crypto.create', 'payment', ?, ?)
  `).run(userId, info.lastInsertRowid, JSON.stringify({ network, plan, amount: amountUsdt }));

  return {
    paymentId: info.lastInsertRowid,
    network, address, amountUsdt,
    expiresAt: new Date(Date.now() + PENDING_TOLERANCE_SEC * 1000).toISOString(),
    plan, billingCycle,
  };
}

function confirmCryptoPayment(paymentId, { txHash, fromAddress, amountUsdt }) {
  const payment = db.prepare('SELECT * FROM payments WHERE id = ? AND status = ?').get(paymentId, 'pending');
  if (!payment) { const err = new Error('Payment not found or already processed'); err.statusCode = 404; throw err; }
  // Accept ±1% tolerance (network fee absorption on underside, rounding
  // on overside). Outside that window — reject with a specific code so
  // the frontend can route the user to support for manual handling.
  if (typeof amountUsdt === 'number' && Number.isFinite(amountUsdt)) {
    const invoiced = Number(payment.amount_usd);
    const pct = (amountUsdt - invoiced) / invoiced;
    if (pct < -0.01) {
      const err = new Error('Amount mismatch (underpaid): expected ' + invoiced + ' USDT, got ' + amountUsdt);
      err.statusCode = 400; err.code = 'UNDERPAID'; throw err;
    }
    if (pct > 0.01) {
      const err = new Error('Amount mismatch (overpaid): expected ' + invoiced + ' USDT, got ' + amountUsdt + ' — contact support for credit/refund');
      err.statusCode = 400; err.code = 'OVERPAID'; throw err;
    }
  }
  // Attach tx metadata but LEAVE status='pending' so confirmPayment can transition it.
  const existingMeta = (() => { try { return JSON.parse(payment.metadata || '{}'); } catch { return {}; } })();
  const newMeta = { ...existingMeta, fromAddress: fromAddress || null, detectedAmount: amountUsdt || null };
  db.prepare(`UPDATE payments SET provider_tx_id = ?, metadata = ? WHERE id = ?`)
    .run(txHash || null, JSON.stringify(newMeta), paymentId);

  confirmPayment(paymentId);
  return { confirmed: true };
}

// ── Core: activate subscription + issue ref reward ─────────────────────
function confirmPayment(paymentId, { metadata = null } = {}) {
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!payment) throw new Error('Payment not found');
  if (payment.status === 'confirmed') return payment; // idempotent

  db.prepare(`
    UPDATE payments SET status='confirmed', confirmed_at=CURRENT_TIMESTAMP
    WHERE id = ? AND status != 'confirmed'
  `).run(paymentId);

  extendSubscription(payment.user_id, payment.plan, payment.duration_days || 30);

  // Issue ref reward (silently ignores if no referrer)
  try { refRewards.issueReward(paymentId); }
  catch (err) { logger.warn('ref_reward failed', { paymentId, err: err.message }); }
  // Plus one-shot signup bonus on the FIRST confirmed payment
  try { refRewards.issueSignupBonus(paymentId); }
  catch (err) { logger.warn('ref_signup_bonus failed', { paymentId, err: err.message }); }

  db.prepare(`
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
    VALUES (?, 'payment.confirmed', 'payment', ?, ?)
  `).run(payment.user_id, paymentId,
    JSON.stringify({ plan: payment.plan, amount: payment.amount_usd, method: payment.method }));

  // Notify any connected websocket of this user — best-effort, lazy-required
  // to avoid a circular dep with websocketService (which doesn't import us).
  try {
    const ws = require('./websocketService');
    if (ws && ws.broadcastToUser) {
      ws.broadcastToUser(payment.user_id, {
        type: 'payment_confirmed',
        data: { paymentId, plan: payment.plan, method: payment.method },
        ts: Date.now(),
      });
      try {
        const notifier = require('./notifier');
        notifier.dispatch(payment.user_id, {
          type: 'payment',
          title: 'Оплата получена',
          body: 'Тариф ' + payment.plan.toUpperCase() + ' активирован · ' + payment.method,
          link: '/settings.html',
        });
      } catch (_e) {}
    }
  } catch (_e) { /* ignore */ }

  // Email receipt — durable outbox so a transient SMTP blip doesn't
  // lose it. B2B users expect a chargeable receipt for bookkeeping.
  try {
    const emailService = require('./emailService');
    const user = db.prepare('SELECT email, display_name FROM users WHERE id = ?').get(payment.user_id);
    const sub = db.prepare('SELECT expires_at FROM subscriptions WHERE user_id = ?').get(payment.user_id);
    if (user && user.email) {
      const tpl = require('./emailTemplates').paymentConfirmed({
        displayName: user.display_name,
        plan: payment.plan,
        amountUsd: Number(payment.amount_usd) || 0,
        expiresAt: sub ? sub.expires_at : null,
      });
      emailService.sendDurable({ to: user.email, subject: tpl.subject, html: tpl.html, text: tpl.text });
    }
  } catch (err) { logger.warn('receipt email failed', { paymentId, err: err.message }); }

  return db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
}

function extendSubscription(userId, plan, days) {
  const existing = db.prepare('SELECT * FROM subscriptions WHERE user_id = ?').get(userId);
  const now = Date.now();
  const baseMs = existing && existing.expires_at && new Date(existing.expires_at).getTime() > now
    ? new Date(existing.expires_at).getTime()
    : now;
  const newExpires = new Date(baseMs + days * 86_400_000).toISOString();

  if (existing) {
    db.prepare(`
      UPDATE subscriptions SET plan=?, status='active', expires_at=?, auto_renew=1, updated_at=CURRENT_TIMESTAMP
      WHERE user_id = ?
    `).run(plan, newExpires, userId);
  } else {
    db.prepare(`
      INSERT INTO subscriptions (user_id, plan, status, expires_at, auto_renew)
      VALUES (?, ?, 'active', ?, 1)
    `).run(userId, plan, newExpires);
  }
  logger.info('subscription extended', { userId, plan, until: newExpires });

  // Downgrade safety: if the new plan has a lower maxBots than currently
  // active, deactivate the oldest-created excess bots. Otherwise a user who
  // went Pro→Free after a refund would keep trading with 5 active bots.
  try {
    const plans = require('../config/plans');
    const limits = plans.getLimits(plan);
    if (limits && limits.maxBots !== Infinity && limits.maxBots >= 0) {
      const excess = db.prepare(`
        SELECT id FROM trading_bots
        WHERE user_id = ? AND is_active = 1
        ORDER BY created_at DESC
        LIMIT -1 OFFSET ?
      `).all(userId, limits.maxBots);
      if (excess.length) {
        const stmt = db.prepare('UPDATE trading_bots SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
        for (const b of excess) stmt.run(b.id);
        logger.warn('deactivated excess bots on plan change', { userId, plan, count: excess.length });
      }
    }
  } catch (e) { logger.error('downgrade cleanup failed', { userId, err: e.message }); }
}

function getUserPayments(userId, { limit = 50, offset = 0 } = {}) {
  return db.prepare(`
    SELECT * FROM payments WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(userId, limit, offset).map(hydrate);
}

function hydrate(p) {
  return {
    id: p.id,
    userId: p.user_id,
    amountUsd: Number(p.amount_usd),
    currency: p.currency,
    method: p.method,
    providerTxId: p.provider_tx_id,
    plan: p.plan,
    durationDays: p.duration_days,
    status: p.status,
    metadata: (() => { try { return JSON.parse(p.metadata || '{}'); } catch { return {}; } })(),
    createdAt: p.created_at,
    confirmedAt: p.confirmed_at,
  };
}

// ── Stripe Billing Portal ──────────────────────────────────────────────
// Self-serve subscription management: change card, download invoices,
// cancel subscription. Redirects to Stripe's hosted portal — big-SaaS
// standard (Slack/Figma/GitHub all use this). We look up the Stripe
// customer id from the most recent confirmed subscription payment.
async function createBillingPortalSession(userId, { returnUrl } = {}) {
  const s = stripe();
  if (!s) { const e = new Error('Stripe not configured'); e.statusCode = 503; e.code = 'STRIPE_DISABLED'; throw e; }

  // Find the Stripe customer id from the latest confirmed Stripe payment.
  // `metadata` on a confirmed payment contains the checkout session id;
  // we retrieve that session to get the customer. Cached per-user would be
  // cleaner but this lookup happens rarely (only when user clicks "Manage billing").
  const row = db.prepare(`
    SELECT provider_tx_id FROM payments
    WHERE user_id = ? AND method = 'stripe' AND status = 'confirmed'
    ORDER BY confirmed_at DESC LIMIT 1
  `).get(userId);
  if (!row) { const e = new Error('No Stripe payments found'); e.statusCode = 404; e.code = 'NO_STRIPE_CUSTOMER'; throw e; }

  let customerId;
  try {
    const session = await s.checkout.sessions.retrieve(row.provider_tx_id);
    customerId = session.customer;
  } catch (err) {
    logger.warn('billing portal: could not resolve customer from session', { userId, err: err.message });
    const e = new Error('Could not resolve Stripe customer'); e.statusCode = 404; e.code = 'NO_STRIPE_CUSTOMER'; throw e;
  }
  if (!customerId) { const e = new Error('No Stripe customer'); e.statusCode = 404; e.code = 'NO_STRIPE_CUSTOMER'; throw e; }

  const portal = await s.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl || (config.appUrl || 'https://chmup.top') + '/settings.html',
  });
  return { url: portal.url };
}

// ── Self-serve cancellation ────────────────────────────────────────────
// `atPeriodEnd: true` (default) = keep access until paid-through date,
// then auto-downgrade to free. Stripe stops charging on the next cycle.
// `atPeriodEnd: false` = cancel immediately; paid days are not refunded
// automatically (user can request refund via support if within 14 days).
async function cancelSubscription(userId, { atPeriodEnd = true } = {}) {
  const sub = db.prepare('SELECT * FROM subscriptions WHERE user_id = ?').get(userId);
  if (!sub || sub.plan === 'free') {
    const e = new Error('No active subscription to cancel'); e.statusCode = 400; e.code = 'NO_SUBSCRIPTION'; throw e;
  }

  // If Stripe-managed, cancel at the Stripe level too. We look up the
  // Stripe subscription via the most recent confirmed payment's session.
  const s = stripe();
  const row = db.prepare(`
    SELECT provider_tx_id FROM payments
    WHERE user_id = ? AND method = 'stripe' AND status = 'confirmed'
    ORDER BY confirmed_at DESC LIMIT 1
  `).get(userId);
  if (s && row) {
    try {
      const session = await s.checkout.sessions.retrieve(row.provider_tx_id);
      if (session.subscription) {
        if (atPeriodEnd) {
          await s.subscriptions.update(session.subscription, { cancel_at_period_end: true });
        } else {
          await s.subscriptions.cancel(session.subscription);
        }
      }
    } catch (err) {
      // Non-fatal: local state still reflects the cancel; Stripe may already be cancelled
      logger.warn('stripe cancel did not apply', { userId, err: err.message });
    }
  }

  // Local state
  if (atPeriodEnd) {
    db.prepare(`UPDATE subscriptions SET auto_renew = 0, status = 'cancelling', updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`).run(userId);
  } else {
    db.prepare(`UPDATE subscriptions SET plan = 'free', status = 'cancelled', auto_renew = 0, expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`).run(userId);
    // Downgrade cleanup — same cascade as in extendSubscription
    try {
      const plans = require('../config/plans');
      const limits = plans.getLimits('free');
      const excess = db.prepare(`SELECT id FROM trading_bots WHERE user_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT -1 OFFSET ?`).all(userId, limits.maxBots);
      const stmt = db.prepare('UPDATE trading_bots SET is_active = 0 WHERE id = ?');
      for (const b of excess) stmt.run(b.id);
    } catch (_e) {}
  }

  db.prepare(`
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
    VALUES (?, 'subscription.cancel', 'subscription', ?, ?)
  `).run(userId, sub.id || null, JSON.stringify({ atPeriodEnd }));

  // Confirmation email — durable outbox so it's not lost to SMTP hiccup.
  try {
    const emailService = require('./emailService');
    const user = db.prepare('SELECT email, display_name FROM users WHERE id = ?').get(userId);
    if (user && user.email) {
      const tpl = require('./emailTemplates').subscriptionCancelled({
        displayName: user.display_name, plan: sub.plan, expiresAt: sub.expires_at, atPeriodEnd,
      });
      emailService.sendDurable({ to: user.email, subject: tpl.subject, html: tpl.html, text: tpl.text });
    }
  } catch (err) { logger.warn('cancel email failed', { userId, err: err.message }); }

  return { cancelled: true, atPeriodEnd, accessUntil: atPeriodEnd ? sub.expires_at : null };
}

module.exports = {
  createStripeCheckout,
  createBillingPortalSession,
  cancelSubscription,
  handleStripeWebhook,
  createCryptoPayment,
  confirmCryptoPayment,
  confirmPayment,
  extendSubscription,
  getUserPayments,
  planPrice,
  _stripe: stripe,
};
