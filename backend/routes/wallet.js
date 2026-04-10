const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const walletService = require('../services/walletService');

const router = express.Router();

// ── Wallet management ────────────────────────────────────────────────────

/**
 * POST /api/wallet/create
 * Create a custodial wallet for the authenticated user.
 */
router.post('/create', authMiddleware, (req, res) => {
  try {
    const wallet = walletService.createWallet(req.userId);
    res.status(201).json({
      message: 'Wallet created successfully',
      wallet,
    });
  } catch (error) {
    console.error('Error creating wallet:', error.message);
    if (error.message.includes('already exists')) {
      return res.status(409).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to create wallet' });
  }
});

/**
 * GET /api/wallet
 * Get the authenticated user's wallet info.
 */
router.get('/', authMiddleware, (req, res) => {
  try {
    const wallet = walletService.getWallet(req.userId);
    if (!wallet) {
      return res.status(404).json({
        error: 'No wallet found. Create one first via POST /api/wallet/create',
      });
    }
    res.json({ wallet });
  } catch (error) {
    console.error('Error fetching wallet:', error.message);
    res.status(500).json({ error: 'Failed to fetch wallet' });
  }
});

/**
 * GET /api/wallet/balance
 * Get wallet balance with pending amounts.
 */
router.get('/balance', authMiddleware, (req, res) => {
  try {
    const balance = walletService.getBalance(req.userId);
    res.json({ balance });
  } catch (error) {
    console.error('Error fetching balance:', error.message);
    if (error.message.includes('No wallet found')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to fetch wallet balance' });
  }
});

// ── Transactions ─────────────────────────────────────────────────────────

/**
 * POST /api/wallet/withdraw
 * Request a withdrawal.
 * Body: { amount, destinationAddress }
 */
router.post('/withdraw', authMiddleware, (req, res) => {
  try {
    const { amount, destinationAddress } = req.body;

    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }
    if (!destinationAddress || typeof destinationAddress !== 'string') {
      return res.status(400).json({ error: 'destinationAddress is required' });
    }

    const transaction = walletService.requestWithdrawal(req.userId, {
      amount,
      destinationAddress,
    });

    res.status(201).json({
      message: 'Withdrawal request submitted',
      transaction,
    });
  } catch (error) {
    console.error('Error requesting withdrawal:', error.message);
    if (error.message.includes('Insufficient') || error.message.includes('No wallet')) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to process withdrawal' });
  }
});

/**
 * POST /api/wallet/withdraw/:id/cancel
 * Cancel a pending withdrawal.
 */
router.post('/withdraw/:id/cancel', authMiddleware, (req, res) => {
  try {
    const transactionId = parseInt(req.params.id, 10);
    if (isNaN(transactionId)) {
      return res.status(400).json({ error: 'Invalid transaction ID' });
    }

    const transaction = walletService.cancelWithdrawal(req.userId, transactionId);
    res.json({
      message: 'Withdrawal cancelled',
      transaction,
    });
  } catch (error) {
    console.error('Error cancelling withdrawal:', error.message);
    res.status(400).json({ error: error.message });
  }
});

/**
 * GET /api/wallet/transactions
 * Get transaction history.
 * Query params: page, limit, type, status
 */
router.get('/transactions', authMiddleware, (req, res) => {
  try {
    const result = walletService.getTransactions(req.userId, {
      page: req.query.page,
      limit: req.query.limit,
      type: req.query.type,
      status: req.query.status,
    });

    res.json(result);
  } catch (error) {
    console.error('Error fetching transactions:', error.message);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

module.exports = router;
