/**
 * Telegram Webhook Handler
 *
 * Receives updates from Telegram Bot API.
 * Handles /start command to link Telegram ↔ web account.
 *
 * Webhook URL: https://chmup.top/api/telegram/webhook
 */

const express = require('express');
const router = express.Router();
const db = require('../models/database');
const telegramService = require('../services/telegramService');
const log = require('../utils/logger')('TelegramWH');

// POST /api/telegram/webhook — receives Telegram updates
router.post('/webhook', (req, res) => {
  // Always respond 200 to Telegram (otherwise it retries)
  res.sendStatus(200);

  try {
    const update = req.body;
    if (!update) return;

    // Handle messages
    if (update.message) {
      handleMessage(update.message);
    }

    // Handle callback queries (inline buttons)
    if (update.callback_query) {
      handleCallback(update.callback_query);
    }
  } catch (e) {
    log.error('Webhook error:', e.message);
  }
});

// GET /api/telegram/setup — one-time webhook registration
router.get('/setup', (req, res) => {
  const webhookUrl = 'https://chmup.top/api/telegram/webhook';
  const token = telegramService._getToken();
  const https = require('https');
  const payload = JSON.stringify({
    url: webhookUrl,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });

  const r = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${token}/setWebhook`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
  }, (resp) => {
    let data = '';
    resp.on('data', c => data += c);
    resp.on('end', () => {
      try {
        const result = JSON.parse(data);
        log.info('Webhook setup:', result);
        res.json({ webhookUrl, result });
      } catch { res.json({ webhookUrl, raw: data }); }
    });
  });
  r.on('error', e => res.status(500).json({ error: e.message }));
  r.write(payload);
  r.end();
});

// GET /api/telegram/status — check webhook status
router.get('/status', (req, res) => {
  const token = telegramService._getToken();
  const https = require('https');
  https.get(`https://api.telegram.org/bot${token}/getWebhookInfo`, (resp) => {
    let data = '';
    resp.on('data', c => data += c);
    resp.on('end', () => {
      try { res.json(JSON.parse(data)); } catch { res.json({ raw: data }); }
    });
  }).on('error', e => res.status(500).json({ error: e.message }));
});

// ── Message handler ──────────────────────────────────────────

function handleMessage(msg) {
  const chatId = msg.chat?.id;
  const text = (msg.text || '').trim();
  const firstName = msg.from?.first_name || 'User';

  if (!chatId) return;

  // /start web_XXXXXXXX — link to web account
  if (text.startsWith('/start web_')) {
    const encoded = text.replace('/start web_', '');
    try {
      const userId = parseInt(atob(encoded), 10);
      if (!userId || isNaN(userId)) {
        telegramService.sendMessage(chatId, '❌ Неверная ссылка. Попробуйте ещё раз из настроек сайта.');
        return;
      }

      // Check user exists
      const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(userId);
      if (!user) {
        telegramService.sendMessage(chatId, '❌ Пользователь не найден. Проверьте ссылку.');
        return;
      }

      // Check if already linked to another account
      const existing = db.prepare('SELECT id, email FROM users WHERE telegram_id = ?').get(String(chatId));
      if (existing && existing.id !== userId) {
        telegramService.sendMessage(chatId, `⚠️ Этот Telegram уже привязан к аккаунту ${existing.email}. Отключите его в настройках сайта.`);
        return;
      }

      // Link!
      telegramService.linkTelegram(userId, chatId);
      log.info(`Linked user ${userId} (${user.email}) → Telegram ${chatId}`);
    } catch (e) {
      log.error('Link error:', e.message);
      telegramService.sendMessage(chatId, '❌ Ошибка привязки. Попробуйте ещё раз.');
    }
    return;
  }

  // /start — just welcome
  if (text === '/start') {
    telegramService.sendMessage(chatId,
      `👋 Привет, <b>${escapeHtml(firstName)}</b>!\n\n` +
      `Это бот уведомлений <b>CHM Finance</b>.\n\n` +
      `📌 Чтобы получать уведомления о сигналах и сделках:\n` +
      `1. Зайдите на <a href="https://chmup.top/settings.html">chmup.top → Настройки</a>\n` +
      `2. Нажмите «Подключить Telegram»\n\n` +
      `После подключения вы будете получать:\n` +
      `🟢 Новые торговые сигналы\n` +
      `⚡ Открытие/закрытие сделок\n` +
      `📊 Ежедневную статистику\n\n` +
      `🔗 <a href="https://chmup.top">Открыть CHM Finance</a>`
    );
    return;
  }

  // /status — check connection
  if (text === '/status') {
    const user = db.prepare('SELECT id, email FROM users WHERE telegram_id = ?').get(String(chatId));
    if (user) {
      telegramService.sendMessage(chatId,
        `✅ <b>Telegram подключён</b>\n\n` +
        `Аккаунт: <code>${user.email}</code>\n` +
        `ID: <code>${user.id}</code>\n\n` +
        `🔗 <a href="https://chmup.top/dashboard.html">Открыть дашборд</a>`
      );
    } else {
      telegramService.sendMessage(chatId,
        `❌ <b>Telegram не подключён</b>\n\n` +
        `Подключите в <a href="https://chmup.top/settings.html">Настройках</a>`
      );
    }
    return;
  }

  // /help
  if (text === '/help') {
    telegramService.sendMessage(chatId,
      `📖 <b>Команды:</b>\n\n` +
      `/start — Начало\n` +
      `/status — Статус подключения\n` +
      `/help — Помощь\n\n` +
      `🔗 <a href="https://chmup.top">chmup.top</a>`
    );
    return;
  }

  // Unknown command
  telegramService.sendMessage(chatId, `Используйте /help для списка команд.\n\n🔗 <a href="https://chmup.top">Открыть CHM Finance</a>`);
}

function handleCallback(query) {
  // Future: inline button handlers
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Node.js atob polyfill
function atob(str) {
  return Buffer.from(str, 'base64').toString('utf-8');
}

module.exports = router;
