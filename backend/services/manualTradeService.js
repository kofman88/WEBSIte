/**
 * Smart Trade / Manual Trade — одноразовая сделка без бота, с авто-SL/TP.
 *
 * Поведение:
 *   - paper-режим: просто пишем строку в trades со status='open', partialTpManager
 *     уже умеет закрывать их по SL/TP (проверяет поля stop_loss, take_profit_*)
 *   - live-режим: (заглушка) требует exchange_key_id и CCXT клиента; пока
 *     молча отклоняется с 503. Включим после прохождения testnet.
 */

const db = require('../models/database');
const logger = require('../utils/logger');

function create(userId, input) {
  const {
    exchangeKeyId, exchange, symbol, side,
    quantity, entryPrice, stopLoss, takeProfit1, takeProfit2, takeProfit3,
    leverage = 1, tradingMode = 'paper', note = null,
  } = input;

  if (!symbol || !side || !Number.isFinite(quantity) || quantity <= 0) {
    const err = new Error('symbol, side, quantity required'); err.statusCode = 400; throw err;
  }
  if (!['long', 'short'].includes(side)) {
    const err = new Error('side must be long|short'); err.statusCode = 400; throw err;
  }
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    const err = new Error('entryPrice required'); err.statusCode = 400; throw err;
  }
  if (!Number.isFinite(stopLoss) || stopLoss <= 0) {
    const err = new Error('stopLoss required — all manual trades must have a stop'); err.statusCode = 400; throw err;
  }
  if (side === 'long' && stopLoss >= entryPrice) {
    const err = new Error('Long SL must be below entry'); err.statusCode = 400; throw err;
  }
  if (side === 'short' && stopLoss <= entryPrice) {
    const err = new Error('Short SL must be above entry'); err.statusCode = 400; throw err;
  }

  if (tradingMode === 'live') {
    const err = new Error('Live manual trades require a testnet-validated exchange key. Coming in next update.');
    err.statusCode = 503; err.code = 'LIVE_MANUAL_NOT_ENABLED'; throw err;
  }

  let exchangeName = exchange;
  if (exchangeKeyId) {
    const k = db.prepare('SELECT exchange FROM exchange_keys WHERE id = ? AND user_id = ?').get(exchangeKeyId, userId);
    if (!k) { const err = new Error('Exchange key not found'); err.statusCode = 404; throw err; }
    exchangeName = k.exchange;
  }
  exchangeName = (exchangeName || 'bybit').toLowerCase();

  const info = db.prepare(`
    INSERT INTO trades
      (user_id, bot_id, signal_id, exchange, symbol, side, strategy, timeframe,
       entry_price, quantity, leverage, margin_used,
       stop_loss, take_profit_1, take_profit_2, take_profit_3,
       status, trading_mode, note)
    VALUES (?, NULL, NULL, ?, ?, ?, 'manual', NULL,
            ?, ?, ?, ?,
            ?, ?, ?, ?,
            'open', ?, ?)
  `).run(
    userId, exchangeName, symbol.toUpperCase(), side,
    entryPrice, quantity, leverage, (entryPrice * quantity) / Math.max(1, leverage),
    stopLoss, takeProfit1 || null, takeProfit2 || null, takeProfit3 || null,
    tradingMode, note,
  );

  db.prepare(`
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
    VALUES (?, 'trade.manual.open', 'trade', ?, ?)
  `).run(userId, info.lastInsertRowid, JSON.stringify({ symbol, side, qty: quantity, mode: tradingMode }));

  logger.info('manual trade created', { userId, tradeId: info.lastInsertRowid, symbol, side });

  try {
    const notifier = require('./notifier');
    notifier.dispatch(userId, {
      type: 'trade_opened',
      title: `📝 Manual · ${symbol.toUpperCase()} · ${side.toUpperCase()}`,
      body: `Ручная сделка открыта @ ${entryPrice}, SL ${stopLoss}${takeProfit1 ? ', TP1 ' + takeProfit1 : ''}`,
      link: '/analytics.html',
    });
  } catch (_e) {}

  return db.prepare('SELECT * FROM trades WHERE id = ?').get(info.lastInsertRowid);
}

module.exports = { create };
