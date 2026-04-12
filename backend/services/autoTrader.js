/**
 * autoTrader.js — Auto-Trade Engine
 *
 * When scanner finds a signal, this service:
 * 1. Finds ALL active bots matching the signal's symbol
 * 2. Checks strategy match + direction filter
 * 3. Executes trade via tradeExecutor (if user has API keys)
 * 4. Records trade in bot_trades
 * 5. Updates bot stats
 * 6. Sends Telegram notification
 *
 * Called by scannerEngine after each signal is saved.
 */

const db = require('../models/database');
const tradeExecutor = require('./tradeExecutor');
const botService = require('./botService');
const log = require('../utils/logger')('AutoTrader');

let telegramService;
try { telegramService = require('./telegramService'); } catch (_) {}

/**
 * Process a new signal — find matching bots and execute trades
 * @param {object} signal — { symbol, strategy, direction, entry, sl, tp1, tp2, confidence, quality, timeframe }
 */
async function processSignal(signal) {
  try {
    // Find all active bots that match this symbol
    const matchingBots = db.prepare(`
      SELECT tb.*, u.id as userId
      FROM trading_bots tb
      JOIN users u ON tb.user_id = u.id
      WHERE tb.is_active = 1
        AND tb.symbol = ?
        AND tb.strategy_type = ?
    `).all(signal.symbol, signal.strategy);

    if (!matchingBots.length) return;

    log.info(`Signal ${signal.symbol} ${signal.direction} ${signal.strategy} — ${matchingBots.length} matching bot(s)`);

    for (const bot of matchingBots) {
      try {
        await executeForBot(bot, signal);
      } catch (e) {
        log.error(`Bot ${bot.id} (${bot.name}): ${e.message}`);
      }
    }
  } catch (e) {
    log.error(`processSignal error: ${e.message}`);
  }
}

/**
 * Execute a trade for a specific bot
 */
async function executeForBot(bot, signal) {
  const dir = signal.direction?.toLowerCase();
  const botDir = (bot.direction || 'both').toLowerCase();

  // Direction filter
  if (botDir !== 'both' && botDir !== dir) {
    log.debug(`Bot ${bot.id}: direction mismatch (bot=${botDir}, signal=${dir})`);
    return;
  }

  // Check if bot already has an open trade for this symbol
  const openTrade = db.prepare(`
    SELECT id FROM bot_trades WHERE bot_id = ? AND status = 'open' LIMIT 1
  `).get(bot.id);

  if (openTrade) {
    log.debug(`Bot ${bot.id}: already has open trade, skipping`);
    return;
  }

  // Record the signal match for this bot
  try {
    botService.recordBotSignal(bot.id, signal);
  } catch (_) {}

  // Check if user has API keys for this exchange
  const keys = db.prepare(`
    SELECT api_key, api_secret_encrypted FROM exchange_keys
    WHERE user_id = ? AND exchange_name = ?
  `).get(bot.user_id, bot.exchange_name);

  if (!keys) {
    // No API keys — record signal match but don't trade
    log.debug(`Bot ${bot.id}: no API keys for ${bot.exchange_name} — signal recorded, no trade`);

    // Still record as a "virtual" trade for tracking
    _recordVirtualTrade(bot, signal);
    return;
  }

  // Execute real trade
  try {
    const result = await tradeExecutor.executeTrade(bot.user_id, {
      exchangeName: bot.exchange_name,
      symbol: bot.symbol,
      direction: dir,
      leverage: bot.leverage || 10,
      positionSizeUsd: bot.position_size_usd || 100,
      stopLoss: signal.sl,
      takeProfit: signal.tp1,
    });

    // Record trade
    db.prepare(`
      INSERT INTO bot_trades (bot_id, trade_type, entry_price, quantity, stop_loss, take_profit,
        strategy, timeframe, status, opened_at, result)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', CURRENT_TIMESTAMP, '')
    `).run(bot.id, dir, signal.entry, result.quantity, signal.sl, signal.tp1,
      signal.strategy, signal.timeframe);

    // Update bot stats
    try { botService.updateBotStats(bot.id); } catch (_) {}

    log.info(`BOT ${bot.id} (${bot.name}): TRADE OPENED — ${dir.toUpperCase()} ${bot.symbol} @ ${signal.entry}`);

    // Telegram notification
    if (telegramService) {
      telegramService.notifyTrade(bot.user_id, {
        action: 'open',
        symbol: bot.symbol,
        direction: dir,
        price: signal.entry,
        size: bot.position_size_usd,
        botName: bot.name,
      }).catch(() => {});
    }
  } catch (e) {
    log.error(`Bot ${bot.id} trade execution failed: ${e.message}`);

    // Record failed trade attempt
    db.prepare(`
      INSERT INTO bot_trades (bot_id, trade_type, entry_price, stop_loss, take_profit,
        strategy, timeframe, status, opened_at, result)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'failed', CURRENT_TIMESTAMP, ?)
    `).run(bot.id, dir, signal.entry, signal.sl, signal.tp1,
      signal.strategy, signal.timeframe, e.message);
  }
}

/**
 * Record a virtual trade (when no API keys — for PnL tracking without real execution)
 */
function _recordVirtualTrade(bot, signal) {
  try {
    const dir = signal.direction?.toLowerCase();
    db.prepare(`
      INSERT INTO bot_trades (bot_id, trade_type, entry_price, stop_loss, take_profit,
        strategy, timeframe, status, opened_at, result)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'virtual', CURRENT_TIMESTAMP, 'no_keys')
    `).run(bot.id, dir, signal.entry, signal.sl, signal.tp1,
      signal.strategy, signal.timeframe);

    try { botService.updateBotStats(bot.id); } catch (_) {}
  } catch (_) {}
}

/**
 * Find all bots that match a symbol (any strategy)
 */
function getMatchingBots(symbol) {
  return db.prepare(`
    SELECT tb.*, u.email
    FROM trading_bots tb
    JOIN users u ON tb.user_id = u.id
    WHERE tb.is_active = 1 AND tb.symbol = ?
  `).all(symbol);
}

module.exports = { processSignal, executeForBot, getMatchingBots };
