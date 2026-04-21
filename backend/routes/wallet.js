const express = require('express');
const { z } = require('zod');
const { authMiddleware, requireVerifiedEmail } = require('../middleware/auth');
const walletService = require('../services/walletService');
const logger = require('../utils/logger');

const router = express.Router();

// Broad crypto address shape — covers ETH/EVM, BTC legacy + bech32, TRX, LTC,
// BCH, SOL-ish, USDT on those chains. Not a per-chain verifier (would need
// checksums / bech32 decode), but keeps obvious garbage + injection out.
const ADDRESS_REGEX = /^(0x[a-fA-F0-9]{40}|bc1[a-z0-9]{25,59}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|T[1-9A-HJ-NP-Za-km-z]{33}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;

const withdrawSchema = z.object({
  amount: z.number().positive().max(10_000_000),
  destinationAddress: z.string().trim().min(20).max(128).regex(ADDRESS_REGEX, 'Invalid crypto address format'),
});

function handleErr(err, res, next) {
  if (err instanceof z.ZodError) {
    return res.status(400).json({ error: 'Validation failed', issues: err.issues });
  }
  if (err && err.statusCode) return res.status(err.statusCode).json({ error: err.message });
  logger.error('wallet route error', { err: err && err.message, stack: err && err.stack });
  return next(err);
}

router.post('/create', authMiddleware, (req, res, next) => {
  try {
    const wallet = walletService.createWallet(req.userId);
    res.status(201).json({ message: 'Wallet created successfully', wallet });
  } catch (err) {
    if (err.message && err.message.includes('already exists')) {
      return res.status(409).json({ error: err.message });
    }
    handleErr(err, res, next);
  }
});

router.get('/', authMiddleware, (req, res, next) => {
  try {
    const wallet = walletService.getWallet(req.userId);
    if (!wallet) {
      return res.status(404).json({
        error: 'No wallet found. Create one first via POST /api/wallet/create',
      });
    }
    res.json({ wallet });
  } catch (err) { handleErr(err, res, next); }
});

router.get('/balance', authMiddleware, (req, res, next) => {
  try {
    const balance = walletService.getBalance(req.userId);
    res.json({ balance });
  } catch (err) {
    if (err.message && err.message.includes('No wallet found')) {
      return res.status(404).json({ error: err.message });
    }
    handleErr(err, res, next);
  }
});

router.post('/withdraw', authMiddleware, requireVerifiedEmail, (req, res, next) => {
  try {
    const input = withdrawSchema.parse(req.body);
    const transaction = walletService.requestWithdrawal(req.userId, input);
    res.status(201).json({ message: 'Withdrawal request submitted', transaction });
  } catch (err) {
    if (err.message && (err.message.includes('Insufficient') || err.message.includes('No wallet'))) {
      return res.status(400).json({ error: err.message });
    }
    handleErr(err, res, next);
  }
});

router.post('/withdraw/:id/cancel', authMiddleware, (req, res, next) => {
  try {
    const transactionId = z.coerce.number().int().positive().parse(req.params.id);
    const transaction = walletService.cancelWithdrawal(req.userId, transactionId);
    res.json({ message: 'Withdrawal cancelled', transaction });
  } catch (err) {
    if (err.message && !err.statusCode) return res.status(400).json({ error: err.message });
    handleErr(err, res, next);
  }
});

router.get('/transactions', authMiddleware, (req, res, next) => {
  try {
    const result = walletService.getTransactions(req.userId, {
      page: req.query.page,
      limit: req.query.limit,
      type: req.query.type,
      status: req.query.status,
    });
    res.json(result);
  } catch (err) { handleErr(err, res, next); }
});

module.exports = router;
