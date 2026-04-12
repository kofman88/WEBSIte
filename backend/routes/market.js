/**
 * Market Routes — regime detection, signal filters, trading config
 */
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const marketRegime = require('../services/marketRegime');
const signalFilter = require('../services/signalFilter');
const tradingDefaults = require('../config/tradingDefaults');
const momentum = require('../services/momentumDetector');
const { calculateTrailingSL } = require('../services/trailingStop');
const { calculatePartialTP } = require('../services/partialTP');
const optimizer = require('../services/optimizer');

// GET /api/market/regime — current market regime
router.get('/regime', auth, async (req, res) => {
  try {
    const regime = await marketRegime.getRegime();
    res.json({ regime });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/market/config — trading defaults for frontend
router.get('/config', auth, (req, res) => {
  res.json({
    defaults: {
      timeframe: tradingDefaults.D_TIMEFRAME,
      pivot: tradingDefaults.D_PIVOT,
      minRR: tradingDefaults.D_MIN_RR,
      minQuality: tradingDefaults.D_MIN_QUALITY,
      maxRisk: tradingDefaults.D_MAX_RISK,
      emaFast: tradingDefaults.D_EMA_FAST,
      emaSlow: tradingDefaults.D_EMA_SLOW,
      rsiOB: tradingDefaults.D_RSI_OB,
      rsiOS: tradingDefaults.D_RSI_OS,
    },
    strategies: {
      levels: { ...tradingDefaults.SMC ? {} : {}, tp1R: tradingDefaults.D_TP1, tp2R: tradingDefaults.D_TP2, tp3R: tradingDefaults.D_TP3 },
      smc: tradingDefaults.SMC,
      gerchik: tradingDefaults.GERCHIK,
      scalping: tradingDefaults.SCALPING,
    },
    filters: tradingDefaults.FILTERS,
    momentum: tradingDefaults.MOMENTUM,
    partialTP: tradingDefaults.PARTIAL_TP,
    trailing: tradingDefaults.TRAILING,
    coins: tradingDefaults.COINS,
    exchange: tradingDefaults.EXCHANGE,
  });
});

// POST /api/market/filter — test if a signal passes filters
router.post('/filter', auth, async (req, res) => {
  try {
    const signal = req.body;
    // Sync filters first
    const syncResult = signalFilter.filterSignal(signal);
    if (!syncResult.pass) {
      return res.json({ pass: false, reason: syncResult.reason, stage: 'sync' });
    }
    // Async filters (funding, spread, BTC)
    const asyncResult = await signalFilter.filterSignalAsync(signal);
    res.json({ pass: asyncResult.pass, reason: asyncResult.reason, stage: asyncResult.pass ? 'passed' : 'async' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/market/funding/:symbol — funding rate for a symbol
router.get('/funding/:symbol', auth, async (req, res) => {
  try {
    const rate = await signalFilter.getFundingRate(req.params.symbol.toUpperCase());
    res.json({ symbol: req.params.symbol.toUpperCase(), fundingRate: rate, pct: rate !== null ? +(rate * 100).toFixed(4) : null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/market/btc-trend — BTC trend direction
router.get('/btc-trend', auth, async (req, res) => {
  try {
    const trend = await signalFilter.getBTCTrend();
    res.json({ trend });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/market/momentum — momentum detector status
router.get('/momentum', auth, (req, res) => {
  res.json(momentum.getStatus());
});

// POST /api/market/trailing — calculate trailing SL for position
router.post('/trailing', auth, (req, res) => {
  try {
    const result = calculateTrailingSL(req.body);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/market/partial-tp — calculate partial TP levels
router.post('/partial-tp', auth, (req, res) => {
  try {
    const result = calculatePartialTP(req.body);
    res.json(result || { enabled: false });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// GET /api/market/optimize/:strategy — get optimized params
router.get('/optimize/:strategy', auth, async (req, res) => {
  try {
    const result = await optimizer.getOptimized(req.params.strategy, req.user?.id);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/market/defaults/:strategy — get default params
router.get('/defaults/:strategy', auth, (req, res) => {
  res.json({ params: optimizer.getDefaults(req.params.strategy) });
});

module.exports = router;
