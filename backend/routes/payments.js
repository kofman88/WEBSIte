const express = require('express');
const { z } = require('zod');
const { authMiddleware, requireVerifiedEmail } = require('../middleware/auth');
const paymentService = require('../services/paymentService');
const refRewards = require('../services/refRewards');
const validation = require('../utils/validation');
const handleErr = require('../middleware/handleErr');

const router = express.Router();

// POST /api/payments/stripe/checkout — create Stripe Checkout session
router.post('/stripe/checkout', authMiddleware, requireVerifiedEmail, async (req, res, next) => {
  try {
    const input = validation.stripeCheckoutSchema.parse(req.body);
    const origin = req.get('origin') || ('https://' + req.get('host'));
    const out = await paymentService.createStripeCheckout(req.userId, {
      plan: input.plan,
      billingCycle: input.billingCycle,
      successUrl: origin + '/dashboard.html?paid=1',
      cancelUrl: origin + '/?checkout=cancel',
    });
    res.json(out);
  } catch (err) { handleErr(err, res, next); }
});

// POST /api/payments/crypto/create — generate unique payment ticket
router.post('/crypto/create', authMiddleware, requireVerifiedEmail, (req, res, next) => {
  try {
    const input = validation.cryptoPaymentSchema.parse(req.body);
    const out = paymentService.createCryptoPayment(req.userId, input);
    res.json(out);
  } catch (err) { handleErr(err, res, next); }
});

// POST /api/payments/stripe/portal — self-serve billing portal
// Returns a short-lived URL to Stripe's hosted billing portal where the
// user can update their card, download invoices, and cancel their
// subscription. This is the big-SaaS standard — Slack, Figma, GitHub all
// use this flow rather than building custom billing UIs.
router.post('/stripe/portal', authMiddleware, async (req, res, next) => {
  try {
    const body = z.object({ returnUrl: z.string().url().optional() }).parse(req.body || {});
    const origin = req.get('origin') || ('https://' + req.get('host'));
    const out = await paymentService.createBillingPortalSession(req.userId, {
      returnUrl: body.returnUrl || (origin + '/settings.html#billing'),
    });
    res.json(out);
  } catch (err) { handleErr(err, res, next); }
});

// POST /api/webhooks/stripe — Stripe sends events here
// Requires raw body for signature verification (handled in server.js middleware)
router.post('/webhooks/stripe', async (req, res, next) => {
  try {
    const sig = req.headers['stripe-signature'] || '';
    const rawBody = req.rawBody || (Buffer.isBuffer(req.body) ? req.body : JSON.stringify(req.body));
    const out = await paymentService.handleStripeWebhook(rawBody, sig);
    res.json(out);
  } catch (err) { handleErr(err, res, next); }
});

// GET /api/payments — user's payment history
router.get('/', authMiddleware, (req, res, next) => {
  try {
    const q = z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);
    res.json({ payments: paymentService.getUserPayments(req.userId, q) });
  } catch (err) { handleErr(err, res, next); }
});

// ── Referral rewards (user-facing view) ────────────────────────────────
router.get('/ref/summary', authMiddleware, (req, res, next) => {
  try {
    res.json(refRewards.summaryForUser(req.userId));
  } catch (err) { handleErr(err, res, next); }
});

router.get('/ref/rewards', authMiddleware, (req, res, next) => {
  try {
    const q = z.object({
      status: z.enum(['pending', 'paid', 'cancelled']).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);
    res.json({ rewards: refRewards.listForUser(req.userId, q) });
  } catch (err) { handleErr(err, res, next); }
});

module.exports = router;
