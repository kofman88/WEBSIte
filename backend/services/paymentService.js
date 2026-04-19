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
  });

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

  let event;
  try {
    if (config.stripeWebhookSecret) {
      event = s.webhooks.constructEvent(rawBody, signature, config.stripeWebhookSecret);
    } else {
      event = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
    }
  } catch (err) {
    const e = new Error('Webhook signature failed'); e.statusCode = 400; e.code = 'BAD_SIGNATURE'; throw e;
  }

  logger.info('stripe webhook', { type: event.type });

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
      }
      break;
    }
    case 'invoice.payment_failed': {
      const inv = event.data.object;
      const userId = Number(inv.metadata && inv.metadata.userId);
      if (userId) {
        db.prepare(`UPDATE subscriptions SET status='past_due', updated_at=CURRENT_TIMESTAMP WHERE user_id = ?`)
          .run(userId);
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
  if (amountUsdt && Math.abs(amountUsdt - Number(payment.amount_usd)) > 0.01) {
    const err = new Error('Amount mismatch'); err.statusCode = 400; throw err;
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
    }
  } catch (_e) { /* ignore */ }

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

module.exports = {
  createStripeCheckout,
  handleStripeWebhook,
  createCryptoPayment,
  confirmCryptoPayment,
  confirmPayment,
  extendSubscription,
  getUserPayments,
  planPrice,
  _stripe: stripe,
};
