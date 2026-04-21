const express = require('express');
const { z } = require('zod');
const { authMiddleware, exchangeKeyLimiter, requireVerifiedEmail } = require('../middleware/auth');
const exchangeService = require('../services/exchangeService');
const marketData = require('../services/marketDataService');
const validation = require('../utils/validation');

const router = express.Router();

function handleErr(err, res, next) {
  if (err instanceof z.ZodError) {
    return res.status(400).json({
      error: 'Validation failed', code: 'VALIDATION_ERROR',
      issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  if (err && err.statusCode) {
    return res.status(err.statusCode).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
  return next(err);
}

// ── Public: list of supported exchanges ─────────────────────────────────
router.get('/', (_req, res) => {
  res.json({ exchanges: exchangeService.listSupported() });
});

// ── Public: trading symbols of an exchange ──────────────────────────────
router.get('/:exchange/symbols', async (req, res, next) => {
  try {
    const exchange = validation.exchange.parse(req.params.exchange);
    const symbols = await marketData.fetchSymbols(exchange);
    res.json({ exchange, count: symbols.length, symbols });
  } catch (err) { handleErr(err, res, next); }
});

// ── Public: 24h ticker ──────────────────────────────────────────────────
router.get('/:exchange/ticker/:symbol', async (req, res, next) => {
  try {
    const exchange = validation.exchange.parse(req.params.exchange);
    // Symbol may arrive URL-encoded with `/` — accept both BTC/USDT and BTCUSDT
    const raw = decodeURIComponent(req.params.symbol);
    const symbol = validation.symbol.parse(raw);
    const t = await marketData.fetchTicker(exchange, symbol);
    res.json(t);
  } catch (err) { handleErr(err, res, next); }
});

// ── Public: candles (OHLCV) ─────────────────────────────────────────────
router.get('/:exchange/candles/:symbol', async (req, res, next) => {
  try {
    const exchange = validation.exchange.parse(req.params.exchange);
    const raw = decodeURIComponent(req.params.symbol);
    const symbol = validation.symbol.parse(raw);
    const q = z.object({
      timeframe: validation.timeframe.default('1h'),
      since: z.coerce.number().int().nonnegative().optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(500),
    }).parse(req.query);
    const candles = await marketData.fetchCandles(exchange, symbol, q.timeframe, {
      since: q.since, limit: q.limit,
    });
    res.json({ exchange, symbol, timeframe: q.timeframe, count: candles.length, candles });
  } catch (err) { handleErr(err, res, next); }
});

// ── Authed: list my keys ────────────────────────────────────────────────
router.get('/keys', authMiddleware, (req, res, next) => {
  try {
    res.json({ keys: exchangeService.listKeys(req.userId) });
  } catch (err) { handleErr(err, res, next); }
});

// ── Authed: add a new key (verifies before save) ────────────────────────
router.post('/keys', authMiddleware, exchangeKeyLimiter, requireVerifiedEmail, async (req, res, next) => {
  try {
    const input = validation.addKeySchema.parse(req.body);
    const key = await exchangeService.addKey(req.userId, input);
    res.status(201).json(key);
  } catch (err) { handleErr(err, res, next); }
});

// ── Authed: delete a key ────────────────────────────────────────────────
router.delete('/keys/:id', authMiddleware, (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const out = exchangeService.deleteKey(id, req.userId);
    res.json(out);
  } catch (err) { handleErr(err, res, next); }
});

// ── Authed: re-verify a key ─────────────────────────────────────────────
router.post('/keys/:id/verify', authMiddleware, exchangeKeyLimiter, async (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const out = await exchangeService.verifyKey(id, req.userId);
    res.json(out);
  } catch (err) { handleErr(err, res, next); }
});

// ── Authed: balance for a key ───────────────────────────────────────────
router.get('/keys/:id/balance', authMiddleware, async (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const bal = await exchangeService.getBalance(id, req.userId);
    res.json(bal);
  } catch (err) { handleErr(err, res, next); }
});

module.exports = router;
