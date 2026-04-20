/**
 * TradingView webhook — принимает alert из TV (настраивается в TradingView
 * → Create Alert → Notifications → Webhook URL), передаёт как сигнал
 * соответствующему боту.
 *
 * Пользователь в UI получает:
 *   - URL:     https://chmup.top/api/webhooks/tradingview/<botId>
 *   - Secret:  автогенерируется, хранится в trading_bots.tv_webhook_secret
 *
 * Проверка аутентичности — HMAC-SHA256 over raw body. TradingView JSON-
 * plan alerts не умеют подписывать, поэтому шлём secret в body как поле
 * `secret`. Для премиум-юзеров с HMAC можно расширить позже.
 *
 * Ожидаемый payload (настраивается в TV):
 * {
 *   "secret":    "<bot-webhook-secret>",
 *   "symbol":    "BTCUSDT",
 *   "side":      "long"|"short",          // или "buy"|"sell"
 *   "price":     42500.5,
 *   "stopLoss":  42000,                    // опционально
 *   "tp1":       43000,                    // опционально
 *   "tp2":       43500,                    // опционально
 *   "confidence": 75,                      // опционально
 *   "note":      "RSI oversold + vol spike"
 * }
 */

const crypto = require('crypto');
const db = require('../models/database');
const logger = require('../utils/logger');

function generateSecret() {
  return 'tvwh_' + crypto.randomBytes(16).toString('base64url');
}

function rotateSecret(botId, userId) {
  const bot = db.prepare('SELECT id FROM trading_bots WHERE id = ? AND user_id = ?').get(botId, userId);
  if (!bot) { const e = new Error('Bot not found'); e.statusCode = 404; throw e; }
  const secret = generateSecret();
  db.prepare('UPDATE trading_bots SET tv_webhook_secret = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(secret, botId);
  return secret;
}

function getSecret(botId, userId) {
  const row = db.prepare('SELECT tv_webhook_secret FROM trading_bots WHERE id = ? AND user_id = ?').get(botId, userId);
  if (!row) { const e = new Error('Bot not found'); e.statusCode = 404; throw e; }
  return row.tv_webhook_secret || null;
}

function buildUrl(botId) {
  const origin = (process.env.APP_URL || 'https://chmup.top').replace(/\/$/, '');
  return origin + '/api/webhooks/tradingview/' + botId;
}

/**
 * Вызывается из routes/webhooks.js.
 * Проверяет secret + создаёт signal, маршрутизирует в autoTradeService.
 */
async function handleAlert(botId, payload, { exchangeService, marketData } = {}) {
  const bot = db.prepare('SELECT * FROM trading_bots WHERE id = ?').get(botId);
  if (!bot) { const e = new Error('Bot not found'); e.statusCode = 404; throw e; }
  if (!bot.tv_webhook_secret) { const e = new Error('Webhook not configured — rotate secret in bot settings'); e.statusCode = 400; throw e; }
  if (!payload || payload.secret !== bot.tv_webhook_secret) {
    const e = new Error('Invalid webhook secret'); e.statusCode = 401; e.code = 'INVALID_SIGNATURE'; throw e;
  }
  if (!bot.is_active) {
    logger.info('tv webhook ignored — bot inactive', { botId });
    return { accepted: false, reason: 'bot_inactive' };
  }

  // Normalize side
  let side = (payload.side || payload.action || '').toLowerCase();
  if (side === 'buy') side = 'long';
  if (side === 'sell') side = 'short';
  if (!['long', 'short'].includes(side)) {
    const e = new Error('side must be long|short|buy|sell'); e.statusCode = 400; throw e;
  }

  const price = Number(payload.price);
  if (!Number.isFinite(price) || price <= 0) {
    const e = new Error('valid `price` required'); e.statusCode = 400; throw e;
  }

  // Build signal shape compatible with autoTradeService
  const signal = {
    symbol: (payload.symbol || '').toUpperCase() || bot.symbol,
    side,
    strategy: 'tradingview',
    entry: price,
    stopLoss: Number(payload.stopLoss) || (side === 'long' ? price * 0.99 : price * 1.01),
    tp1: Number(payload.tp1) || null,
    tp2: Number(payload.tp2) || null,
    tp3: Number(payload.tp3) || null,
    confidence: Number(payload.confidence) || 60,
    reason: payload.note || 'TradingView webhook',
  };

  // Persist as signal row for the feed
  const signalInfo = db.prepare(`
    INSERT INTO signals
      (user_id, strategy, exchange, symbol, timeframe, side, entry_price, stop_loss,
       take_profit_1, take_profit_2, take_profit_3, confidence, reason,
       result, created_at)
    VALUES (?, 'tradingview', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)
  `).run(
    bot.user_id, bot.exchange || 'bybit', signal.symbol, bot.timeframe || '1h', side,
    signal.entry, signal.stopLoss, signal.tp1, signal.tp2, signal.tp3,
    signal.confidence, signal.reason,
  );
  signal.id = signalInfo.lastInsertRowid;

  db.prepare(`
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
    VALUES (?, 'tv_webhook.signal', 'signal', ?, ?)
  `).run(bot.user_id, signal.id, JSON.stringify({ botId, symbol: signal.symbol, side }));

  // If bot is set to auto-trade — route to autoTradeService
  if (bot.auto_trade && exchangeService) {
    try {
      const autoTrade = require('./autoTradeService');
      const trade = await autoTrade.executeSignal(signal, bot, { exchangeService, marketData });
      return { accepted: true, signalId: signal.id, tradeId: trade ? trade.id : null };
    } catch (err) {
      logger.warn('tv webhook auto-trade failed', { botId, err: err.message });
      return { accepted: true, signalId: signal.id, autoTradeError: err.message };
    }
  }

  // Otherwise — just a signal, notify user
  try {
    const notifier = require('./notifier');
    notifier.dispatch(bot.user_id, {
      type: 'signal',
      title: `📡 TV · ${signal.symbol} · ${side.toUpperCase()}`,
      body: `@ ${price}${signal.stopLoss ? ', SL ' + signal.stopLoss : ''}. ${signal.reason}`,
      link: '/signals.html',
    });
  } catch (_e) {}

  return { accepted: true, signalId: signal.id };
}

module.exports = { generateSecret, rotateSecret, getSecret, buildUrl, handleAlert };
