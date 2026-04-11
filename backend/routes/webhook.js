/**
 * TradingView Webhook — принимает алерты и создаёт сигналы/сделки.
 *
 * URL: POST /api/webhook/tradingview
 *
 * TradingView Alert Message format:
 * {
 *   "secret": "user_webhook_key",
 *   "symbol": "BTCUSDT",
 *   "direction": "long",       // long | short | close
 *   "entry": 67450,            // optional
 *   "sl": 66800,               // optional
 *   "tp": 68900,               // optional
 *   "tp2": 69500,              // optional
 *   "message": "SMC OB bounce" // optional
 * }
 */

const express = require('express');
const crypto = require('crypto');
const db = require('../models/database');

const router = express.Router();

// Create webhook_keys table
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      key TEXT UNIQUE NOT NULL,
      name TEXT DEFAULT 'TradingView',
      is_active BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_used DATETIME,
      signals_count INTEGER DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_key ON webhook_keys(key);
  `);
} catch (_) {}

// POST /api/webhook/tradingview — receive alert (NO auth header, uses secret in body)
router.post('/tradingview', (req, res) => {
  try {
    const { secret, symbol, direction, entry, sl, tp, tp2, message, strategy, timeframe } = req.body;

    if (!secret) return res.status(401).json({ error: 'Missing secret' });
    if (!symbol || !direction) return res.status(400).json({ error: 'symbol and direction required' });

    // Find user by webhook key
    const hook = db.prepare(
      'SELECT * FROM webhook_keys WHERE key = ? AND is_active = 1'
    ).get(secret);

    if (!hook) return res.status(401).json({ error: 'Invalid webhook key' });

    const dir = direction.toLowerCase();
    if (!['long', 'short', 'close'].includes(dir)) {
      return res.status(400).json({ error: 'direction must be long, short, or close' });
    }

    // Handle close signal
    if (dir === 'close') {
      // Mark latest pending signal for this symbol as closed
      db.prepare(
        `UPDATE signal_history SET result = 'closed', closed_at = CURRENT_TIMESTAMP, notes = ?
         WHERE symbol = ? AND result = 'pending' ORDER BY created_at DESC LIMIT 1`
      ).run(message || 'Closed via TradingView', symbol.toUpperCase());

      // Update webhook stats
      db.prepare('UPDATE webhook_keys SET last_used = CURRENT_TIMESTAMP, signals_count = signals_count + 1 WHERE id = ?').run(hook.id);

      return res.json({ status: 'ok', action: 'close', symbol });
    }

    // Create signal
    const entryPrice = parseFloat(entry) || 0;
    const stopLoss = parseFloat(sl) || 0;
    const tp1 = parseFloat(tp) || 0;
    const tp2Price = parseFloat(tp2) || 0;

    // Calculate confidence based on available data
    let confidence = 70;
    if (entryPrice && stopLoss) confidence += 10;
    if (tp1) confidence += 5;
    if (tp2Price) confidence += 5;
    confidence = Math.min(confidence, 95);

    const signalId = db.prepare(
      `INSERT INTO signal_history (symbol, direction, entry_price, stop_loss, take_profit_1, take_profit_2, strategy, timeframe, confidence, result, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    ).run(
      symbol.toUpperCase(),
      dir,
      entryPrice,
      stopLoss,
      tp1,
      tp2Price,
      strategy || 'tradingview',
      timeframe || '',
      confidence,
      message || ''
    );

    // Update webhook stats
    db.prepare('UPDATE webhook_keys SET last_used = CURRENT_TIMESTAMP, signals_count = signals_count + 1 WHERE id = ?').run(hook.id);

    console.log(`[WEBHOOK] ${symbol} ${dir.toUpperCase()} from user ${hook.user_id} — ${message || ''}`);

    // Auto-execute trade if user has auto-trade enabled
    // (async, don't block webhook response)
    setImmediate(async () => {
      try {
        const userSettings = db.prepare(
          'SELECT * FROM trading_bots WHERE user_id = ? AND symbol = ? AND is_active = 1 LIMIT 1'
        ).get(hook.user_id, symbol.toUpperCase());

        if (userSettings) {
          const tradeExecutor = require('../services/tradeExecutor');
          await tradeExecutor.executeTrade(hook.user_id, {
            exchangeName: userSettings.exchange_name,
            symbol: symbol.toUpperCase(),
            direction: dir,
            leverage: userSettings.leverage || 10,
            positionSizeUsd: userSettings.position_size_usd || 100,
            stopLoss: stopLoss || null,
            takeProfit: tp1 || null,
          });
          console.log(`[WEBHOOK] Auto-trade executed: ${symbol} ${dir}`);
        }
      } catch (e) {
        console.log(`[WEBHOOK] Auto-trade skipped: ${e.message}`);
      }
    });

    res.json({
      status: 'ok',
      action: 'signal',
      signalId: signalId.lastInsertRowid,
      symbol: symbol.toUpperCase(),
      direction: dir,
      confidence,
    });
  } catch (error) {
    console.error('[WEBHOOK] Error:', error.message);
    res.status(500).json({ error: 'Webhook processing error' });
  }
});

// ── Authenticated endpoints for managing webhook keys ──

const { authMiddleware } = require('../middleware/auth');

// GET /api/webhook/keys — list user's webhook keys
router.get('/keys', authMiddleware, (req, res) => {
  const keys = db.prepare(
    'SELECT id, key, name, is_active, created_at, last_used, signals_count FROM webhook_keys WHERE user_id = ?'
  ).all(req.userId);
  res.json({ keys });
});

// POST /api/webhook/keys — create new webhook key
router.post('/keys', authMiddleware, (req, res) => {
  const { name } = req.body;
  const key = 'whk_' + crypto.randomBytes(16).toString('hex');

  db.prepare(
    'INSERT INTO webhook_keys (user_id, key, name) VALUES (?, ?, ?)'
  ).run(req.userId, key, name || 'TradingView');

  res.json({
    key,
    name: name || 'TradingView',
    webhookUrl: 'https://chmup.top/api/webhook/tradingview',
    examplePayload: {
      secret: key,
      symbol: '{{ticker}}',
      direction: 'long',
      entry: '{{close}}',
      sl: '{{plot("SL")}}',
      tp: '{{plot("TP")}}',
      message: '{{strategy.order.comment}}',
    },
  });
});

// DELETE /api/webhook/keys/:id — delete webhook key
router.delete('/keys/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM webhook_keys WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  res.json({ deleted: true });
});

module.exports = router;
