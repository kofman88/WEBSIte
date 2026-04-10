const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const exchangeService = require('../services/exchangeService');

const router = express.Router();

/**
 * GET /api/exchanges/exchanges
 * List supported exchanges. No auth required.
 */
router.get('/exchanges', (_req, res) => {
  try {
    const exchanges = exchangeService.getSupportedExchanges();
    res.json({ exchanges });
  } catch (error) {
    console.error('Error fetching exchanges:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/exchanges/exchanges/:name/pairs
 * Get available trading pairs for an exchange. No auth required.
 */
router.get('/exchanges/:name/pairs', async (req, res) => {
  try {
    const pairs = await exchangeService.getTradingPairs(req.params.name);
    res.json({ pairs });
  } catch (error) {
    console.error('Error fetching trading pairs:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/exchanges/exchanges/:name/price
 * Get the current price for a symbol. No auth required.
 * Query: ?symbol=BTC/USDT
 */
router.get('/exchanges/:name/price', async (req, res) => {
  try {
    const { symbol } = req.query;
    if (!symbol) {
      return res.status(400).json({ error: 'symbol query parameter is required' });
    }
    const priceData = await exchangeService.getPrice(req.params.name, symbol);
    res.json({ priceData });
  } catch (error) {
    console.error('Error fetching price:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/exchanges/balance/:exchangeName
 * Get user's balance on an exchange. Requires auth.
 */
router.get('/balance/:exchangeName', authMiddleware, async (req, res) => {
  try {
    const balance = await exchangeService.getBalance(req.userId, req.params.exchangeName);
    res.json({ balance });
  } catch (error) {
    console.error('Error fetching balance:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
