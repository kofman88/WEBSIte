const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const paymentService = require('../services/paymentService');

const router = express.Router();

// GET /api/payments/methods — available payment methods
router.get('/methods', (_req, res) => {
  try {
    const methods = paymentService.getPaymentMethods();
    res.json({ methods });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/payments/create — create payment request
router.post('/create', authMiddleware, (req, res) => {
  try {
    const { plan, method } = req.body;
    if (!plan) return res.status(400).json({ error: 'Plan required (starter/pro/elite)' });
    const payment = paymentService.createPayment(req.userId, plan, method || 'ton');
    res.json(payment);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET /api/payments — user's payment history
router.get('/', authMiddleware, (req, res) => {
  try {
    const payments = paymentService.getUserPayments(req.userId);
    res.json({ payments });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET /api/payments/:id — check payment status
router.get('/:id', authMiddleware, (req, res) => {
  try {
    const payment = paymentService.getPayment(req.params.id);
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    if (payment.user_id !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    res.json(payment);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/payments/confirm — admin: confirm payment (manual)
router.post('/confirm', authMiddleware, (req, res) => {
  try {
    const { paymentId, txHash } = req.body;
    if (!paymentId) return res.status(400).json({ error: 'paymentId required' });
    const result = paymentService.confirmPayment(paymentId, txHash);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
