const express = require('express');
const { z } = require('zod');
const { authMiddleware } = require('../middleware/auth');
const market = require('../services/strategyMarketService');

const router = express.Router();

function handleErr(err, res, next) {
  if (err instanceof z.ZodError) return res.status(400).json({ error: 'Validation failed', issues: err.issues });
  if (err && err.statusCode) return res.status(err.statusCode).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  return next(err);
}

// Public listing — browse without auth.
router.get('/', (req, res, next) => {
  try {
    const q = z.object({
      search: z.string().max(100).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);
    res.json({ strategies: market.list(q) });
  } catch (err) { handleErr(err, res, next); }
});

router.get('/:slug', (req, res, next) => {
  try {
    const slug = z.string().min(1).max(64).parse(req.params.slug);
    const s = market.get(slug);
    if (!s) return res.status(404).json({ error: 'Not found' });
    res.json(s);
  } catch (err) { handleErr(err, res, next); }
});

router.use(authMiddleware);

router.post('/', (req, res, next) => {
  try {
    const body = z.object({
      title: z.string().min(3).max(128),
      description: z.string().max(2000).optional().default(''),
      strategy: z.string().min(1).max(32),
      timeframe: z.string().min(1).max(8).default('1h'),
      direction: z.enum(['long', 'short', 'both']).default('both'),
      config: z.record(z.any()).optional().default({}),
      risk: z.record(z.any()).optional().default({}),
    }).parse(req.body);
    res.status(201).json(market.publish(req.userId, body));
  } catch (err) { handleErr(err, res, next); }
});

router.post('/:slug/install', (req, res, next) => {
  try {
    const slug = z.string().min(1).max(64).parse(req.params.slug);
    const body = z.object({
      name: z.string().max(64).optional(),
      symbols: z.array(z.string().trim().min(2).max(32)).min(1).max(20).default(['BTCUSDT']),
      tradingMode: z.enum(['paper', 'live']).default('paper'),
    }).parse(req.body || {});
    res.json(market.install(req.userId, slug, body));
  } catch (err) { handleErr(err, res, next); }
});

router.post('/:slug/rate', (req, res, next) => {
  try {
    const slug = z.string().min(1).max(64).parse(req.params.slug);
    const body = z.object({ stars: z.number().int().min(1).max(5) }).parse(req.body);
    res.json(market.rate(req.userId, slug, body.stars));
  } catch (err) { handleErr(err, res, next); }
});

router.delete('/:slug', (req, res, next) => {
  try {
    const slug = z.string().min(1).max(64).parse(req.params.slug);
    res.json(market.unpublish(req.userId, slug, { isAdmin: Boolean(req.isAdmin) }));
  } catch (err) { handleErr(err, res, next); }
});

module.exports = router;
