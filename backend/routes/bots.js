const express = require('express');
const { authMiddleware, requireTier } = require('../middleware/auth');
const botService = require('../services/botService');
const subscriptionService = require('../services/subscriptionService');

const router = express.Router();

/**
 * GET /api/bots/templates
 * Public — returns pre-configured bot templates for each coin/exchange.
 */
router.get('/templates', (_req, res) => {
  const templates = [
    // Levels
    { id: 'btc-levels', coin: 'BTC', symbol: 'BTCUSDT', strategy: 'levels', name: 'Bitcoin Levels Bot', exchanges: ['bybit','binance','bingx','okx'], leverage: 5, risk: 2, stopLoss: 1.5, takeProfit: 3, winRate: 83, avgRR: 2.0 },
    { id: 'eth-levels', coin: 'ETH', symbol: 'ETHUSDT', strategy: 'levels', name: 'Ethereum Levels Bot', exchanges: ['bybit','binance','bingx','okx'], leverage: 5, risk: 2, stopLoss: 1.5, takeProfit: 3, winRate: 81, avgRR: 1.9 },
    { id: 'sol-levels', coin: 'SOL', symbol: 'SOLUSDT', strategy: 'levels', name: 'Solana Levels Bot', exchanges: ['bybit','binance','bingx','okx'], leverage: 5, risk: 2.5, stopLoss: 2, takeProfit: 4, winRate: 80, avgRR: 2.1 },
    // SMC
    { id: 'btc-smc', coin: 'BTC', symbol: 'BTCUSDT', strategy: 'smc', name: 'Bitcoin SMC Bot', exchanges: ['bybit','binance','bingx','okx'], leverage: 10, risk: 2, stopLoss: 1.5, takeProfit: 3, winRate: 87, avgRR: 2.4 },
    { id: 'eth-smc', coin: 'ETH', symbol: 'ETHUSDT', strategy: 'smc', name: 'Ethereum SMC Bot', exchanges: ['bybit','binance','bingx','okx'], leverage: 10, risk: 2, stopLoss: 1.5, takeProfit: 3, winRate: 85, avgRR: 2.2 },
    { id: 'sol-smc', coin: 'SOL', symbol: 'SOLUSDT', strategy: 'smc', name: 'Solana SMC Bot', exchanges: ['bybit','binance','bingx','okx'], leverage: 8, risk: 2.5, stopLoss: 2, takeProfit: 4, winRate: 81, avgRR: 2.5 },
    // Gerchik
    { id: 'btc-gerchik', coin: 'BTC', symbol: 'BTCUSDT', strategy: 'gerchik', name: 'Bitcoin Gerchik Bot', exchanges: ['bybit','binance','bingx','okx'], leverage: 5, risk: 1.5, stopLoss: 2, takeProfit: 4, winRate: 82, avgRR: 2.8 },
    // Scalping
    { id: 'btc-scalp', coin: 'BTC', symbol: 'BTCUSDT', strategy: 'scalping', name: 'Bitcoin Scalper', exchanges: ['bybit','binance','bingx','okx'], leverage: 20, risk: 1, stopLoss: 0.5, takeProfit: 1.5, winRate: 74, avgRR: 1.8 },
    { id: 'xrp-scalp', coin: 'XRP', symbol: 'XRPUSDT', strategy: 'scalping', name: 'XRP Scalper', exchanges: ['bybit','binance','bingx','okx'], leverage: 15, risk: 1.5, stopLoss: 0.8, takeProfit: 2, winRate: 78, avgRR: 2.1 },
    { id: 'doge-scalp', coin: 'DOGE', symbol: 'DOGEUSDT', strategy: 'scalping', name: 'DOGE Scalper', exchanges: ['bybit','binance','bingx','okx'], leverage: 15, risk: 2, stopLoss: 1, takeProfit: 2.5, winRate: 75, avgRR: 1.9 },
    { id: 'bnb-smc', coin: 'BNB', symbol: 'BNBUSDT', strategy: 'smc', name: 'BNB SMC Bot', exchanges: ['bybit','binance','bingx','okx'], leverage: 8, risk: 2, stopLoss: 1.5, takeProfit: 3, winRate: 83, avgRR: 2.3 },
  ];

  const { coin, exchange, strategy } = _req.query;
  let filtered = templates;
  if (coin) filtered = filtered.filter(t => t.coin === coin.toUpperCase());
  if (exchange) filtered = filtered.filter(t => t.exchanges.includes(exchange.toLowerCase()));
  if (strategy) filtered = filtered.filter(t => t.strategy === strategy.toLowerCase());

  res.json({ templates: filtered });
});

/**
 * POST /api/bots/from-template
 * Create a bot from a template ID.
 */
router.post('/from-template', authMiddleware, (req, res) => {
  try {
    const { templateId, exchangeName, positionSizeUsd } = req.body;
    if (!templateId || !exchangeName || !positionSizeUsd) {
      return res.status(400).json({ error: 'templateId, exchangeName, positionSizeUsd required' });
    }

    // Find template
    const tpl = [
      { id: 'btc-levels', symbol: 'BTCUSDT', strategy: 'levels', leverage: 5, stopLoss: 1.5, takeProfit: 3 },
      { id: 'eth-levels', symbol: 'ETHUSDT', strategy: 'levels', leverage: 5, stopLoss: 1.5, takeProfit: 3 },
      { id: 'sol-levels', symbol: 'SOLUSDT', strategy: 'levels', leverage: 5, stopLoss: 2, takeProfit: 4 },
      { id: 'btc-smc', symbol: 'BTCUSDT', strategy: 'smc', leverage: 10, stopLoss: 1.5, takeProfit: 3 },
      { id: 'eth-smc', symbol: 'ETHUSDT', strategy: 'smc', leverage: 10, stopLoss: 1.5, takeProfit: 3 },
      { id: 'sol-smc', symbol: 'SOLUSDT', strategy: 'smc', leverage: 8, stopLoss: 2, takeProfit: 4 },
      { id: 'btc-gerchik', symbol: 'BTCUSDT', strategy: 'gerchik', leverage: 5, stopLoss: 2, takeProfit: 4 },
      { id: 'btc-scalp', symbol: 'BTCUSDT', strategy: 'scalping', leverage: 20, stopLoss: 0.5, takeProfit: 1.5 },
      { id: 'xrp-scalp', symbol: 'XRPUSDT', strategy: 'scalping', leverage: 15, stopLoss: 0.8, takeProfit: 2 },
      { id: 'doge-scalp', symbol: 'DOGEUSDT', strategy: 'scalping', leverage: 15, stopLoss: 1, takeProfit: 2.5 },
      { id: 'bnb-smc', symbol: 'BNBUSDT', strategy: 'smc', leverage: 8, stopLoss: 1.5, takeProfit: 3 },
    ].find(t => t.id === templateId);

    if (!tpl) return res.status(404).json({ error: 'Template not found' });

    const canCreate = subscriptionService.canCreateBot(req.userId);
    if (!canCreate) return res.status(403).json({ error: 'Bot limit reached for your plan' });

    const bot = botService.createBot(req.userId, {
      name: `${tpl.symbol} ${tpl.strategy.toUpperCase()}`,
      exchangeName,
      symbol: tpl.symbol,
      strategyType: tpl.strategy,
      leverage: tpl.leverage,
      positionSizeUsd: +positionSizeUsd,
      stopLossPct: tpl.stopLoss,
      takeProfitPct: tpl.takeProfit,
    });

    res.status(201).json({ bot });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * GET /api/bots
 * List all bots for the authenticated user.
 */
router.get('/', authMiddleware, (req, res) => {
  try {
    const bots = botService.getUserBots(req.userId);
    res.json({ bots });
  } catch (error) {
    console.error('Error fetching bots:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/bots/stats
 * Aggregated stats across all user bots.
 */
router.get('/stats', authMiddleware, (req, res) => {
  try {
    const stats = botService.getUserBotsStats(req.userId);
    res.json({ stats });
  } catch (error) {
    console.error('Error fetching bot stats:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/bots
 * Create a new trading bot.
 * Any USDT pair is allowed — no coin quantity limitations.
 * Plan-based strategy restrictions still apply.
 */
router.post('/', authMiddleware, (req, res) => {
  try {
    // Check bot creation limit
    if (!subscriptionService.canCreateBot(req.userId)) {
      const limits = subscriptionService.getUserLimits(req.userId);
      return res.status(403).json({
        error: `Bot limit reached (max ${limits.maxBots}). Upgrade your plan to create more bots.`,
        code: 'BOT_LIMIT_REACHED',
      });
    }

    const botData = req.body;

    if (!botData.name || !botData.exchangeName || !botData.symbol || !botData.strategyType || !botData.positionSizeUsd) {
      return res.status(400).json({
        error: 'name, exchangeName, symbol, strategyType, and positionSizeUsd are required',
      });
    }

    // Symbol must end with USDT (any pair allowed)
    if (!botData.symbol.toUpperCase().endsWith('USDT')) {
      return res.status(400).json({
        error: 'Only USDT pairs are supported (e.g. BTCUSDT)',
        code: 'INVALID_SYMBOL',
      });
    }

    // Validate strategy against user's plan
    const limits = subscriptionService.getUserLimits(req.userId);
    if (!limits.strategies.includes(botData.strategyType)) {
      return res.status(403).json({
        error: `Strategy "${botData.strategyType}" is not available on your plan. Available: ${limits.strategies.join(', ')}`,
        code: 'STRATEGY_NOT_AVAILABLE',
      });
    }

    const bot = botService.createBot(req.userId, botData);
    res.status(201).json({ message: 'Bot created successfully', bot });
  } catch (error) {
    console.error('Error creating bot:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/bots/:id
 * Get a specific bot with enriched data.
 */
router.get('/:id', authMiddleware, (req, res) => {
  try {
    const bot = botService.getBotById(parseInt(req.params.id, 10), req.userId);
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }
    res.json({ bot });
  } catch (error) {
    console.error('Error fetching bot:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/bots/:id
 * Update a bot.
 */
router.put('/:id', authMiddleware, (req, res) => {
  try {
    const bot = botService.updateBot(parseInt(req.params.id, 10), req.userId, req.body);
    res.json({ message: 'Bot updated successfully', bot });
  } catch (error) {
    console.error('Error updating bot:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PATCH /api/bots/:id/toggle
 * Activate or deactivate a bot.
 * Body: { isActive: boolean }
 */
router.patch('/:id/toggle', authMiddleware, (req, res) => {
  try {
    const { isActive } = req.body;
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ error: 'isActive must be a boolean' });
    }

    // If activating and it needs auto-trade, check the plan
    if (isActive) {
      const limits = subscriptionService.getUserLimits(req.userId);
      if (!limits.autoTrade) {
        return res.status(403).json({
          error: 'Auto-trading is not available on your plan. Upgrade to Pro or higher.',
          code: 'AUTO_TRADE_NOT_AVAILABLE',
        });
      }
    }

    const bot = botService.toggleBot(parseInt(req.params.id, 10), req.userId, isActive);
    res.json({ message: `Bot ${isActive ? 'activated' : 'deactivated'}`, bot });
  } catch (error) {
    console.error('Error toggling bot:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/bots/:id/trades
 * Get trade history for a specific bot.
 */
router.get('/:id/trades', authMiddleware, (req, res) => {
  try {
    const trades = botService.getBotTrades(parseInt(req.params.id, 10), req.userId);
    res.json({ trades });
  } catch (error) {
    console.error('Error fetching trades:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/bots/:id/signals
 * Get signals matched to this bot's symbol + strategy.
 */
router.get('/:id/signals', authMiddleware, (req, res) => {
  try {
    const signals = botService.getBotSignals(parseInt(req.params.id, 10), req.userId);
    res.json({ signals });
  } catch (error) {
    console.error('Error fetching bot signals:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/bots/:id/performance
 * Detailed performance metrics: win rate, profit factor, avg trade duration,
 * max drawdown, sharpe estimate, best/worst trade, etc.
 */
router.get('/:id/performance', authMiddleware, (req, res) => {
  try {
    const perf = botService.getBotPerformance(parseInt(req.params.id, 10), req.userId);
    res.json({ performance: perf });
  } catch (error) {
    console.error('Error fetching bot performance:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/bots/:id
 * Delete a bot.
 */
router.delete('/:id', authMiddleware, (req, res) => {
  try {
    const success = botService.deleteBot(parseInt(req.params.id, 10), req.userId);
    if (!success) {
      return res.status(404).json({ error: 'Bot not found' });
    }
    res.json({ message: 'Bot deleted successfully' });
  } catch (error) {
    console.error('Error deleting bot:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
