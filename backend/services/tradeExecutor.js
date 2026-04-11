/**
 * Trade Executor — исполнение сделок через CCXT.
 * Автономный, работает без Telegram бота.
 */

const db = require('../models/database');

// CCXT loaded lazily
let ccxt = null;
function getCCXT() {
  if (!ccxt) ccxt = require('ccxt');
  return ccxt;
}

class TradeExecutor {
  /**
   * Create exchange instance with user's API keys.
   */
  createExchange(exchangeName, apiKey, apiSecret, passphrase) {
    const CCXT = getCCXT();
    const opts = {
      apiKey,
      secret: apiSecret,
      enableRateLimit: true,
      options: { defaultType: 'swap' },
    };
    if (passphrase) opts.password = passphrase; // OKX

    switch (exchangeName.toLowerCase()) {
      case 'bybit': return new CCXT.bybit(opts);
      case 'binance': return new CCXT.binance({ ...opts, options: { defaultType: 'future' } });
      case 'bingx': return new CCXT.bingx(opts);
      case 'okx': return new CCXT.okx(opts);
      default: throw new Error(`Unsupported exchange: ${exchangeName}`);
    }
  }

  /**
   * Execute a trade based on signal.
   */
  async executeTrade(userId, { exchangeName, symbol, direction, leverage, riskPercent, positionSizeUsd, stopLoss, takeProfit }) {
    // Get user's API keys
    const keys = db.prepare(
      'SELECT api_key, api_secret_encrypted FROM exchange_keys WHERE user_id = ? AND exchange_name = ?'
    ).get(userId, exchangeName);

    if (!keys) throw new Error(`No API keys for ${exchangeName}. Connect exchange first.`);

    const exchange = this.createExchange(exchangeName, keys.api_key, keys.api_secret_encrypted);

    // Set leverage
    try {
      await exchange.setLeverage(leverage, symbol);
    } catch (e) {
      console.log(`Leverage set warning: ${e.message}`);
    }

    // Calculate quantity
    const ticker = await exchange.fetchTicker(symbol);
    const price = ticker.last;
    const qty = positionSizeUsd * leverage / price;
    const side = direction === 'long' ? 'buy' : 'sell';

    // Place market order
    const order = await exchange.createOrder(symbol, 'market', side, qty);

    // Place stop-loss
    if (stopLoss) {
      const slSide = direction === 'long' ? 'sell' : 'buy';
      try {
        await exchange.createOrder(symbol, 'stop', slSide, qty, stopLoss, {
          stopPrice: stopLoss,
          reduceOnly: true,
        });
      } catch (e) {
        console.log(`SL placement warning: ${e.message}`);
      }
    }

    // Place take-profit
    if (takeProfit) {
      const tpSide = direction === 'long' ? 'sell' : 'buy';
      try {
        await exchange.createOrder(symbol, 'limit', tpSide, qty, takeProfit, {
          reduceOnly: true,
        });
      } catch (e) {
        console.log(`TP placement warning: ${e.message}`);
      }
    }

    // Record trade
    const botId = db.prepare(
      'SELECT id FROM trading_bots WHERE user_id = ? AND symbol = ? AND is_active = 1 LIMIT 1'
    ).get(userId, symbol)?.id || null;

    if (botId) {
      db.prepare(
        `INSERT INTO bot_trades (bot_id, trade_type, entry_price, quantity, opened_at, status)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, 'open')`
      ).run(botId, direction, price, qty);
    }

    return {
      orderId: order.id,
      symbol,
      side,
      price,
      quantity: qty,
      leverage,
      stopLoss,
      takeProfit,
    };
  }

  /**
   * Get user's open positions on exchange.
   */
  async getPositions(userId, exchangeName) {
    const keys = db.prepare(
      'SELECT api_key, api_secret_encrypted FROM exchange_keys WHERE user_id = ? AND exchange_name = ?'
    ).get(userId, exchangeName);
    if (!keys) return [];

    const exchange = this.createExchange(exchangeName, keys.api_key, keys.api_secret_encrypted);
    const positions = await exchange.fetchPositions();
    return positions.filter(p => Math.abs(p.contracts) > 0).map(p => ({
      symbol: p.symbol,
      side: p.side,
      contracts: p.contracts,
      entryPrice: p.entryPrice,
      unrealizedPnl: p.unrealizedPnl,
      leverage: p.leverage,
    }));
  }

  /**
   * Close a position.
   */
  async closePosition(userId, exchangeName, symbol) {
    const keys = db.prepare(
      'SELECT api_key, api_secret_encrypted FROM exchange_keys WHERE user_id = ? AND exchange_name = ?'
    ).get(userId, exchangeName);
    if (!keys) throw new Error('No API keys');

    const exchange = this.createExchange(exchangeName, keys.api_key, keys.api_secret_encrypted);
    const positions = await exchange.fetchPositions([symbol]);
    const pos = positions.find(p => Math.abs(p.contracts) > 0);
    if (!pos) throw new Error('No open position');

    const side = pos.side === 'long' ? 'sell' : 'buy';
    const order = await exchange.createOrder(symbol, 'market', side, Math.abs(pos.contracts), undefined, { reduceOnly: true });
    return { closed: true, orderId: order.id, pnl: pos.unrealizedPnl };
  }

  /**
   * Get account balance.
   */
  async getBalance(userId, exchangeName) {
    const keys = db.prepare(
      'SELECT api_key, api_secret_encrypted FROM exchange_keys WHERE user_id = ? AND exchange_name = ?'
    ).get(userId, exchangeName);
    if (!keys) throw new Error('No API keys');

    const exchange = this.createExchange(exchangeName, keys.api_key, keys.api_secret_encrypted);
    const balance = await exchange.fetchBalance();
    return {
      total: balance.total?.USDT || 0,
      free: balance.free?.USDT || 0,
      used: balance.used?.USDT || 0,
    };
  }
}

module.exports = new TradeExecutor();
