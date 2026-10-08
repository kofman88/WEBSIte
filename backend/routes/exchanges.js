const express = require('express');
const { z } = require('zod');
const { authMiddleware, exchangeKeyLimiter, requireVerifiedEmail } = require('../middleware/auth');
const exchangeService = require('../services/exchangeService');
const validation = require('../utils/validation');
const handleErr = require('../middleware/handleErr');

const router = express.Router();

// ── Public: list of supported exchanges ─────────────────────────────────
router.get('/', (_req, res) => {
  res.json({ exchanges: exchangeService.listSupported() });
});

// Public symbols / ticker / candles endpoints (CCXT-backed) were removed in
// M0 together with the per-bot UI. Market data returns in M8 as the BingX
// layer under services/marketData/*, exposed through /api/app/*.

// ── Authed: list my keys ────────────────────────────────────────────────
router.get('/keys', authMiddleware, (req, res, next) => {
  try {
    res.json({ keys: exchangeService.listKeys(req.userId) });
  } catch (err) { handleErr(err, res, next); }
});

// ── Authed: add a new key ───────────────────────────────────────────────
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

// ── Authed: re-verify a key (501 until the exchange adapters land, M13) ─
router.post('/keys/:id/verify', authMiddleware, exchangeKeyLimiter, async (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const out = await exchangeService.verifyKey(id, req.userId);
    res.json(out);
  } catch (err) { handleErr(err, res, next); }
});

// ── Authed: balance for a key (501 until the exchange adapters land, M13) ─
router.get('/keys/:id/balance', authMiddleware, async (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const bal = await exchangeService.getBalance(id, req.userId);
    res.json(bal);
  } catch (err) { handleErr(err, res, next); }
});

module.exports = router;
