const express = require('express');
const { z } = require('zod');
const tvWebhook = require('../services/tvWebhookService');
const exchangeService = require('../services/exchangeService');
const marketData = require('../services/marketDataService');
const logger = require('../utils/logger');

const router = express.Router();

// POST /api/webhooks/tradingview/:botId
//
// TradingView itself does not HMAC-sign alerts, so we accept two modes:
//   1. Legacy: `secret` field inside JSON payload equals bot.tv_webhook_secret
//   2. Preferred: header `X-CHM-Signature: sha256=<hex>` where hex =
//      HMAC-SHA256(raw_body, bot.tv_webhook_secret). An upstream relay
//      (Zapier / own script) can compute this and TV sends the raw payload.
//
// Mode 2 closes the replay risk of mode 1 where the secret is visible in
// logs / proxies. If the header is present, the body-field secret is ignored.
router.post('/tradingview/:botId', async (req, res) => {
  try {
    const botId = z.coerce.number().int().positive().parse(req.params.botId);
    const sigHeader = req.get('X-CHM-Signature') || '';
    const out = await tvWebhook.handleAlert(botId, req.body || {}, {
      exchangeService, marketData,
      signatureHeader: sigHeader,
      rawBody: JSON.stringify(req.body || {}),
    });
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
