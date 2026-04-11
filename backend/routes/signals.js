const express = require('express');
const { authMiddleware, requireTier } = require('../middleware/auth');
const signalService = require('../services/signalService');
const subscriptionService = require('../services/subscriptionService');

const router = express.Router();

// ── Public / Metadata ────────────────────────────────────────────────────

/**
 * GET /api/signals/strategies
 * Return available strategies and timeframes.
 */
router.get('/strategies', (_req, res) => {
  res.json({
    strategies: signalService.getStrategies(),
    timeframes: signalService.getTimeframes(),
  });
});

// ── Authenticated ────────────────────────────────────────────────────────

/**
 * GET /api/signals
 * Fetch paginated, filtered signals.
 * Query params: page, limit, strategy, symbol, direction, minConfidence, status
 */
router.get('/', authMiddleware, (req, res) => {
  try {
    // Check signal view quota for free-tier users
    const canView = subscriptionService.canViewSignal(req.userId);
    if (!canView) {
      return res.status(403).json({
        error: 'Daily signal limit reached. Upgrade your plan for unlimited signals.',
        code: 'SIGNAL_LIMIT_REACHED',
      });
    }

    const result = signalService.getFilteredSignalsForUser(req.userId, {
      page: req.query.page,
      limit: req.query.limit,
      strategy: req.query.strategy,
      symbol: req.query.symbol,
      direction: req.query.direction,
      minConfidence: req.query.minConfidence,
      status: req.query.status,
    });

    // Record signal views for free-tier tracking
    if (result.signals.length > 0) {
      try {
        subscriptionService.recordSignalView(req.userId, result.signals[0].id);
      } catch (_) {
        // Non-critical: don't fail the request if tracking fails
      }
    }

    res.json(result);
  } catch (error) {
    console.error('Error fetching signals:', error.message);
    res.status(500).json({ error: 'Failed to fetch signals' });
  }
});

/**
 * GET /api/signals/live
 * Server-Sent Events endpoint for real-time signal updates.
 * The client opens a long-lived connection; we push new signals as they arrive.
 */
router.get('/live', authMiddleware, (req, res) => {
  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable nginx buffering
  });

  res.write('event: connected\ndata: {"status":"connected"}\n\n');

  let lastId = parseInt(req.query.lastId, 10) || 0;

  // Poll every 3 seconds for new signals (lightweight with SQLite)
  const interval = setInterval(() => {
    try {
      const newSignals = signalService.getSignalsSince(lastId);
      for (const signal of newSignals) {
        res.write(`event: signal\ndata: ${JSON.stringify(signal)}\n\n`);
        lastId = signal.id;
      }
    } catch (err) {
      console.error('SSE poll error:', err.message);
    }
  }, 3000);

  // Send heartbeat every 30s to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30000);

  // Clean up on disconnect
  req.on('close', () => {
    clearInterval(interval);
    clearInterval(heartbeat);
  });
});

/**
 * GET /api/signals/stats
 * Aggregated signal performance stats.
 * Query params: strategy, days
 */
router.get('/stats', authMiddleware, (req, res) => {
  try {
    const stats = signalService.getStats({
      strategy: req.query.strategy,
      days: req.query.days,
    });
    res.json({ stats });
  } catch (error) {
    console.error('Error fetching signal stats:', error.message);
    res.status(500).json({ error: 'Failed to fetch signal stats' });
  }
});

/**
 * GET /api/signals/settings
 * Get the calling user's signal preferences.
 */
router.get('/settings', authMiddleware, (req, res) => {
  try {
    const config = signalService.getUserSignalConfig(req.userId);
    res.json({ settings: config });
  } catch (error) {
    console.error('Error fetching signal settings:', error.message);
    res.status(500).json({ error: 'Failed to fetch signal settings' });
  }
});

/**
 * POST /api/signals/settings
 * Update the calling user's signal preferences.
 * Body: { strategiesEnabled?, pairsFilter?, minConfidence?, notificationsEnabled? }
 */
router.post('/settings', authMiddleware, (req, res) => {
  try {
    const updated = signalService.updateUserSignalConfig(req.userId, req.body);
    res.json({
      message: 'Signal settings updated',
      settings: updated,
    });
  } catch (error) {
    console.error('Error updating signal settings:', error.message);
    res.status(400).json({ error: error.message });
  }
});

/**
 * GET /api/signals/:id
 * Get a single signal by ID.
 */
router.get('/:id', authMiddleware, (req, res) => {
  try {
    const signalId = parseInt(req.params.id, 10);
    if (isNaN(signalId)) {
      return res.status(400).json({ error: 'Invalid signal ID' });
    }

    const signal = signalService.getSignalById(signalId);
    if (!signal) {
      return res.status(404).json({ error: 'Signal not found' });
    }

    // Record view for quota tracking
    try {
      subscriptionService.recordSignalView(req.userId, signalId);
    } catch (_) {
      // Non-critical
    }

    res.json({ signal });
  } catch (error) {
    console.error('Error fetching signal:', error.message);
    res.status(500).json({ error: 'Failed to fetch signal' });
  }
});

// ── Admin-only: create / close signals ───────────────────────────────────
// In production these would be behind an admin middleware.
// For now we gate them behind the elite tier.

/**
 * POST /api/signals
 * Create a new signal (admin / system use).
 * Body: { symbol, direction, entryPrice, stopLoss, takeProfit1, takeProfit2, takeProfit3,
 *          strategy, timeframe, confidence, notes }
 */
router.post('/', authMiddleware, requireTier('elite'), (req, res) => {
  try {
    const signal = signalService.createSignal(req.body);
    res.status(201).json({ message: 'Signal created', signal });
  } catch (error) {
    console.error('Error creating signal:', error.message);
    res.status(400).json({ error: error.message });
  }
});

/**
 * PATCH /api/signals/:id/close
 * Close a signal with result.
 * Body: { result: 'win'|'loss'|'breakeven'|'cancelled', pnlPct? }
 */
router.patch('/:id/close', authMiddleware, requireTier('elite'), (req, res) => {
  try {
    const signalId = parseInt(req.params.id, 10);
    if (isNaN(signalId)) {
      return res.status(400).json({ error: 'Invalid signal ID' });
    }

    const { result, pnlPct } = req.body;
    if (!result) {
      return res.status(400).json({ error: 'result is required (win, loss, breakeven, cancelled)' });
    }

    const signal = signalService.closeSignal(signalId, { result, pnlPct });
    res.json({ message: 'Signal closed', signal });
  } catch (error) {
    console.error('Error closing signal:', error.message);
    res.status(400).json({ error: error.message });
  }
});

// GET /api/signals/candles — public candle data from OKX
router.get('/candles', async (req, res) => {
  try {
    const { symbol, timeframe, limit } = req.query;
    const { fetchCandles } = require('../services/scannerEngine');
    const candles = await fetchCandles(symbol || 'BTCUSDT', timeframe || '1H', parseInt(limit) || 200);
    res.json({ candles });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
