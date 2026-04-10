const express = require('express');
const { authMiddleware, requireTier } = require('../middleware/auth');
const botService = require('../services/botService');
const subscriptionService = require('../services/subscriptionService');

const router = express.Router();

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
 * Body: { name, exchangeName, symbol, strategyType, leverage?, positionSizeUsd,
 *          stopLossPct?, takeProfitPct?, trailingStop? }
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
 * Get a specific bot.
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
