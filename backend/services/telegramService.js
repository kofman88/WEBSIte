/**
 * Telegram notifications service — direct HTTPS to Bot API, no deps.
 *
 * Setup:
 *   1. Create a bot via @BotFather, copy the token into TELEGRAM_BOT_TOKEN
 *   2. Set TELEGRAM_BOT_USERNAME (without @) so we can build t.me links
 *   3. Set APP_URL (https://chmup.top) and register webhook ONCE:
 *        curl https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://chmup.top/api/telegram/webhook
 *      (or call telegramService.setupWebhook() from a one-off script)
 *
 * Linking flow:
 *   - user clicks "Привязать Telegram" in settings
 *   - backend generates short-lived linking token (stored in system_kv)
 *   - returns t.me/<bot>?start=<token>
 *   - user clicks → Telegram opens bot with /start <token>
 *   - webhook receives update, matches token → stores chat_id on user
 *
 * Unlike nodemailer, this needs no extra npm package — just HTTPS.
 */

const https = require('https');
const crypto = require('crypto');
const db = require('../models/database');
const logger = require('../utils/logger');
const cryptoUtil = require('../utils/crypto');
const config = require('../config');

const LINK_TTL_SEC = 10 * 60; // 10 minutes
const KV_TG_TOKEN = 'tg_bot_token_enc';

let _cachedToken = null;

// Token resolution: prefer encrypted copy in system_kv (set via
// setBotToken from an admin console); fall back to env for self-hosted /
// dev. Caching once per process — call resetBotTokenCache() after rotate.
function botToken() {
  if (_cachedToken !== null) return _cachedToken;
  try {
    const row = db.prepare('SELECT value FROM system_kv WHERE key = ?').get(KV_TG_TOKEN);
    if (row && row.value) {
      _cachedToken = cryptoUtil.decrypt(row.value, config.walletEncryptionKey);
      return _cachedToken;
    }
  } catch (e) {
    logger.error('tg token decrypt failed', { err: e.message });
  }
  _cachedToken = process.env.TELEGRAM_BOT_TOKEN || '';
  return _cachedToken;
}
function setBotToken(token) {
  if (typeof token !== 'string' || token.length < 10) throw new Error('invalid bot token');
  const enc = cryptoUtil.encrypt(token, config.walletEncryptionKey);
  db.prepare(`INSERT INTO system_kv (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(KV_TG_TOKEN, enc);
  _cachedToken = token;
}
function resetBotTokenCache() { _cachedToken = null; }
function botUsername() { return process.env.TELEGRAM_BOT_USERNAME || ''; }
function isConfigured() { return Boolean(botToken() && botUsername()); }

function api(method, body) {
  return new Promise((resolve, reject) => {
    if (!botToken()) return reject(new Error('TELEGRAM_BOT_TOKEN not set'));
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: '/bot' + botToken() + '/' + method,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 5000,
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(chunks);
          if (!j.ok) return reject(new Error(j.description || 'Telegram API error'));
          resolve(j.result);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Telegram API timeout')); });
    req.write(data); req.end();
  });
}

// ── Linking ───────────────────────────────────────────────────────────
function createLinkToken(userId) {
  const token = crypto.randomBytes(8).toString('base64url'); // short enough for t.me query
  const expiresAt = Date.now() + LINK_TTL_SEC * 1000;
  db.prepare(`
    INSERT OR REPLACE INTO system_kv (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
  `).run('tglink:' + token, JSON.stringify({ userId, expiresAt }));
  const url = 'https://t.me/' + botUsername() + '?start=' + token;
  return { token, url, expiresAt };
}

function resolveLinkToken(token) {
  const row = db.prepare('SELECT value FROM system_kv WHERE key = ?').get('tglink:' + token);
  if (!row) return null;
  const { userId, expiresAt } = JSON.parse(row.value);
  if (Date.now() > expiresAt) { db.prepare('DELETE FROM system_kv WHERE key = ?').run('tglink:' + token); return null; }
  return userId;
}
function consumeLinkToken(token) { db.prepare('DELETE FROM system_kv WHERE key = ?').run('tglink:' + token); }

function linkUser(userId, chatId, username = null) {
  db.prepare(`
    UPDATE users SET telegram_chat_id = ?, telegram_username = ?, telegram_linked_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(String(chatId), username || null, userId);
  logger.info('telegram linked', { userId, chatId });
}

function unlinkUser(userId) {
  db.prepare(`
    UPDATE users SET telegram_chat_id = NULL, telegram_username = NULL, telegram_linked_at = NULL
    WHERE id = ?
  `).run(userId);
}

// ── Messaging ─────────────────────────────────────────────────────────
async function send(userId, text, opts = {}) {
  const row = db.prepare('SELECT telegram_chat_id FROM users WHERE id = ?').get(userId);
  if (!row || !row.telegram_chat_id) return { sent: false, reason: 'not_linked' };
  if (!isConfigured()) {
    logger.info('[telegram-dryrun]', { userId, text: text.slice(0, 200) });
    return { sent: false, reason: 'not_configured', dryRun: true };
  }
  try {
    const result = await api('sendMessage', {
      chat_id: row.telegram_chat_id, text,
      parse_mode: opts.parseMode || 'HTML', disable_web_page_preview: true,
    });
    return { sent: true, messageId: result.message_id };
  } catch (err) {
    logger.warn('telegram send failed', { userId, err: err.message });
    return { sent: false, error: err.message };
  }
}

// ── Webhook handler ───────────────────────────────────────────────────
// Telegram POSTs updates here. We care about /start <token> and /unlink.
async function handleUpdate(update) {
  const msg = update && update.message;
  if (!msg || !msg.text) return { handled: false };
  const chatId = msg.chat.id, username = msg.from && msg.from.username;
  const text = (msg.text || '').trim();

  if (text.startsWith('/start ')) {
    const token = text.slice(7).trim();
    const userId = resolveLinkToken(token);
    if (!userId) {
      await api('sendMessage', { chat_id: chatId, text: 'Ссылка просрочена или недействительна. Зайди в Settings → Уведомления и нажми «Привязать» ещё раз.' });
      return { handled: true, ok: false };
    }
    linkUser(userId, chatId, username);
    consumeLinkToken(token);
    await api('sendMessage', { chat_id: chatId, text: '✅ Telegram привязан к CHM Finance. Теперь сюда будут приходить уведомления о сделках и сигналах.' });
    return { handled: true, ok: true, userId };
  }

  if (text === '/unlink') {
    const row = db.prepare('SELECT id FROM users WHERE telegram_chat_id = ?').get(String(chatId));
    if (row) unlinkUser(row.id);
    await api('sendMessage', { chat_id: chatId, text: 'Отвязано. В настройках можно привязать снова.' });
    return { handled: true };
  }

  if (text === '/start' || text === '/help') {
    await api('sendMessage', { chat_id: chatId,
      text: 'CHM Finance — бот уведомлений. Привязать аккаунт: открой настройки на chmup.top и нажми «Привязать Telegram».',
    });
    return { handled: true };
  }

  return { handled: false };
}

async function setupWebhook() {
  const url = (process.env.APP_URL || 'https://chmup.top').replace(/\/$/, '') + '/api/telegram/webhook';
  return api('setWebhook', { url, allowed_updates: ['message'] });
}

module.exports = {
  isConfigured, botUsername,
  createLinkToken, resolveLinkToken, linkUser, unlinkUser,
  send, handleUpdate, setupWebhook,
  setBotToken, resetBotTokenCache,
};
