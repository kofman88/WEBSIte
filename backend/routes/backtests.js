const express = require('express');
const { authMiddleware, requireTier } = require('../middleware/auth');
const backtestService = require('../services/backtestService');

const router = express.Router();

/**
 * GET /api/backtests
 * List all backtests for the authenticated user.
 */
router.get('/', authMiddleware, (req, res) => {
  try {
    const backtests = backtestService.getUserBacktests(req.userId);
    res.json({ backtests });
  } catch (error) {
    console.error('Error fetching backtests:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/backtests/stats
 * Aggregated backtest statistics.
 */
router.get('/stats', authMiddleware, (req, res) => {
  try {
    const stats = backtestService.getUserBacktestsStats(req.userId);
    res.json({ stats });
  } catch (error) {
    console.error('Error fetching backtest stats:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/backtests
 * Create a new backtest. Requires Pro tier or above.
 * Body: { name, symbol, exchangeName, timeframe, startDate, endDate, initialCapital, strategyConfig? }
 */
router.post('/', authMiddleware, (req, res) => {
  try {
    const backtestData = req.body;

    if (
      !backtestData.name ||
      !backtestData.symbol ||
      !backtestData.exchangeName ||
      !backtestData.timeframe ||
      !backtestData.startDate ||
      !backtestData.endDate ||
      !backtestData.initialCapital
    ) {
      return res.status(400).json({
        error: 'name, symbol, exchangeName, timeframe, startDate, endDate, and initialCapital are required',
      });
    }

    if (backtestData.initialCapital <= 0) {
      return res.status(400).json({ error: 'initialCapital must be greater than 0' });
    }

    const backtest = backtestService.createBacktest(req.userId, backtestData);
    res.status(201).json({ message: 'Backtest created successfully', backtest });
  } catch (error) {
    console.error('Error creating backtest:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/backtests/:id
 * Get a specific backtest with results.
 */
router.get('/:id', authMiddleware, (req, res) => {
  try {
    const backtest = backtestService.getBacktestById(parseInt(req.params.id, 10), req.userId);
    if (!backtest) {
      return res.status(404).json({ error: 'Backtest not found' });
    }

    // Parse results JSON if present
    if (backtest.results && typeof backtest.results === 'string') {
      try {
        backtest.results = JSON.parse(backtest.results);
      } catch (_) {
        // Leave as string if parsing fails
      }
    }

    res.json({ backtest });
  } catch (error) {
    console.error('Error fetching backtest:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/backtests/:id
 * Delete a backtest.
 */
router.delete('/:id', authMiddleware, (req, res) => {
  try {
    const success = backtestService.deleteBacktest(parseInt(req.params.id, 10), req.userId);
    if (!success) {
      return res.status(404).json({ error: 'Backtest not found' });
    }
    res.json({ message: 'Backtest deleted successfully' });
  } catch (error) {
    console.error('Error deleting backtest:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
