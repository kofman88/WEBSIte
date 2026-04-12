/**
 * telegramService.js — Telegram Notifications for CHM Finance
 *
 * Sends trading notifications to connected Telegram users.
 * Uses Telegram Bot API directly (no dependencies).
 *
 * Set BOT_TOKEN in environment or config.
 */

const https = require('https');
const db = require('../models/database');
const log = require('../utils/logger')('Telegram');

// Bot token — set via env or replace here
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8727144116:AAHNyp6gob88_UlZ-9mfKVecFqKxVRZL5J0';
const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || 'CHM_Finance_Bot';

/**
 * Send a message to a Telegram chat
 */
function sendMessage(chatId, text, parseMode = 'HTML') {
  if (!BOT_TOKEN || !chatId) return Promise.resolve(false);

  return new Promise((resolve) => {
    const payload = JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: true,
    });

    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(data);
          if (!r.ok) log.warn(`TG send failed to ${chatId}: ${r.description}`);
          resolve(r.ok);
        } catch { resolve(false); }
      });
    });
    req.on('error', (e) => { log.warn(`TG error: ${e.message}`); resolve(false); });
    req.write(payload);
    req.end();
  });
}

/**
 * Send signal notification to user
 */
async function notifySignal(userId, signal) {
  const tgId = _getUserTgId(userId);
  if (!tgId) return false;

  const dir = signal.direction?.toUpperCase() || 'LONG';
  const emoji = dir === 'LONG' ? '🟢' : '🔴';
  const text = [
    `${emoji} <b>${signal.symbol} ${dir}</b>`,
    `📊 Стратегия: <code>${signal.strategy}</code>`,
    `💰 Entry: <code>${signal.entry}</code>`,
    `🛑 SL: <code>${signal.sl}</code>`,
    `🎯 TP1: <code>${signal.tp1}</code>`,
    signal.tp2 ? `🎯 TP2: <code>${signal.tp2}</code>` : '',
    signal.confidence ? `📈 Conf: ${signal.confidence}%` : '',
    signal.quality ? `⭐ Quality: ${signal.quality}/10` : '',
    `\n🔗 <a href="https://chmup.top/signals.html">Открыть на сайте</a>`,
  ].filter(Boolean).join('\n');

  return sendMessage(tgId, text);
}

/**
 * Send trade execution notification
 */
async function notifyTrade(userId, trade) {
  const tgId = _getUserTgId(userId);
  if (!tgId) return false;

  const isOpen = trade.action === 'open';
  const emoji = isOpen ? '⚡' : '✅';
  const text = isOpen
    ? `${emoji} <b>Сделка открыта</b>\n${trade.symbol} ${trade.direction?.toUpperCase()}\nEntry: <code>${trade.price}</code>\nSize: <code>$${trade.size}</code>`
    : `${emoji} <b>Сделка закрыта</b>\n${trade.symbol}\nPnL: <code>${trade.pnl >= 0 ? '+' : ''}$${trade.pnl?.toFixed(2)}</code>\nДлительность: ${trade.duration || '—'}`;

  return sendMessage(tgId, text);
}

/**
 * Send custom notification
 */
async function notify(userId, title, body) {
  const tgId = _getUserTgId(userId);
  if (!tgId) return false;
  return sendMessage(tgId, `<b>${title}</b>\n${body}`);
}

/**
 * Link Telegram user to web account (called from /start command handler)
 */
function linkTelegram(webUserId, telegramChatId) {
  try {
    db.prepare('UPDATE users SET telegram_id = ? WHERE id = ?').run(String(telegramChatId), webUserId);
    log.info(`Linked user ${webUserId} to Telegram ${telegramChatId}`);
    sendMessage(telegramChatId, '✅ <b>Telegram подключён к CHM Finance!</b>\n\nТеперь вы будете получать уведомления о сигналах и сделках.\n\n🔗 <a href="https://chmup.top/dashboard.html">Открыть дашборд</a>');
    return true;
  } catch (e) {
    log.error(`Link failed: ${e.message}`);
    return false;
  }
}

/**
 * Get bot info for connect link
 */
function getBotUsername() {
  return BOT_USERNAME;
}

function _getUserTgId(userId) {
  try {
    const user = db.prepare('SELECT telegram_id FROM users WHERE id = ?').get(userId);
    return user?.telegram_id || null;
  } catch { return null; }
}

module.exports = { sendMessage, notifySignal, notifyTrade, notify, linkTelegram, getBotUsername };
