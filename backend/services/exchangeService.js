const ccxt = require('ccxt');
const db = require('../models/database');

class ExchangeService {
  // Получение API ключей пользователя для биржи
  getUserExchangeKeys(userId, exchangeName) {
    const keys = db.prepare(`
      SELECT * FROM exchange_keys 
      WHERE user_id = ? AND exchange_name = ?
    `).get(userId, exchangeName);
    
    if (!keys) {
      return null;
    }
    
    // Здесь должна быть дешифровка api_secret_encrypted
    // Для простоты пока возвращаем как есть
    return {
      apiKey: keys.api_key,
      apiSecret: keys.api_secret_encrypted,
      isTestnet: keys.is_testnet,
    };
  }

  // Создание экземпляра биржи
  async createExchangeInstance(exchangeName, apiKey, apiSecret, isTestnet = false) {
    if (!ccxt[exchangeName]) {
      throw new Error(`Биржа ${exchangeName} не поддерживается`);
    }

    const exchangeConfig = {
      apiKey,
      secret: apiSecret,
      options: {
        defaultType: 'future', // Торгуем фьючерсами по умолчанию
      },
    };

    if (isTestnet) {
      exchangeConfig.sandbox = true;
    }

    const exchange = new ccxt[exchangeName](exchangeConfig);
    
    // Загружаем рынки
    await exchange.loadMarkets();
    
    return exchange;
  }

  // Получение баланса пользователя на бирже
  async getBalance(userId, exchangeName) {
    const keys = this.getUserExchangeKeys(userId, exchangeName);
    if (!keys) {
      throw new Error('API ключи для этой биржи не найдены');
    }

    const exchange = await this.createExchangeInstance(
      exchangeName,
      keys.apiKey,
      keys.apiSecret,
      keys.isTestnet
    );

    const balance = await exchange.fetchBalance();
    
    return {
      total: balance.total,
      free: balance.free,
      used: balance.used,
    };
  }

  // Получение списка доступных бирж
  getSupportedExchanges() {
    return [
      { id: 'bybit', name: 'Bybit' },
      { id: 'bingx', name: 'BingX' },
      { id: 'binance', name: 'Binance' },
      { id: 'okx', name: 'OKX' },
    ];
  }

  // Получение торговых пар для биржи
  async getTradingPairs(exchangeName) {
    const exchange = new ccxt[exchangeName]();
    await exchange.loadMarkets();
    
    // Фильтруем только USDT фьючерсы
    const futuresPairs = Object.values(exchange.markets)
      .filter(m => m.future && m.settle === 'USDT')
      .map(m => ({
        symbol: m.symbol,
        base: m.base,
        quote: m.quote,
        active: m.active,
      }));
    
    return futuresPairs;
  }

  // Получение цены для символа
  async getPrice(exchangeName, symbol) {
    const exchange = new ccxt[exchangeName]();
    const ticker = await exchange.fetchTicker(symbol);
    return {
      symbol,
      price: ticker.last,
      change24h: ticker.percentage,
      volume24h: ticker.baseVolume,
    };
  }
}

module.exports = new ExchangeService();
