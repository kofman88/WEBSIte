const express = require('express');
const { authMiddleware, requireTier } = require('../middleware/auth');
const tradeExecutor = require('../services/tradeExecutor');

const router = express.Router();

// POST /api/trades/execute — execute trade from signal
router.post('/execute', authMiddleware, requireTier('pro'), async (req, res) => {
  try {
    const { exchangeName, symbol, direction, leverage, positionSizeUsd, stopLoss, takeProfit } = req.body;
    if (!exchangeName || !symbol || !direction) {
      return res.status(400).json({ error: 'exchangeName, symbol, direction required' });
    }
    const result = await tradeExecutor.executeTrade(req.userId, {
      exchangeName, symbol, direction,
      leverage: leverage || 10,
      riskPercent: 2,
      positionSizeUsd: positionSizeUsd || 100,
      stopLoss, takeProfit,
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET /api/trades/positions/:exchange — get open positions
router.get('/positions/:exchange', authMiddleware, async (req, res) => {
  try {
    const positions = await tradeExecutor.getPositions(req.userId, req.params.exchange);
    res.json({ positions });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/trades/close — close position
router.post('/close', authMiddleware, async (req, res) => {
  try {
    const { exchangeName, symbol } = req.body;
    if (!exchangeName || !symbol) return res.status(400).json({ error: 'exchangeName, symbol required' });
    const result = await tradeExecutor.closePosition(req.userId, exchangeName, symbol);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET /api/trades/balance/:exchange — get USDT balance
router.get('/balance/:exchange', authMiddleware, async (req, res) => {
  try {
    const balance = await tradeExecutor.getBalance(req.userId, req.params.exchange);
    res.json(balance);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
