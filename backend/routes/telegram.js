const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const telegramService = require('../services/telegramService');
const notifier = require('../services/notifier');
const logger = require('../utils/logger');

const router = express.Router();

// POST /api/telegram/webhook — Telegram posts updates here. Open endpoint
// (Telegram signs via setWebhook secret if you set secret_token, but MVP
// without — we don't expose anything dangerous here).
router.post('/webhook', (req, res) => {
  telegramService.handleUpdate(req.body)
    .then(() => res.json({ ok: true }))
    .catch((err) => { logger.warn('tg webhook error', { err: err.message }); res.json({ ok: true }); });
});

// Require auth for management endpoints
router.use(authMiddleware);

// POST /api/telegram/link — get a one-time link like t.me/<bot>?start=<token>
router.post('/link', (req, res) => {
  if (!telegramService.isConfigured()) {
    return res.status(503).json({ error: 'Telegram bot is not configured on this server', code: 'TG_NOT_CONFIGURED' });
  }
  const t = telegramService.createLinkToken(req.userId);
  res.json({ url: t.url, expiresAt: t.expiresAt, botUsername: telegramService.botUsername() });
});

// POST /api/telegram/unlink
router.post('/unlink', (req, res) => {
  telegramService.unlinkUser(req.userId);
  res.json({ unlinked: true });
});

// GET /api/telegram/status
router.get('/status', (req, res) => {
  const db = require('../models/database');
  const row = db.prepare('SELECT telegram_chat_id, telegram_username, telegram_linked_at FROM users WHERE id = ?').get(req.userId);
  res.json({
    linked: Boolean(row && row.telegram_chat_id),
    username: (row && row.telegram_username) || null,
    linkedAt: (row && row.telegram_linked_at) || null,
    botUsername: telegramService.botUsername(),
    configured: telegramService.isConfigured(),
  });
});

module.exports = router;
