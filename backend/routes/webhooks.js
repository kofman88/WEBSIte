const express = require('express');
const { z } = require('zod');
const tvWebhook = require('../services/tvWebhookService');
const exchangeService = require('../services/exchangeService');
const marketData = require('../services/marketDataService');
const logger = require('../utils/logger');

const router = express.Router();

// POST /api/webhooks/tradingview/:botId
router.post('/tradingview/:botId', async (req, res) => {
  try {
    const botId = z.coerce.number().int().positive().parse(req.params.botId);
    const out = await tvWebhook.handleAlert(botId, req.body || {}, { exchangeService, marketData });
    res.json(out);
  } catch (err) {
    if (err && err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    }
    logger.error('tv webhook error', { err: err && err.message });
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
